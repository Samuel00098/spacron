import { invoke } from '@tauri-apps/api/core';
import { writable } from '$lib/stores/storeCompat';

export type LinearScopeKind = 'team' | 'project';
export type LinearScope = { id: string; name: string };
export type LinearMapping = LinearScope & { kind: LinearScopeKind };
type LinearIdentity = { name: string };
export type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  state: { name: string };
  assignee: { name: string } | null;
};
export type LinearIssue = LinearIssueSummary & { description: string | null; url: string };
type LinearIssuePage = {
  nodes: LinearIssueSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export const linearAccountRevision = writable(0);
export const linearMappingRevision = writable(0);

export function getLinearMapping(projectId: string): LinearMapping | null {
  try {
    const saved = localStorage.getItem(`spacron.linear.scope.${projectId}`);
    if (!saved) return null;
    const mapping = JSON.parse(saved) as Partial<LinearMapping> | null;
    if (mapping && (mapping.kind === 'team' || mapping.kind === 'project')
      && typeof mapping.id === 'string' && typeof mapping.name === 'string') {
      return { kind: mapping.kind, id: mapping.id, name: mapping.name };
    }
  } catch {
    // Missing or invalid local settings can be configured again.
  }
  return null;
}

export function setLinearMapping(projectId: string, mapping: LinearMapping | null): void {
  const key = `spacron.linear.scope.${projectId}`;
  if (mapping) localStorage.setItem(key, JSON.stringify(mapping));
  else localStorage.removeItem(key);
  linearMappingRevision.update((revision) => revision + 1);
}

// The desktop owns the key and talks to Linear even when the git workspace is remote.
export const getLinearAccount = () => invoke<LinearIdentity | null>('linear_account');
export async function connectLinear(apiKey: string): Promise<LinearIdentity> {
  const identity = await invoke<LinearIdentity>('linear_connect', { apiKey });
  linearAccountRevision.update((revision) => revision + 1);
  return identity;
}

export async function disconnectLinear(): Promise<void> {
  await invoke('linear_disconnect');
  linearAccountRevision.update((revision) => revision + 1);
}

export const listLinearScopes = (kind: LinearScopeKind) =>
  invoke<LinearScope[]>('linear_scopes', { kind });

export const listLinearIssues = (mapping: LinearMapping, after: string | null = null) =>
  invoke<LinearIssuePage>('linear_issues', { kind: mapping.kind, scopeId: mapping.id, after });

export const getLinearIssue = (id: string) => invoke<LinearIssue>('linear_issue', { id });

export function linearIssueReference(issue: Pick<LinearIssue, 'identifier' | 'url'>): string {
  return `Linear issue ${issue.identifier}: ${issue.url}`;
}

export function linkedLinearIssueUrl(note: string | null): string | null {
  const match = note?.match(/^Linear issue [^:\r\n]+: (https:\/\/linear\.app\/\S+)/);
  return match?.[1] ?? null;
}

export function linearError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
