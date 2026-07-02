'use client';

import { useEffect, useState } from 'react';
import { site } from '@/lib/config';

const links = [
  { href: '/#features', label: 'Features' },
  { href: '/#demo', label: 'Demo' },
  { href: '/#screenshots', label: 'Screenshots' },
  { href: '/#compare', label: 'Compare' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/changelog', label: 'Changelog' },
];

export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const mq = window.matchMedia('(min-width: 721px)');
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    const onScroll = () => setScrolled(window.scrollY > 20);

    document.addEventListener('keydown', onKey);
    mq.addEventListener('change', onChange);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    return () => {
      document.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onChange);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'border-b border-[var(--glass-border)] bg-[rgba(7,8,11,0.72)]'
          : ''
      }`}
      style={scrolled ? {
        backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
        WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
      } : {}}
    >
      <div className="container flex h-16 items-center justify-between gap-4">
        <a
          className="flex items-center gap-2.5 text-[1.1rem] font-bold tracking-[-0.01em]"
          href="/"
          aria-label={`${site.name} home`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" width={32} height={32} alt="" />
          <span>{site.name}</span>
        </a>

        <nav className="hidden items-center gap-7 text-[0.95rem] text-soft md:flex" aria-label="Primary">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors duration-200 hover:text-ink">
              {l.label}
            </a>
          ))}
        </nav>

        <a className="btn btn-primary hidden px-[1.1em] py-[0.55em] text-[0.9rem] md:inline-flex" href="/#download">
          Download
        </a>

        <button
          className="inline-flex rounded-[10px] p-2 text-ink md:hidden"
          type="button"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="nav-menu"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="grid w-[22px] gap-[5px]" aria-hidden="true">
            <span className={`h-0.5 rounded bg-current transition-transform duration-200 ${open ? 'translate-y-[7px] rotate-45' : ''}`} />
            <span className={`h-0.5 rounded bg-current transition-opacity duration-200 ${open ? 'opacity-0' : ''}`} />
            <span className={`h-0.5 rounded bg-current transition-transform duration-200 ${open ? '-translate-y-[7px] -rotate-45' : ''}`} />
          </span>
        </button>
      </div>

      <nav
        id="nav-menu"
        aria-label="Primary"
        className={`absolute inset-x-0 top-full flex-col gap-1 border-b border-[var(--glass-border)] px-6 pb-[18px] pt-2.5 text-base transition-all duration-300 md:hidden ${
          open ? 'flex opacity-100' : 'pointer-events-none hidden opacity-0'
        }`}
        style={{
          background: 'rgba(7, 8, 11, 0.88)',
          backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
          WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
        }}
      >
        {links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className="py-2.5 text-soft transition-colors duration-200 hover:text-ink"
            onClick={() => setOpen(false)}
          >
            {l.label}
          </a>
        ))}
        <a className="btn btn-primary mt-1.5 justify-center" href="/#download" onClick={() => setOpen(false)}>
          Download
        </a>
      </nav>
    </header>
  );
}
