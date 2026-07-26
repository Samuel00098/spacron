/**
 * Workspace-wide diagnostics (the Problems panel's data layer).
 *
 * Language servers already stream `textDocument/publishDiagnostics` for the
 * files the editor has open, but the editor consumed them privately as inline
 * lint markers — so a problem was only ever visible if you happened to be
 * looking at that file. This store collects them so they can be listed, counted
 * and jumped to.
 *
 * Two LSP semantics this must respect:
 *
 *  1. `publishDiagnostics` is AUTHORITATIVE per URI. Each notification replaces
 *     everything previously known about that file, and an empty array means
 *     "this file is now clean" — never append.
 *  2. Diagnostics belong to the server that produced them. When a server dies or
 *     its last file closes we drop its entries, otherwise the panel keeps
 *     reporting problems from a server that is no longer running.
 */
import { writable, derived } from '$lib/stores/storeCompat';
import { fileUriToPath, isInsideRoot } from '$lib/utils/paths';

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export type Diagnostic = {
  /** Filesystem path (forward-slash form), converted from the server's URI. */
  filePath: string;
  /** 1-based, ready for display and for the editor's jump-to-line. */
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  /** e.g. `ts`, `rust-analyzer`, `eslint`. */
  source: string | null;
  code: string | null;
};

/**
 * One file's diagnostics, tagged with the CLIENT that produced them.
 *
 * Keyed by client (`<root>::<serverLang>`) and not by root: a single project can
 * have several servers running at once (tsserver and rust-analyzer on the same
 * tree), so clearing "everything for this root" when one of them shuts down
 * would silently wipe the other's still-valid diagnostics.
 */
type FileEntry = {
  owner: string;
  diagnostics: Diagnostic[];
};

/** Keyed by filePath. */
export const diagnosticsByFile = writable<Map<string, FileEntry>>(new Map());

/** LSP severity numbers (1=Error … 4=Hint). Anything else is treated as info. */
const SEVERITY_BY_NUMBER: Record<number, DiagnosticSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

export function severityFromLsp(value: unknown): DiagnosticSeverity {
  return SEVERITY_BY_NUMBER[Number(value)] ?? 'info';
}

/** Raw shape of an LSP diagnostic, narrowed to the fields we surface. */
type LspDiagnostic = {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  message?: string;
  source?: string;
  code?: string | number;
};

/**
 * Normalise one server-supplied diagnostic.
 *
 * LSP positions are 0-based; everything user-facing here is 1-based.
 */
export function normalizeDiagnostic(filePath: string, raw: LspDiagnostic): Diagnostic {
  const start = raw.range?.start;
  return {
    filePath,
    line: (start?.line ?? 0) + 1,
    column: (start?.character ?? 0) + 1,
    severity: severityFromLsp(raw.severity),
    message: (raw.message ?? '').trim(),
    source: raw.source ?? null,
    code: raw.code === undefined || raw.code === null ? null : String(raw.code),
  };
}

/**
 * Apply a `publishDiagnostics` notification. Replaces the file's entry outright;
 * an empty list removes the file so it stops showing in the panel.
 */
export function publishDiagnostics(owner: string, uri: string, raw: LspDiagnostic[]): void {
  const filePath = fileUriToPath(uri);
  if (!filePath) return;

  diagnosticsByFile.update((current) => {
    const next = new Map(current);
    const items = (raw ?? [])
      .map((entry) => normalizeDiagnostic(filePath, entry))
      .filter((entry) => entry.message.length > 0);

    if (items.length === 0) next.delete(filePath);
    else next.set(filePath, { owner, diagnostics: items });

    return next;
  });
}

/** Drop everything produced by one client (its server closed / last file shut). */
export function clearDiagnosticsForOwner(owner: string): void {
  diagnosticsByFile.update((current) => {
    const next = new Map<string, FileEntry>();
    for (const [path, entry] of current) {
      if (entry.owner !== owner) next.set(path, entry);
    }
    return next;
  });
}

export function clearAllDiagnostics(): void {
  diagnosticsByFile.set(new Map());
}

export type SeverityCounts = { error: number; warning: number; info: number; hint: number };

export function emptyCounts(): SeverityCounts {
  return { error: 0, warning: 0, info: 0, hint: 0 };
}

export function countBySeverity(items: Diagnostic[]): SeverityCounts {
  const counts = emptyCounts();
  for (const item of items) counts[item.severity] += 1;
  return counts;
}

/**
 * Diagnostics for one project, grouped by file and ordered for display:
 * files alphabetically, then by line and column within a file.
 *
 * Filtered by path rather than by the producing root, so a file that is open
 * from a different project cannot appear in this project's list.
 */
export type FileGroup = { filePath: string; diagnostics: Diagnostic[]; counts: SeverityCounts };

export function groupForProject(
  byFile: Map<string, FileEntry>,
  projectRoot: string | null | undefined,
): FileGroup[] {
  if (!projectRoot) return [];
  const groups: FileGroup[] = [];

  for (const [filePath, entry] of byFile) {
    if (!isInsideRoot(filePath, projectRoot)) continue;
    const diagnostics = [...entry.diagnostics].sort(
      (a, b) => a.line - b.line || a.column - b.column,
    );
    groups.push({ filePath, diagnostics, counts: countBySeverity(diagnostics) });
  }

  return groups.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/** Total counts across every known file, for the dock badge. */
export const totalDiagnosticCounts = derived(diagnosticsByFile, ($byFile) => {
  const counts = emptyCounts();
  for (const entry of $byFile.values()) {
    for (const item of entry.diagnostics) counts[item.severity] += 1;
  }
  return counts;
});
