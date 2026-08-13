// Theme-aware status glyphs shared by the inbox and the notification cards —
// the replacement for the emoji (✅❌⚠️…) those surfaces used to render. Emoji
// are inconsistent across platforms, clash with the app's line-icon language,
// and can't take a status color. These draw with `currentColor`, so each caller
// sets the colour via CSS (e.g. `.inbox-row-glyph.ok { color: var(--success) }`)
// and light/dark parity is automatic.

export type StatusIconKind = 'done' | 'failed' | 'blocked' | 'report' | 'handoff' | 'ask';

function glyph(kind: StatusIconKind) {
  switch (kind) {
    case 'done':
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <polyline points="8 12 11 15 16 9" />
        </>
      );
    case 'failed':
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </>
      );
    case 'blocked':
      return (
        <>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </>
      );
    case 'report':
      return (
        <>
          <path d="m3 11 18-5v12L3 14v-3z" />
          <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
        </>
      );
    case 'handoff':
      return (
        <>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </>
      );
    case 'ask':
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </>
      );
  }
}

export default function StatusIcon({ kind, size = 13 }: { kind: StatusIconKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph(kind)}
    </svg>
  );
}
