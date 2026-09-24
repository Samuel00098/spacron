/**
 * The pushpin used for pinned projects and threads.
 *
 * `mark` is the small "this is pinned" badge beside a name: tilted like a pin
 * pushed into a board, its head tinted, in the accent colour (see
 * `.pin-icon-mark` in ProjectHUD.css). The plain and `off` variants are the
 * upright line icons for the Pin / Unpin menu items.
 */
export default function PinIcon({
  size = 12,
  variant = 'plain',
  label,
  className,
}: {
  size?: number;
  variant?: 'plain' | 'mark' | 'off';
  /** Set for a standalone mark; omitted, the icon is decorative. */
  label?: string;
  className?: string;
}) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  const classes = ['pin-icon', variant === 'mark' ? 'pin-icon-mark' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={variant === 'mark' ? 2.1 : 1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...a11y}
    >
      {variant === 'off' ? (
        <>
          <path d="M12 17v5" />
          <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
          <path d="m2 2 20 20" />
          <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
        </>
      ) : (
        <>
          <path d="M12 17v5" />
          <path
            className="pin-icon-head"
            d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
          />
        </>
      )}
    </svg>
  );
}
