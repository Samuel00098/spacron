import { site } from '@/lib/config';

const footLinks = [
  { href: '/#features', label: 'Features' },
  { href: '/#compare', label: 'Compare' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#download', label: 'Download' },
  { href: '/changelog', label: 'Changelog' },
];

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-10 border-t border-[var(--glass-border)] bg-[rgba(7,8,11,0.50)] pb-7 pt-12" style={{ backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)' }}>
      <div className="container flex flex-wrap justify-between gap-8 border-b border-[var(--glass-border)] pb-7">
        <div>
          <a className="flex items-center gap-2.5 text-[1.05rem] font-bold" href="/">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" width={28} height={28} alt="" />
            <span>{site.name}</span>
          </a>
          <p className="mt-2.5 max-w-[38ch] text-[0.9rem] text-muted">{site.tagline}</p>
        </div>

        <nav className="flex flex-wrap items-start gap-[22px] text-[0.92rem] text-soft transition-colors" aria-label="Footer">
          {footLinks.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors duration-200 hover:text-ink">
              {l.label}
            </a>
          ))}
        </nav>
      </div>

      <div className="container mt-5 flex flex-wrap items-center justify-between gap-4 text-[0.82rem] text-muted">
        <span>
          &copy; {year} {site.name}. All rights reserved.
        </span>
        <nav className="flex flex-wrap gap-5" aria-label="Legal">
          <a href="/terms" className="transition-colors duration-200 hover:text-ink">
            Terms of Use
          </a>
          <a href="/privacy" className="transition-colors duration-200 hover:text-ink">
            Privacy Policy
          </a>
        </nav>
        <span className="mono">v{site.version}</span>
      </div>
    </footer>
  );
}
