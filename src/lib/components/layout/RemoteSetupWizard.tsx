import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import Dropdown from '$lib/components/shared/Dropdown.tsx';
import { addRemoteConnection, connectRemote } from '$lib/stores/remoteWorkspace';
import {
  binaryNotice,
  DEPLOY_PLATFORMS,
  platformLabel,
  validateDeployInput,
  type DeployInput,
  type DeployPlatform,
  type DeployResult,
  type ServerBinaryStatus,
  type ServerDownloadResult,
} from './remoteSetup';
import './RemoteSetupWizard.css';

/**
 * "Set up a remote VPS" — the one-flow path from a fresh VPS to a connected
 * remote workspace. Calls `remote_deploy_vps` (src-tauri/src/commands/
 * remote_deploy.rs), which uploads the bundled `spacron-server` sidecar over
 * SSH, writes a token, starts it, and arms a @reboot entry — then this
 * component saves the returned connection and connects, so the user lands in
 * their remote workspace without ever touching a terminal on the VPS.
 *
 * SSH notes surfaced to the user: the flow needs key-based access (BatchMode —
 * no password prompts) and works with either an explicit private-key path or
 * an ssh-agent / default keys.
 */

const PLATFORM_HINTS: Record<DeployPlatform, string> = {
  linux: 'Ubuntu and Debian install the runtime libraries automatically when passwordless sudo is available.',
  'linux-arm64': 'For 64-bit ARM boxes (Ampere, Graviton, Raspberry Pi 4/5). Ubuntu and Debian install the runtime libraries automatically when passwordless sudo is available.',
  macos: 'Enable Remote Login on the Mac (System Settings → General → Sharing). Runs as a launchd agent.',
  windows: 'Enable OpenSSH Server on the box; admin SSH access is needed for the boot task and firewall rule.',
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function RemoteSetupWizard({ open, onClose }: Props) {
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [keyPath, setKeyPath] = useState('');
  const [workspace, setWorkspace] = useState('code');
  const [serverPort, setServerPort] = useState('9000');
  const [platform, setPlatform] = useState<DeployPlatform>('linux');
  const [hostOs, setHostOs] = useState<DeployPlatform | null>(null);
  // Server-side OS detection (remote_detect_platform): what the box itself
  // reports over SSH once host + username are filled in.
  const [detected, setDetected] = useState<DeployPlatform | null>(null);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Whether a server build for the *target* platform exists on this machine.
  // null until the first check answers, which renders as no notice at all.
  const [binaryStatus, setBinaryStatus] = useState<ServerBinaryStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Set once the user changes the picker by hand — afterwards a differing
  // detection is surfaced as a warning instead of silently overriding them.
  const platformTouchedRef = useRef(false);

  // Default the target platform to the OS running this app — the bundled
  // server binary is built for it (deploying elsewhere needs a cross-built
  // binary via SPACRON_SERVER_PATH). Best-effort: previewing in a plain
  // browser just leaves the default.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const os = await invoke<string>('mobile_platform');
        const p: DeployPlatform | null =
          os === 'windows' ? 'windows' : os === 'macos' ? 'macos' : 'linux';
        if (!cancelled) {
          setHostOs(p);
          if (p) setPlatform(p);
        }
      } catch {
        // The panel may be previewed in a plain browser where invoke is absent.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Detection state must not survive a close/reopen — the next open probes
  // fresh against whatever host is typed then.
  useEffect(() => {
    if (!open) {
      setDetected(null);
      setDetectNote(null);
      setDetecting(false);
    }
  }, [open]);

  // Is there a server build for the chosen platform on this machine? Re-checked
  // whenever the target changes and after a download, because the answer is
  // per-platform and the download is what changes it. A failed check leaves the
  // status null: the deploy still surfaces the resolver's own error, so an
  // unavailable check must not invent a blocker.
  const refreshBinaryStatus = async (target: DeployPlatform) => {
    try {
      const status = await invoke<ServerBinaryStatus>('remote_server_binary_status', {
        platform: target,
      });
      return status;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    if (!open) {
      setBinaryStatus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const status = await refreshBinaryStatus(platform);
      if (!cancelled) setBinaryStatus(status);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, platform]);

  // Auto-detect the server's OS once host + username are filled in. Debounced
  // per edit burst; adopts what the server reports unless the user already
  // picked a platform by hand (then it only warns).
  useEffect(() => {
    if (!open) return;
    const h = host.trim();
    const u = username.trim();
    if (!h || !u) return;
    let cancelled = false;
    setDetecting(true);
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await invoke<{ platform: string | null; detail: string }>(
            'remote_detect_platform',
            {
              args: {
                host: h,
                username: u,
                sshPort: Number(sshPort) || 22,
                keyPath: keyPath.trim(),
              },
            },
          );
          if (cancelled) return;
          const p = (res.platform as DeployPlatform | null) ?? null;
          setDetected(p);
          setDetectNote(res.detail || null);
          if (p && !platformTouchedRef.current) setPlatform(p);
        } catch (err) {
          if (!cancelled) {
            setDetected(null);
            setDetectNote((err as Error)?.message ?? String(err));
          }
        } finally {
          if (!cancelled) setDetecting(false);
        }
      })();
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, host, username, sshPort, keyPath]);

  if (!open) return null;

  async function deploy(e: FormEvent) {
    e.preventDefault();
    const input: DeployInput = {
      host: host.trim(),
      username: username.trim(),
      // Raw Number() — no `|| 22` fallback. Coercing NaN to a default here
      // happens BEFORE validateDeployInput runs, so a typo like "2 2" would
      // silently deploy against the default port instead of failing validation.
      sshPort: Number(sshPort),
      keyPath: keyPath.trim(),
      workspace: workspace.trim() || 'code',
      serverPort: Number(serverPort),
      platform,
    };
    const problem = validateDeployInput(input);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    setStage('Connecting and uploading the server…');
    try {
      const result = await invoke<DeployResult>('remote_deploy_vps', { ...input });
      setStage('Saving the connection…');
      const id = await addRemoteConnection({ name: input.host, url: result.url, token: result.token });
      setStage('Connecting…');
      await connectRemote(id);
      const { showToast } = await import('$lib/stores/notification');
      showToast(`Connected to ${input.host}`, 'success', 4000);
      onClose();
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setBusy(false);
      setStage('');
    }
  }

  async function downloadServerBuild() {
    setDownloading(true);
    setError(null);
    try {
      const result = await invoke<ServerDownloadResult>('remote_download_server', { platform });
      setBinaryStatus(await refreshBinaryStatus(platform));
      const { showToast } = await import('$lib/stores/notification');
      const mb = (result.bytes / (1024 * 1024)).toFixed(1);
      showToast(`${platformLabel(platform)} server downloaded (${mb} MB)`, 'success', 4000);
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setDownloading(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // Stop the RemoteStatus popover's own Escape handler from closing too.
      e.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (e.key === 'Tab') {
      // aria-modal promises a focus trap; this wrap-around over the form's own
      // focusables is the whole trap this dialog needs.
      const focusables = formRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const outside = !formRef.current?.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Portaled to <body> like SettingsModal: the wizard mounts inside the
  // title bar (via RemoteStatus), and the title bar's `backdrop-filter` makes
  // it the containing block for `position: fixed` — an unported overlay would
  // size to the 38px bar instead of the viewport and pin the card to the top.
  return createPortal(
    <div
      className="rsw-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Set up a remote VPS"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <form className="rsw-card" onSubmit={deploy} ref={formRef}>
        <div className="rsw-title">Set up a remote VPS</div>
        <p className="rsw-desc">
          Deploys the bundled Spacron server to your box over SSH, starts it, and connects, with no
          terminal needed. Requires SSH key access (or an ssh-agent); password login isn&apos;t
          supported.
        </p>

        <div className="rsw-grid">
          {/* A div, not a <label>: a label forwards a click anywhere on its
              (full-width) row to the picker, so it opened off-target. The
              picker names itself via ariaLabel. */}
          <div className="rsw-field rsw-field-wide">
            <span className="rsw-label">Server platform</span>
            <Dropdown
              options={DEPLOY_PLATFORMS.map((p) => ({ value: p, label: platformLabel(p) }))}
              value={platform}
              onChange={(v) => {
                platformTouchedRef.current = true;
                setPlatform(v as DeployPlatform);
              }}
              ariaLabel="Server platform"
            />
            {detecting && (
              <span className="rsw-hint">Asking the server which OS it runs…</span>
            )}
            {!detecting && detected && (
              <span
                className={`rsw-hint${detected === platform ? ' rsw-hint-ok' : ' rsw-warn'}`}
                title={detectNote ?? undefined}
              >
                {detected === platform
                  ? `Server confirmed ${platformLabel(detected)}.`
                  : `The server reports ${platformLabel(detected)}. Switch the picker so the right build is uploaded.`}
              </span>
            )}
            {!detecting && !detected && detectNote && (
              <span className="rsw-hint" title={detectNote}>
                Couldn&apos;t auto-detect the server&apos;s OS. Pick it manually.
              </span>
            )}
          </div>

          {/* The server binary for the TARGET OS is the one hard prerequisite
              this flow has, and it used to surface only as a failed deploy.
              Now it is stated up front, with the fix as a button: a packaged
              install carries only its own OS's build, so anything cross-OS is
              a download away rather than a Rust toolchain away. */}
          {(() => {
            const notice = binaryNotice(platform, binaryStatus, hostOs);
            if (notice.kind === 'none') return null;
            if (notice.kind === 'ready') {
              return <p className="rsw-desc rsw-hint-ok">{notice.text}</p>;
            }
            if (notice.kind === 'blocked') {
              return <p className="rsw-desc rsw-warn">{notice.text}</p>;
            }
            return (
              <div className="rsw-binary rsw-field-wide">
                <p className="rsw-desc rsw-warn">{notice.text}</p>
                <button
                  type="button"
                  className="rsw-btn"
                  onClick={() => void downloadServerBuild()}
                  disabled={downloading || busy}
                >
                  {downloading ? 'Downloading…' : notice.action}
                </button>
              </div>
            );
          })()}
          <label className="rsw-field rsw-field-wide">
            <span className="rsw-label">Host</span>
            <input
              className="rsw-input"
              placeholder="vps.example.com or 1.2.3.4"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
          </label>

          <label className="rsw-field">
            <span className="rsw-label">SSH username</span>
            <input
              className="rsw-input"
              placeholder="root or your user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="rsw-field">
            <span className="rsw-label">SSH port</span>
            <input
              className="rsw-input"
              value={sshPort}
              inputMode="numeric"
              onChange={(e) => setSshPort(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="rsw-field rsw-field-wide">
            <span className="rsw-label">SSH key path (optional)</span>
            <input
              className="rsw-input"
              placeholder="Leave empty to use ssh-agent / default keys"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="rsw-field">
            <span className="rsw-label">Workspace folder</span>
            <input
              className="rsw-input"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              title="Folder created in your home directory; the server's --workspace root"
            />
          </label>

          <label className="rsw-field">
            <span className="rsw-label">Server port</span>
            <input
              className="rsw-input"
              value={serverPort}
              inputMode="numeric"
              onChange={(e) => setServerPort(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </div>

        <p className="rsw-desc">{PLATFORM_HINTS[platform]}</p>

        {/* The deploy ends on a plaintext `ws://` connection whose token grants
            full shell execution on the box, and the server binds 0.0.0.0. That
            is the right default *behind something that encrypts for you*, and a
            trap on an open network — so the flow says so at the point of
            decision rather than only in the server's stdout and the docs. */}
        <p className="rsw-desc rsw-warn">
          The connection is unencrypted (<code>ws://</code>) and its token grants shell access to
          this box. Reach it over Tailscale, a VPN, or an SSH tunnel, never the open internet. For a
          publicly reachable server, restart it with <code>--cert</code>/<code>--key</code> and save
          the remote as <code>wss://</code>.
        </p>

        {error && <div className="rsw-error" role="alert">{error}</div>}
        {busy && <div className="rsw-status" aria-live="polite">{stage}</div>}

        <div className="rsw-actions">
          <button type="button" className="rsw-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="rsw-btn rsw-btn-primary"
            // Only a *definite* "no binary" blocks the button. A status of null
            // (not checked, or the check itself failed) must stay deployable —
            // the resolver runs again inside the deploy and reports properly.
            disabled={
              busy ||
              downloading ||
              !host.trim() ||
              !username.trim() ||
              binaryStatus?.available === false
            }
            title={
              binaryStatus?.available === false
                ? `Download the ${platformLabel(platform)} server first.`
                : undefined
            }
          >
            {busy ? 'Deploying…' : 'Deploy & connect'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
