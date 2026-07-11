import Link from 'next/link';

const features = [
  { title: 'Multi-pane Terminal', desc: 'PTY shell grid with xterm.js, drag-to-resize panes.' },
  { title: 'Code Editor', desc: 'CodeMirror 6, 15+ languages, Vim mode, LSP.' },
  { title: 'Live Preview', desc: 'HTTP/WebSocket proxy with auto hot-reload.' },
  { title: 'DOM Inspector', desc: 'Click any element, inspect, send to AI.' },
  { title: 'Git Integration', desc: 'Status, diff, commit, push — all in-app.' },
  { title: 'AI Orchestration', desc: 'Multi-agent task dispatch with voice.' },
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <img src="/icon.png" alt="" className="hero-logo" />
        <h1>Spacron</h1>
        <p className="hero-lead">
          A keyboard-driven, local-first developer workspace — terminal, editor, preview, git, and AI in one window.
        </p>
        <div className="hero-actions">
          <a href="/download" className="btn btn-primary">
            Download
          </a>
          <Link href="/changelog" className="btn btn-ghost">
            Changelog
          </Link>
        </div>
      </section>

      <section className="features" id="features">
        {features.map((f) => (
          <div className="feature-card" key={f.title}>
            <h3>{f.title}</h3>
            <p>{f.desc}</p>
          </div>
        ))}
      </section>
    </>
  );
}
