export default function SettingsDetailsToggle({ expanded, controls, onToggle }: {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`settings-dropdown-toggle-btn${expanded ? ' open' : ''}`}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      <span>{expanded ? 'Hide details' : 'Show details'}</span>
      <svg className={`settings-dropdown-chevron${expanded ? ' open' : ''}`} width="12" height="12"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}
