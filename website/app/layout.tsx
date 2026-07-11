import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Spacron — A lightweight, terminal-first developer workspace',
  description:
    'A keyboard-driven, local-first desktop workspace combining a PTY terminal grid, CodeMirror editor, live web preview, git integration, and AI orchestration — built with Tauri 2 + React.',
  icons: {
    icon: '/favicon.png',
    shortcut: '/favicon.ico',
  },
  openGraph: {
    title: 'Spacron — Terminal-first developer workspace',
    description:
      'A keyboard-driven, local-first desktop workspace combining a PTY terminal grid, CodeMirror editor, live web preview, git integration, and AI orchestration.',
    type: 'website',
    siteName: 'Spacron',
  },
};

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0e0e0e',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="container">
          <nav className="nav">
            <Link href="/" className="nav-brand">
              <img src="/icon.png" alt="" />
              Spacron
            </Link>
            <div className="nav-links">
              <a href="/#features">Features</a>
              <Link href="/changelog">Changelog</Link>
              <a href="https://github.com/Samuel00098/spacron" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
            </div>
          </nav>
          <main>{children}</main>
          <footer className="footer">
            <p>
              Spacron &middot; Apache 2.0 &middot;
              <a href="https://github.com/Samuel00098/spacron" target="_blank" rel="noopener noreferrer"> GitHub</a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
