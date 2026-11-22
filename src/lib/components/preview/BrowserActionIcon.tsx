export type BrowserActionIconName = 'inspect' | 'draw' | 'message' | 'styles' | 'code' | 'tag' | 'layout' | 'device' | 'type' | 'motion' | 'refactor' | 'copy' | 'close' | 'warning';
const paths: Record<BrowserActionIconName, string> = {
  inspect: 'M4 3l7 17 2-7 7-2L4 3z',
  draw: 'M16 3l5 5L8 21H3v-5L16 3zM13 6l5 5',
  message: 'M21 11a8 8 0 01-8 8H7l-4 3V5a2 2 0 012-2h8a8 8 0 018 8z',
  styles: 'M12 3a9 9 0 100 18h2a2 2 0 001-4 2 2 0 011-4h2a3 3 0 003-3 9 9 0 00-9-7zM7 9h.01M10 6h.01M15 6h.01',
  code: 'M8 5l-7 7 7 7M16 5l7 7-7 7M14 3l-4 18',
  tag: 'M3 3h8l10 10-8 8L3 11V3zM7 7h.01',
  layout: 'M3 3h18v18H3zM3 9h18M9 9v12',
  device: 'M6 2h12v20H6zM10 18h4',
  type: 'M4 5V3h16v2M12 3v18M8 21h8',
  motion: 'M13 2L4 14h7l-1 8 10-13h-7l0-7z',
  refactor: 'M14 6l4 4M3 21l12-12M15 3a6 6 0 006 6l-4 4-6-6 4-4z',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
  close: 'M6 6l12 12M6 18L18 6',
  warning: 'M12 3L2 21h20L12 3zM12 9v5M12 17h.01',
};
export default function BrowserActionIcon({ name }: { name: BrowserActionIconName }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
