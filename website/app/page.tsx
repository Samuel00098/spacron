import Link from 'next/link';
import { getChangelogContent, parseChangelog } from '@/lib/changelog';
import { getAgentBrand } from '@/lib/agentBrands';

/**
 * Hero headline split into words so CSS can cascade them in one by one
 * (superwhisper-style entrance). `{word}` renders as a highlighted chip;
 * trailing punctuation (`{word}.`) stays outside the chip.
 */
function heroWords(line: string) {
  return line.split(' ').map((tok) => {
    const chip = tok.match(/^\{(.+)\}([^}]*)$/);
    return chip ? { w: chip[1], tail: chip[2] } : tok;
  });
}

type HeroToken = ReturnType<typeof heroWords>[number];

/** One headline token, preceded by a real space so words never run together. */
function HeroToken({ tok, i, wi }: { tok: HeroToken; i: number; wi: number }) {
  const style = { ['--wi' as string]: wi };
  return (
    <>
      {i > 0 && ' '}
      {typeof tok === 'object' ? (
        <>
          <span className="hero-chip" style={style}>{tok.w}</span>
          {tok.tail && <span className="hero-word" style={style}>{tok.tail}</span>}
        </>
      ) : (
        <span className="hero-word" style={style}>{tok}</span>
      )}
    </>
  );
}
// One phrase per line, stacked. `muted` greys out the payoff line.
const HERO_LINES = [
  { words: heroWords('One {workspace}.'), muted: false },
  { words: heroWords('One {goal}.'), muted: false },
  { words: heroWords('A {fleet} that builds it.'), muted: true },
];
// Running word index across lines, so the cascade flows top to bottom.
const HERO_LINE_OFFSETS = HERO_LINES.map((_, i) =>
  HERO_LINES.slice(0, i).reduce((n, line) => n + line.words.length, 0),
);

const agentCards = [
  { name: 'Claude Code', cmd: 'claude' },
  { name: 'Codex CLI', cmd: 'codex' },
  { name: 'Cursor', cmd: 'cursor-agent' },
  { name: 'Antigravity CLI', cmd: 'agy' },
  { name: 'Grok CLI', cmd: 'grok' },
  { name: 'Aider', cmd: 'aider' },
  { name: 'OpenCode', cmd: 'opencode' },
];

// Where each CLI logo floats behind the hero headline (% of the hero box),
// kept to the sides so they frame the words instead of sitting under them.
const heroFloaters = [
  { cmd: 'claude', name: 'Claude Code', x: 4, y: 18, size: 58, delay: 0 },
  { cmd: 'codex', name: 'Codex CLI', x: 90, y: 12, size: 52, delay: -2.5 },
  { cmd: 'cursor-agent', name: 'Cursor', x: 12, y: 52, size: 46, delay: -5 },
  { cmd: 'agy', name: 'Antigravity CLI', x: 84, y: 46, size: 56, delay: -1.2 },
  { cmd: 'grok', name: 'Grok CLI', x: 16, y: 0, size: 42, delay: -7.3 },
  { cmd: 'aider', name: 'Aider', x: 2, y: 80, size: 44, delay: -3.8 },
  { cmd: 'opencode', name: 'OpenCode', x: 93, y: 76, size: 46, delay: -6.1 },
];

function AgentIcon({ command, name, className = '' }: { command: string; name: string; className?: string }) {
  const brand = getAgentBrand(command, name);
  return (
    <span
      className={`agent-icon${className ? ` ${className}` : ''}`}
      style={{ color: brand.color === 'mono' ? 'var(--text)' : brand.color }}
      aria-hidden="true"
    >
      {brand.mark}
    </span>
  );
}

const agentNotes = [
  { cls: 'live', text: 'Your subscription, your quota' },
  { cls: '', text: 'Mix agents freely within one goal' },
      { cls: 'live', text: 'Manual-first · nothing runs without your say-so' },
];

const fleetRows = [
  { mark: '●', branch: 'main', who: 'goal set: subscription billing', command: undefined, state: 'planning', pending: true },
  { mark: '◆', branch: 'main · apps/billing', who: 'Claude Code', command: 'claude', state: '✓ 42 tests passing', pending: false },
  { mark: '◆', branch: 'main · lib/usage-limits', who: 'Cursor', command: 'cursor-agent', state: '✓ typecheck clean', pending: false },
  { mark: '◆', branch: 'main · apps/gateway', who: 'Codex CLI', command: 'codex', state: '↻ review bounced, returned', pending: false },
];

const toolCards = [
  { name: 'Agent fleet', body: 'Every running agent as a live card · tile, steer, and bounce work back' },
  { name: 'Voice', body: 'Tap left Alt for a live voice conversation; F9 dictates into any field' },
  { name: 'Terminal grid', body: 'Drag-to-resize PTY panes, many sessions at once' },
  { name: 'Editor', body: 'CodeMirror with LSP, syntax modes, and Vim bindings' },
  { name: 'Live preview', body: 'HTTP/WebSocket proxy with hot reload and a DOM inspector' },
  { name: 'Chat workspace', body: 'Threaded conversations with your providers, right beside the code' },
  { name: 'Generations', body: 'Images and videos render into your project, editable in place' },
  { name: 'HTTP inspector', body: 'Send requests and watch every one your app makes' },
  { name: 'Database browser', body: 'Inspect SQLite schemas and run queries safely' },
  { name: 'Containers', body: 'Docker compose and container control without leaving the deck' },
  { name: 'Mobile emulator', body: 'Boot an Android phone, then tap, swipe, and type on it from the panel' },
  { name: 'Remote workspace', body: 'Attach your own VPS and pick the workspace back up mid-state' },
];

// One-time license. One key per user covers every machine and OS — the
// TablePlus/Sublime playbook, minus the per-device tax.
const licensePoints = [
  { term: 'Perpetual license', note: 'Pay once, use forever. No subscription, no per-seat fees.' },
  { term: 'Per-user key', note: 'One license covers all the computers where you are the primary user.' },
  { term: '12 months of updates', note: 'Included with your key; optional renewal keeps you current.' },
  { term: 'Local-first', note: 'Runs on your machine, with the agent subscriptions you already pay for.' },
];

const GENERIC_CHANGELOG_HEADINGS = /^(added|changed|fixed|removed|deprecated|security)$/i;

// Where "Buy now" goes. Set SPACRON_CHECKOUT_URL in env to your Lemon Squeezy
// checkout link; until then the gated /download page stands in.
const checkoutUrl = process.env.SPACRON_CHECKOUT_URL || '/download';

export default async function HomePage() {
  const entries = parseChangelog(await getChangelogContent()).slice(0, 3);
  const insights = entries.map((entry) => {
    // CHANGELOG bodies use conventional "### Added / Fixed" category headings.
    // As card titles those are noise, so the title comes from the first real
    // bullet and the excerpt from the next one (when there is one).
    const bullets = [...entry.body.matchAll(/^\s*[-*]\s+(.{20,140})/gm)]
      .map((m) => m[1].replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim());
    const firstHeading = entry.body.match(/^###\s+(.+)$/m)?.[1]?.trim();
    const heading = firstHeading && !GENERIC_CHANGELOG_HEADINGS.test(firstHeading) ? firstHeading : undefined;
    const title = heading ?? bullets[0] ?? `Spacron v${entry.version}`;
    const excerpt = heading ? bullets[0] ?? '' : bullets[1] ?? '';
    return { version: entry.version, date: entry.date, title, excerpt };
  });

  return (
    <>
      {/* Soft radial glow behind the hero — breathes slowly (CSS only). */}
      <div className="hero-glow" aria-hidden="true" />

      <section className="hero">
        {/* The CLIs Spacron drives, drifting faintly behind the headline. */}
        <div className="hero-floaters" aria-hidden="true">
          {heroFloaters.map((f) => (
            <span
              className="hero-floater"
              key={f.cmd}
              style={{
                left: `${f.x}%`,
                top: `${f.y}%`,
                ['--size' as string]: `${f.size}px`,
                ['--float-delay' as string]: `${f.delay}s`,
              }}
            >
              <AgentIcon command={f.cmd} name={f.name} />
            </span>
          ))}
        </div>
        <span className="hero-badge" data-reveal="scale">
          <span className="hero-badge-dot" aria-hidden="true" />
          Local-first
        </span>
        <h1 className="hero-title" aria-label="One workspace. One goal. A fleet that builds it.">
          {HERO_LINES.map((line, li) => (
            <span className={`hero-line${line.muted ? ' muted' : ''}`} key={li}>
              {line.words.map((tok, i) => (
                <HeroToken key={i} tok={tok} i={i} wi={HERO_LINE_OFFSETS[li] + i} />
              ))}
            </span>
          ))}
        </h1>
        <p className="hero-lead" data-reveal style={{ ['--reveal-delay' as string]: '.55s' }}>
          Spacron runs the coding CLIs you already use as one orchestrated team. An orchestrator splits your goal into disjoint file sets, agents work your repo with instructions not to touch each other, and none of it is mandatory. Every action has a manual path you can take instead.
        </p>
        <div className="hero-actions" data-reveal style={{ ['--reveal-delay' as string]: '.7s' }}>
          <a href={checkoutUrl} className="btn btn-primary">Buy Spacron · $49</a>
          <a href="#how" className="btn btn-ghost">See how it works</a>
        </div>
        <p className="hero-os" data-reveal style={{ ['--reveal-delay' as string]: '.82s' }}>
          Windows (x64 &amp; ARM) <span className="sep">&middot;</span> macOS (Apple Silicon) <span className="sep">&middot;</span> Linux
        </p>

        <div className="terminal" aria-hidden="true" data-reveal="scale" style={{ ['--reveal-delay' as string]: '.9s' }}>
          <div className="terminal-bar">
            <span className="terminal-dot" />
            <span className="terminal-dot" />
            <span className="terminal-dot" />
            <span className="terminal-title">spacron · fleet chat</span>
          </div>
          <div className="terminal-body">
            <div><span className="prompt">&gt;</span> <span className="cmd">build &quot;add subscription billing with Stripe&quot;</span></div>
            <div><span className="dim">orchestrator: planning · 3 sub-tasks, disjoint file sets</span></div>
            <div><span className="agent"><AgentIcon command="claude" name="Claude Code" />Claude Code</span> <span className="dim">&middot; claims apps/billing</span> <span className="ok">✓ 42 tests passing</span></div>
            <div><span className="agent"><AgentIcon command="cursor-agent" name="Cursor" />Cursor</span> <span className="dim">&middot; claims lib/usage-limits</span> <span className="ok">✓ typecheck clean</span></div>
            <div><span className="agent"><AgentIcon command="codex" name="Codex CLI" />Codex CLI</span> <span className="dim">&middot; review · 1 bounce returned</span></div>
            <div><span className="dim">all workers accepted · review bundled, committed to main</span> <span className="terminal-cursor" /></div>
          </div>
        </div>
      </section>

      <section className="section" id="features">
        <p className="section-eyebrow" data-reveal>Your tools</p>
        <h2 className="section-title" data-reveal>Runs the Agents You Already Have</h2>
        <p className="section-lead" data-reveal>
          No keys resold, no quota caps, no lock-in to a model vendor. Spacron orchestrates the harnesses you already use and stays out of the way.
        </p>

        {/* Infinite marquee of agent cards — pauses on hover. */}
        <div className="marquee" data-reveal>
          <div className="marquee-track">
            {[...agentCards, ...agentCards].map((a, i) => (
              <div className="agents-card" key={`${a.name}-${i}`} aria-hidden={i >= agentCards.length}>
                <AgentIcon command={a.cmd} name={a.name} />
                <span className="agents-name">{a.name}</span>
                <span className="agents-cmd">{a.cmd}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="agents-notes">
          {agentNotes.map((n) => (
            <div className={`chip ${n.cls}`.trim()} key={n.text} data-reveal="scale">
              <span className="dot" />
              <span>{n.text}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="how">
        <p className="section-eyebrow" data-reveal>How it works</p>
        <h2 className="section-title" data-reveal>A Team, Not a Chat Window</h2>
        <p className="section-lead" data-reveal>Everything a fleet needs under one roof: split the work, keep the work separate, review the work.</p>

        <div className="feature-row" id="how-worktree">
          <div className="feature-copy" data-reveal="left">
            <h3>Together in your repo, told not to touch each other</h3>
            <p>
              The orchestrator splits your goal into sub-tasks with disjoint file sets, then gives every agent an explicit charter: do only your task, never revert changes that aren&apos;t yours, only touch the files you claimed. Agents work in your main repo by default so you see every edit, or each one can opt into its own isolated worktree when you want more separation. Reviews bounce weak work back with a critique in either case.
            </p>
          </div>
          <div className="dark-panel" aria-hidden="true" data-reveal="right">
            {fleetRows.map((row, i) => (
              <div className={`fleet-row${row.pending ? ' is-pending' : ''}`} style={{ ['--ri' as string]: i }} key={row.branch}>
                <span className="mark">{row.mark}</span>
                <span className="branch">{row.branch}</span>
                <span className="who">
                  &middot; {row.command && <AgentIcon command={row.command} name={row.who} />}{row.who}
                </span>
                <span className={`state${row.pending ? ' pending' : ''}`}>{row.state}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="feature-row flip" id="orchestrator">
          <div className="feature-copy" data-reveal="right">
            <h3>An orchestrator that reads the whole deck</h3>
            <p>
              The conversational orchestrator watches what you watch: the active file, your cursor, every open pane, the current branch, the task board. Ask it to find what&apos;s weak and get a concrete, evidence-backed answer in one turn. Hand it a goal and it plans, delegates, verifies, and reports back.
            </p>
          </div>
          <div className="dark-panel" aria-hidden="true" data-reveal="left">
            <div className="chat-msg you">
              <span className="role">you</span>
              Go through the codebase and tell me where it&apos;s weak.
            </div>
            <div className="chat-msg bot">
              <span className="role">orchestrator</span>
              Swept 41 files. Three weak spots: the preview proxy never closes sockets on error; auth tokens sit in localStorage; the latest migration has no rollback path. All three are ranked in the task board.
            </div>
          </div>
        </div>

        <div className="feature-row" id="do-it-yourself">
          <div className="feature-copy" data-reveal="left">
            <h3>Or skip the fleet entirely · it&apos;s all yours either way</h3>
            <p>
              Spacron is manual-first. You drive, it assists: agents only run when you say so, risky actions need your approval, edits land on branches you review and merge yourself. If you&apos;d rather build by hand, Spacron is simply a blazing-fast terminal, editor, preview proxy, and git panel. With zero AI configured, nothing forces itself on you.
            </p>
          </div>
          <div className="dark-panel" aria-hidden="true" data-reveal="right">
            <div className="chat-msg you">
              <span className="role">you</span>
              Skip the agents this time. Set up the repo scaffold and I&apos;ll write it by hand.
            </div>
            <div className="chat-msg bot">
              <span className="role">orchestrator</span>
              Nothing spawned. Scaffold is ready in the editor. Take it from here. The goal stays saved in the task board if you change your mind.
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="toolbox">
        <p className="section-eyebrow" data-reveal>The deck</p>
        <h2 className="section-title" data-reveal>Everything Else Under the Same Roof</h2>
        <p className="section-lead" data-reveal>A fleet deck is more than chat. Spacron ships the rest of your workspace in the same window: keyboard-driven, local-first.</p>
        <div className="features">
          {toolCards.map((card) => (
            <div className="feature-card" key={card.name} data-reveal="scale">
              <h3>{card.name}</h3>
              <p>{card.body}</p>
            </div>
          ))}
        </div>
      </section>

      {insights.length > 0 && (
        <section className="section" id="insights">
          <p className="section-eyebrow" data-reveal>Latest releases</p>
          <h2 className="section-title" data-reveal>Fresh From the Changelog</h2>
          <div className="insight-grid">
            {insights.map((insight) => (
              <Link href="/changelog" className="insight-card" key={insight.version} data-reveal="scale">
                <span className="insight-date">v{insight.version} &middot; {insight.date}</span>
                <h3>{insight.title}</h3>
                <p>{insight.excerpt}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="section" id="pricing">
        <p className="section-eyebrow" data-reveal>Pricing</p>
        <h2 className="section-title" data-reveal>One workspace. One license.</h2>
        <p className="section-lead" data-reveal>
          Pay once and own Spacron. It orchestrates the agent subscriptions you already have: no per-seat fees, no AI token upcharge, no cloud lock-in.
        </p>
        <div className="pricing" data-reveal="scale">
          <div className="pricing-card">
            <div className="pricing-head">
              <span className="pricing-name">Spacron · Personal</span>
              <span className="pricing-price">$49<span className="pricing-period">one-time</span></span>
              <span className="pricing-sub">Perpetual license, per user · Windows (x64 &amp; ARM), macOS, Linux</span>
            </div>
            <ul className="pricing-list">
              {licensePoints.map((point) => (
                <li key={point.term}>
                  <span className="check" aria-hidden="true">✓</span>
                  <span><strong>{point.term}.</strong> {point.note}</span>
                </li>
              ))}
            </ul>
            <a href={checkoutUrl} className="btn btn-primary pricing-cta">Buy now · $49</a>
            <p className="pricing-fineprint">30-day money-back guarantee &middot; your unique license key is emailed after checkout</p>
            <p className="pricing-redeem"><a href="/download">Already bought? Redeem your license key &rarr;</a></p>
          </div>
        </div>
      </section>

      <section className="final-cta">
        <h2 data-reveal="scale">Your codebase isn&apos;t<br />going to write itself.</h2>
        <p data-reveal>Spin up a fleet tonight. Tell Spacron the goal and watch the team work.</p>
        <div className="hero-actions" data-reveal>
          <a href={checkoutUrl} className="btn btn-primary">Buy Spacron · $49</a>
        </div>
      </section>
    </>
  );
}
