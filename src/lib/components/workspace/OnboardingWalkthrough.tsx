import { useState, useCallback, useEffect, useRef } from 'react';
import { markOnboardingCompleted, appearance } from '$lib/stores/settings';
import { switchPresetTheme, activeTheme } from '$lib/stores/theme';
import { presetThemes } from '$lib/stores/presetThemes';
import { settingsOpen, openSettings } from '$lib/stores/layout';
import { useStore } from '$lib/react/useStore';
import packageJson from '../../../../package.json';
import './OnboardingWalkthrough.css';

const iconSrc = `/icon.png?v=${packageJson.version}`;

const onboardingThemes = presetThemes.filter(t =>
  ['solace-workspace', 'nocturne-sky-workspace', 'aether-curves', 'dark-coastline'].includes(t.id)
);

type Step = 'welcome' | 'appearance' | 'interface' | 'shortcuts' | 'features' | 'done';

const shortcuts = [
  { label: 'Command Palette', kbd: 'Ctrl+Shift+P' },
  { label: 'Quick Capture',   kbd: 'Ctrl+Shift+Space' },
  { label: 'Voice Mode',      kbd: 'Ctrl+Shift+M' },
  { label: 'Go to Terminal',  kbd: 'Ctrl+`' },
  { label: 'Open Folder',     kbd: 'Ctrl+O' },
  { label: 'Open Settings',   kbd: 'Ctrl+,' },
  { label: 'Spawn Agents',    kbd: 'Ctrl+Shift+A' },
  { label: 'Toggle Sidebar',  kbd: 'Ctrl+B' },
];

const appearanceModes: { id: 'system' | 'light' | 'dark'; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export default function OnboardingWalkthrough({ onclose = () => {} }: { onclose?: () => void }) {
  const theme = useStore(activeTheme);
  const currentAppearance = useStore(appearance);
  const settingsIsOpen = useStore(settingsOpen);
  const [step, setStep] = useState<Step>(() => {
    const saved = sessionStorage.getItem('spacron_onboarding_step');
    return (saved && ['welcome', 'appearance', 'interface', 'shortcuts', 'features', 'done'].includes(saved))
      ? saved as Step : 'welcome';
  });
  const [iconError, setIconError] = useState(false);
  const wasSettingsOpen = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (wasSettingsOpen.current && !settingsIsOpen) {
      const el = overlayRef.current;
      if (el) el.style.zIndex = '99999';
      if (step === 'appearance') setStep('interface');
    }
    wasSettingsOpen.current = settingsIsOpen;
  }, [settingsIsOpen, step]);

  const finish = useCallback(() => {
    sessionStorage.removeItem('spacron_onboarding_step');
    markOnboardingCompleted();
    onclose();
  }, [onclose]);

  const goTo = useCallback((s: Step) => {
    sessionStorage.setItem('spacron_onboarding_step', s);
    setStep(s);
  }, []);

  const handleBrowseThemes = useCallback(() => {
    const el = overlayRef.current;
    if (el) el.style.zIndex = '8000';
    openSettings();
  }, []);

  return (
    <div className="ob-overlay" ref={overlayRef}>
      <div className="ob-card">
        <div className="ob-card-inner">
          <div className="ob-progress">
            {(['welcome', 'appearance', 'interface', 'shortcuts', 'features'] as Step[]).map((s) => (
              <div key={s} className={`ob-dot${step === s ? ' active' : ''}${getStepIndex(s) < getStepIndex(step) ? ' done' : ''}`} />
            ))}
          </div>

          {/* ══════ WELCOME ══════ */}
          {step === 'welcome' && (
            <>
              <div className="ob-top">
                {!iconError ? (
                  <img src={iconSrc} alt="" className="ob-logo" onError={() => setIconError(true)} />
                ) : (
                  <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                    <rect width="36" height="36" rx="8" fill="var(--accent-light)" />
                    <polyline points="10,22 14,18 10,14" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
                    <rect x="17" y="17" width="10" height="2.5" rx="1.25" fill="var(--text-primary)" />
                  </svg>
                )}
                <h1 className="ob-title">Welcome to Spacron</h1>
                <p className="ob-desc">
                  A keyboard-driven developer workspace with a code editor, terminal,
                  AI agents, HTTP client, database explorer, and dev tools, all in one window.
                </p>
              </div>
              <div className="ob-welcome-features">
                <div className="ob-wf-item">
                  <span className="ob-wf-icon t1">{'>'}</span>
                  <span className="ob-wf-label">Code + terminal</span>
                </div>
                <div className="ob-wf-item">
                  <span className="ob-wf-icon t2">{'~'}</span>
                  <span className="ob-wf-label">AI agents</span>
                </div>
                <div className="ob-wf-item">
                  <span className="ob-wf-icon t3">{'*'}</span>
                  <span className="ob-wf-label">Voice mode</span>
                </div>
              </div>
              <button className="ob-primary-btn" onClick={() => goTo('appearance')}>
                Let&apos;s get started
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </>
          )}

          {/* ══════ APPEARANCE ══════ */}
          {step === 'appearance' && (
            <>
              <div className="ob-top">
                <h2 className="ob-step-title">Appearance</h2>
                <p className="ob-step-desc">Choose your look. You can always change this later in Settings.</p>
              </div>

              <div className="ob-section-row">
                <span className="ob-section-label">Mode</span>
                <div className="ob-appearance-toggle">
                  {appearanceModes.map((m) => (
                    <button
                      key={m.id}
                      className={`ob-appearance-btn${currentAppearance === m.id ? ' active' : ''}`}
                      onClick={() => appearance.set(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ob-section-row">
                <span className="ob-section-label">Quick theme pick</span>
              </div>
              <div className="ob-theme-grid">
                {onboardingThemes.map((t) => (
                  <button
                    key={t.id}
                    className={`ob-theme-btn${theme?.id === t.id ? ' selected' : ''}`}
                    onClick={() => switchPresetTheme(t.id, false)}
                    title={t.name}
                  >
                    <div className="ob-theme-preview">
                      <div className="ob-theme-sidebar" style={{ background: t.colors['activitybar-bg'] || (t.type === 'dark' ? '#111' : '#eee') }} />
                      <div className="ob-theme-editor" style={{ background: t.colors['editor-bg'] || (t.type === 'dark' ? '#1a1a1a' : '#fff') }}>
                        <div className="ob-theme-line" style={{ width: '55%', background: t.syntax['keyword'] || t.colors['accent'] }} />
                        <div className="ob-theme-line" style={{ width: '80%', background: t.colors['text-primary'] || '#888', opacity: 0.4 }} />
                        <div className="ob-theme-line" style={{ width: '45%', background: t.colors['text-primary'] || '#888', opacity: 0.25 }} />
                      </div>
                    </div>
                    <span className="ob-theme-name" style={{ color: t.type === 'dark' ? '#ddd' : '#333' }}>{t.name}</span>
                  </button>
                ))}
              </div>

              <button className="ob-ghost-btn" onClick={handleBrowseThemes}>
                Browse all themes in Settings
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>

              <button className="ob-primary-btn" onClick={() => goTo('interface')}>
                Continue
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </>
          )}

          {/* ══════ INTERFACE ══════ */}
          {step === 'interface' && (
            <>
              <div className="ob-top">
                <h2 className="ob-step-title">Your workspace</h2>
                <p className="ob-step-desc">Five main zones make up the window.</p>
              </div>

              <div className="ob-interface-legend">
                {[
                  { label: 'Activity Bar', desc: 'Navigate Explorer, Terminal, and Settings' },
                  { label: 'Sidebar', desc: 'Browse files, search projects, manage Git, save snapshots' },
                  { label: 'Main Stage', desc: 'Editor, terminal, preview, and AI agent rooms' },
                  { label: 'Right Drawer', desc: 'Dev toolbox, HTTP client, database, containers, env' },
                  { label: 'Status Bar', desc: 'Git branch, cursor position, zoom level, quick toggles' },
                ].map((item) => (
                  <div key={item.label} className="ob-legend-item">
                    <span className="ob-legend-badge">{item.label}</span>
                    <span className="ob-legend-desc">{item.desc}</span>
                  </div>
                ))}
              </div>

              <button className="ob-primary-btn" onClick={() => goTo('shortcuts')}>
                Continue
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </>
          )}

          {/* ══════ SHORTCUTS ══════ */}
          {step === 'shortcuts' && (
            <>
              <div className="ob-top">
                <h2 className="ob-step-title">Keyboard shortcuts</h2>
                <p className="ob-step-desc">Spacron is built for the keyboard. These will get you far.</p>
              </div>

              <div className="ob-shortcuts-grid">
                {shortcuts.map((s) => (
                  <div key={s.kbd} className="ob-shortcut-item">
                    <span className="ob-shortcut-label">{s.label}</span>
                    <kbd className="ob-shortcut-kbd">{s.kbd}</kbd>
                  </div>
                ))}
              </div>

              <p className="ob-hint">All shortcuts can be customised in Settings &rarr; Shortcuts.</p>

              <button className="ob-primary-btn" onClick={() => goTo('features')}>
                Continue
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </>
          )}

          {/* ══════ FEATURES ══════ */}
          {step === 'features' && (
            <>
              <div className="ob-top">
                <h2 className="ob-step-title">Key features</h2>
                <p className="ob-step-desc">A few things that make Spacron different.</p>
              </div>

              <div className="ob-features-list">
                {[
                  { icon: '>', title: 'AI Agents', desc: 'Spawn coding agents that read your project, run terminal commands, and edit files.' },
                  { icon: '~', title: 'Voice Mode', desc: 'Dictate code, control the terminal, and converse with AI, hands-free.' },
                  { icon: '#', title: 'Git Integration', desc: 'Stage, commit, push, pull, and manage branches from the sidebar.' },
                  { icon: '%', title: 'Dev Toolbox', desc: 'JWT decoder, JSON formatter, regex tester, epoch converter, URL coder.' },
                  { icon: '&', title: 'HTTP Client', desc: 'Compose and test REST API requests with full response viewer and history.' },
                ].map((f, i) => (
                  <div key={i} className="ob-feature-item">
                    <span className="ob-feature-icon">{f.icon}</span>
                    <div className="ob-feature-text">
                      <span className="ob-feature-title">{f.title}</span>
                      <span className="ob-feature-desc">{f.desc}</span>
                    </div>
                  </div>
                ))}
              </div>

              <button className="ob-primary-btn" onClick={() => goTo('done')}>
                Continue
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </>
          )}

          {/* ══════ DONE ══════ */}
          {step === 'done' && (
            <>
              <div className="ob-top">
                {!iconError ? (
                  <img src={iconSrc} alt="" className="ob-logo" onError={() => setIconError(true)} />
                ) : (
                  <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                    <rect width="36" height="36" rx="8" fill="var(--accent-light)" />
                    <polyline points="10,22 14,18 10,14" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
                    <rect x="17" y="17" width="10" height="2.5" rx="1.25" fill="var(--text-primary)" />
                  </svg>
                )}
                <h1 className="ob-title">You&apos;re all set</h1>
                <p className="ob-desc">
                  Open a folder to start coding, or press <kbd className="ob-desc-kbd">Ctrl+Shift+P</kbd> to open the command palette.
                </p>
              </div>

              <button className="ob-primary-btn" onClick={finish}>
                Get Started
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function getStepIndex(s: Step): number {
  return ['welcome', 'appearance', 'interface', 'shortcuts', 'features', 'done'].indexOf(s);
}
