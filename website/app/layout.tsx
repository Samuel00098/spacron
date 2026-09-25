import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Inter, Atkinson_Hyperlegible } from 'next/font/google';
import ScrollFX from './ScrollFX';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const atkinson = Atkinson_Hyperlegible({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-atkinson' });

export const metadata: Metadata = {
  title: 'Spacron · One workspace. One goal. A fleet that builds it.',
  description:
    'A keyboard-driven, local-first desktop workspace where a team of AI agents builds, tests, and reviews your code in parallel: PTY terminal grid, CodeMirror editor, live preview, git integration, and AI orchestration, built with Tauri 2 + React.',
  // Black mark on light browser chrome, white mark on dark. faviconThemeHook
  // below overrides this when the Spacron app's Preview supplies its theme.
  icons: {
    icon: [
      { url: '/favicon.png', media: '(prefers-color-scheme: light)' },
      { url: '/favicon-white.png', media: '(prefers-color-scheme: dark)' },
    ],
    shortcut: '/favicon.ico',
  },
  openGraph: {
    title: 'Spacron · Agentic coding workspace',
    description:
      'Run a team of AI coding agents in parallel terminals. Terminal, editor, preview, git, and orchestration in one local-first window.',
    type: 'website',
    siteName: 'Spacron',
  },
};

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0a0a0a',
};

// Pre-paint class hook so entrance animations never flash hidden text when JS
// is off or slow: paint visible by default, hide only once we know JS will run.
const jsHook = `document.documentElement.classList.add('js');`;

// Inside Spacron's Preview the app's theme wins over the OS one: the preview
// bridge sets data-spacron-preview-theme and fires spacron-preview-theme-change
// (src/lib/components/preview/PreviewPanel.tsx). Pin every icon link to the
// matching mark and drop its media query so the browser can't pick the other.
const faviconThemeHook = `(function(){
  function apply(mode){
    if(mode!=='light'&&mode!=='dark')return;
    var href=mode==='light'?'/favicon.png':'/favicon-white.png';
    document.querySelectorAll('link[rel~="icon"]').forEach(function(l){l.removeAttribute('media');l.href=href;});
  }
  window.addEventListener('spacron-preview-theme-change',function(e){apply(e.detail&&e.detail.theme);});
  window.addEventListener('DOMContentLoaded',function(){apply(document.documentElement.dataset.spacronPreviewTheme);});
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const checkoutUrl = process.env.SPACRON_CHECKOUT_URL || '/download';
  // The desktop preview bridge intentionally decorates these root nodes with
  // its selected theme before React hydrates the preview document.
  return (
    <html lang="en" className={`${inter.variable} ${atkinson.variable}`} data-scroll-behavior="smooth" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: jsHook }} />
        <script dangerouslySetInnerHTML={{ __html: faviconThemeHook }} />
        <ScrollFX />
        <div className="banner">
          Spacron · agents, worktrees, and voice, orchestrated.{' '}
          <a href={checkoutUrl}>Buy Spacron · $49 one-time →</a>
        </div>
        <div className="container">
          <nav className="nav">
            <Link href="/" className="nav-brand">
              <span className="nav-brand-mark" aria-hidden="true" />
              Spacron
            </Link>
            <div className="nav-links">
              <a href="/#features">Features</a>
              <a href="/#pricing">Pricing</a>
              <Link href="/changelog">Changelog</Link>
              <a href="/download">Redeem</a>
              <a href={checkoutUrl} className="nav-cta">Buy now</a>
            </div>
          </nav>
          <main>{children}</main>
          <footer className="footer">
            <p>
              Spacron &middot; &copy; 2026 Samuel Solesi. All rights reserved. &middot;
              <a href="/download">Redeem your license</a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
