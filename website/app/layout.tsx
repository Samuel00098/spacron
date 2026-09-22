import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Inter, Atkinson_Hyperlegible } from 'next/font/google';
import ScrollFX from './ScrollFX';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const atkinson = Atkinson_Hyperlegible({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-atkinson' });

export const metadata: Metadata = {
  title: 'Spacron — One workspace. One goal. A fleet that builds it.',
  description:
    'A keyboard-driven, local-first desktop workspace where a team of AI agents builds, tests, and reviews your code in parallel — PTY terminal grid, CodeMirror editor, live preview, git integration, and AI orchestration, built with Tauri 2 + React.',
  icons: {
    icon: '/favicon.png',
    shortcut: '/favicon.ico',
  },
  openGraph: {
    title: 'Spacron — Agentic coding workspace',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The desktop preview bridge intentionally decorates these root nodes with
  // its selected theme before React hydrates the preview document.
  return (
    <html lang="en" className={`${inter.variable} ${atkinson.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: jsHook }} />
        <ScrollFX />
        <div className="banner">
          Spacron — agents, worktrees, and voice, coordinated.{' '}
          <a href="/download">Get the latest release →</a>
        </div>
        <div className="container">
          <nav className="nav">
            <Link href="/" className="nav-brand">
              <img src="/icon.png" alt="" />
              Spacron
            </Link>
            <div className="nav-links">
              <a href="/#features">Features</a>
              <Link href="/changelog">Changelog</Link>
              <a href="https://github.com/Samuel00098/spacron-releases/releases" target="_blank" rel="noopener noreferrer">
                Releases
              </a>
              <a href="/download" className="nav-cta">Download</a>
            </div>
          </nav>
          <main>{children}</main>
          <footer className="footer">
            <p>
              Spacron &middot; &copy; 2026 Samuel Solesi. All rights reserved. &middot;
              <a href="https://github.com/Samuel00098/spacron-releases/releases" target="_blank" rel="noopener noreferrer"> Releases</a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
