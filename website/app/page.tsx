import Link from 'next/link';

const features = [
  {
    icon: '\u2395',
    title: 'Multi-pane Terminal Grid',
    desc: 'Full PTY shell sessions with xterm.js, drag-to-resize panes, and automatic shell detection per platform.',
  },
  {
    icon: '\u2702',
    title: 'Code Editor',
    desc: 'CodeMirror 6 with 15+ language grammars, built-in Vim mode, minimap, format-on-save, and word wrap.',
  },
  {
    icon: '\u25C9',
    title: 'Live Preview Proxy',
    desc: 'Built-in HTTP/WebSocket proxy that routes your dev server through a managed port with automatic hot-reload.',
  },
  {
    icon: '\u25A3',
    title: 'DOM Inspector',
    desc: 'Click any element in the live preview to inspect its tag, styles, and selectors — send it straight to the AI prompt bar.',
  },
  {
    icon: '\u2387',
    title: 'Git Integration',
    desc: 'Review staged/unstaged changes, inspect diffs, view commit history, and commit or discard files — all without leaving the app.',
  },
  {
    icon: '\u2318',
    title: 'Command Palette',
    desc: 'A unified keyboard bar that triggers file, view, terminal, formatter, and settings actions instantly.',
  },
  {
    icon: '\u2B50',
    title: 'AI Orchestration',
    desc: 'Built-in orchestrator agent system with voice input/output. Plan tasks, delegate to agents, and get results — all locally.',
  },
  {
    icon: '\u25FB',
    title: 'Workspace Snapshots',
    desc: 'Capture your active layouts, editor states, and open tabs; restore them with a single click.',
  },
];

const downloads = [
  { os: 'Windows', icon: '\u229E', desc: '.exe installer' },
  { os: 'macOS', icon: '\u2300', desc: 'Apple Silicon .dmg' },
  { os: 'Linux', icon: '\u2630', desc: '.AppImage' },
];

export default function HomePage() {
  return (
    <>
      {/* ── Hero Section ── */}
      <section className="hero">
        <img src="/icon.png" alt="Spacron logo" className="hero-logo" />
        <h1>
          A terminal-first workspace<br />
          for modern development
        </h1>
        <p className="tagline">
          A keyboard-driven, local-first desktop workspace that combines a real terminal grid, a code editor,
          a live web preview, git integration, and AI orchestration — all inside one window.
        </p>
        <div className="hero-actions">
          <a href="https://github.com/Samuel00098/spacron/releases" className="btn btn-primary">
            Download
          </a>
          <Link href="/changelog" className="btn btn-ghost">
            Changelog
          </Link>
        </div>
        <div className="hero-badges">
          <span className="badge">Tauri 2</span>
          <span className="badge">React 19</span>
          <span className="badge">Rust</span>
          <span className="badge">Apache 2.0</span>
          <span className="badge">Offline-first</span>
        </div>
      </section>

      {/* ── Features Section ── */}
      <section className="section" id="features">
        <h2 className="section-title">Everything you need, nothing you don&apos;t</h2>
        <div className="features-grid">
          {features.map((f) => (
            <div className="feature-card" key={f.title}>
              <div className="icon">{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pricing Section ── */}
      <section className="pricing-section" id="pricing">
        <h2>Pay once, own it forever.</h2>
        <p className="pricing-sub">No subscriptions. No hidden fees. No catch.</p>
        <div className="pricing-card">
          <div className="price">Free</div>
          <div className="price-label">as in freedom &amp; as in beer</div>
          <ul className="features-list">
            <li>all features included</li>
            <li>all platform builds</li>
            <li>offline-first, no account needed</li>
            <li>open source (Apache 2.0)</li>
          </ul>
          <a
            href="https://github.com/Samuel00098/spacron/releases"
            className="btn btn-primary"
            style={{ width: '100%' }}
          >
            Get Spacron
          </a>
        </div>
      </section>

      {/* ── Download Section ── */}
      <section className="section" id="download">
        <h2 className="section-title">Download</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem', textAlign: 'center' }}>
          Grab the latest build for your platform from GitHub Releases.
        </p>
        <div className="downloads">
          {downloads.map((d) => (
            <a
              key={d.os}
              href="https://github.com/Samuel00098/spacron/releases"
              className="download-card"
            >
              <div className="os-icon">{d.icon}</div>
              <div className="os-name">{d.os}</div>
              <div className="os-desc">{d.desc}</div>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}
