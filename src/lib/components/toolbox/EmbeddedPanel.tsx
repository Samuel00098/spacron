import { useEffect, useMemo, useState } from 'react';
import { get } from '$lib/stores/storeCompat';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { openUrlInPreviewPanel } from '$lib/stores/preview';
import { clampHorizontalScroll } from '$lib/actions/clampHorizontalScroll';
import { useStore } from '$lib/react/useStore';
import { useAction } from '$lib/react/useAction';
import { useProjectPanelState } from '$lib/react/useProjectPanelState';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import { embeddedRuns, runEmbeddedCommand } from '$lib/stores/embeddedRun';
import { parseBoardListJson } from '$lib/services/embeddedCommand';
import './EmbeddedPanel.css';

type EmbeddedMode = 'arduino' | 'platformio' | 'pi';
type CommandAction = {
  label: string;
  command: string;
  tone?: 'primary' | 'warning';
  interactive?: boolean;
  success?: string;
};

// Shows e.g. "uploading…" while a command runs, the way the Arduino IDE labels
// the moment between "compile" and the green "Upload complete".
function runningLabel(item: CommandAction) {
  const l = item.label.toLowerCase();
  if (l.startsWith('upload')) return 'Uploading…';
  if (l.startsWith('compile') || l.startsWith('build')) return 'Building…';
  if (l.startsWith('detect') || l.startsWith('list')) return 'Scanning…';
  if (l.startsWith('copy')) return 'Copying to Pi…';
  if (l.startsWith('sync')) return 'Syncing to Pi…';
  if (l.includes('serial monitor')) return 'Live — close terminal to stop';
  return 'Running…';
}

type ConnectionState = {
  status: 'idle' | 'checking' | 'connected' | 'none' | 'error';
  detail: string;
};

const IDLE_CONNECTION: ConnectionState = { status: 'idle', detail: '' };

export default function EmbeddedPanel() {
  const project = useStore(activeProject);
  const runs = useStore(embeddedRuns);
  const modeTabsRef = useAction<HTMLDivElement>(clampHorizontalScroll);

  const [mode, setMode] = useProjectPanelState<EmbeddedMode>('embedded.mode', 'arduino');

  const [arduinoFqbn, setArduinoFqbn] = useProjectPanelState('embedded.arduinoFqbn', 'arduino:avr:uno');
  const [arduinoPort, setArduinoPort] = useProjectPanelState('embedded.arduinoPort', 'COM3');
  const [arduinoBaud, setArduinoBaud] = useProjectPanelState('embedded.arduinoBaud', '115200');

  const [platformioBoard, setPlatformioBoard] = useProjectPanelState('embedded.platformioBoard', 'uno');

  const [piUser, setPiUser] = useProjectPanelState('embedded.piUser', 'pi');
  const [piHost, setPiHost] = useProjectPanelState('embedded.piHost', 'raspberrypi.local');
  const [piPath, setPiPath] = useProjectPanelState('embedded.piPath', '~/spacron-project');

  // Per-mode connectivity (is a board/Pi actually reachable right now?). The
  // probe runs in a hidden background terminal — it never shows up in the
  // terminal room — every time you open the tab, and again on "Recheck".
  const [connection, setConnection] = useState<Record<EmbeddedMode, ConnectionState>>({
    arduino: IDLE_CONNECTION,
    platformio: IDLE_CONNECTION,
    pi: IDLE_CONNECTION,
  });
  const [probeTick, setProbeTick] = useState(0);

  const modeTitle =
    mode === 'arduino' ? 'Arduino CLI' : mode === 'platformio' ? 'PlatformIO' : 'Raspberry Pi';

  const activeRoot = project?.root_path ?? null;

  const arduinoCommands = useMemo<CommandAction[]>(
    () => [
      { label: 'Detect boards', command: 'arduino-cli board list --format json', success: 'Boards scanned — check terminal' },
      {
        label: 'Install AVR core',
        command: 'arduino-cli core update-index; arduino-cli core install arduino:avr',
        success: 'AVR core installed',
      },
      {
        label: 'Compile',
        command: `arduino-cli compile --fqbn ${arduinoFqbn.trim() || 'arduino:avr:uno'} .`,
        tone: 'primary',
        success: 'Sketch compiled successfully ✓',
      },
      {
        label: 'Upload',
        command: `arduino-cli upload -p ${arduinoPort.trim() || 'COM3'} --fqbn ${arduinoFqbn.trim() || 'arduino:avr:uno'} .`,
        tone: 'primary',
        success: 'Done uploading ✓',
      },
      {
        label: 'Serial monitor',
        command: `arduino-cli monitor -p ${arduinoPort.trim() || 'COM3'} -c baudrate=${arduinoBaud.trim() || '115200'}`,
        tone: 'warning',
        interactive: true,
      },
    ],
    [arduinoFqbn, arduinoPort, arduinoBaud],
  );

  const platformioCommands = useMemo<CommandAction[]>(
    () => [
      { label: 'Create project', command: `pio project init --board ${platformioBoard.trim() || 'uno'}`, success: 'PlatformIO project created' },
      { label: 'Build', command: 'pio run', tone: 'primary', success: 'Build finished ✓' },
      { label: 'Upload', command: 'pio run -t upload', tone: 'primary', success: 'Done uploading ✓' },
      {
        label: 'Serial monitor',
        command: `pio device monitor -b ${arduinoBaud.trim() || '115200'}`,
        tone: 'warning',
        interactive: true,
      },
      { label: 'List devices', command: 'pio device list' },
    ],
    [platformioBoard, arduinoBaud],
  );

  const piTarget = `${piUser.trim() || 'pi'}@${piHost.trim() || 'raspberrypi.local'}`;
  const piCommands = useMemo<CommandAction[]>(
    () => [
      {
        label: 'Copy project to Pi',
        command: `ssh ${piTarget} "mkdir -p ${piPath.trim() || '~/spacron-project'}" && scp -r . ${piTarget}:${piPath.trim() || '~/spacron-project'}`,
        tone: 'primary',
        success: 'Sent to Pi ✓',
      },
      {
        label: 'Sync project to Pi',
        command: `rsync -av --exclude node_modules --exclude .git ./ ${piTarget}:${piPath.trim() || '~/spacron-project'}/`,
        tone: 'primary',
        success: 'Synced to Pi ✓',
      },
      {
        label: 'Run remote shell',
        command: `ssh ${piTarget} "cd ${piPath.trim() || '~/spacron-project'} && bash"`,
      },
      {
        label: 'Reset Pi (reboot)',
        command: `ssh ${piTarget} "sudo reboot"`,
        tone: 'warning',
        success: 'Reboot command sent to Pi',
      },
    ],
    [piTarget, piPath],
  );

  const visibleCommands =
    mode === 'arduino' ? arduinoCommands : mode === 'platformio' ? platformioCommands : piCommands;

  const setupByMode: Record<
    EmbeddedMode,
    { tools: string; install: string; guide?: { label: string; url: string }; note?: string }
  > = {
    arduino: {
      tools: 'Arduino CLI (arduino-cli)',
      install: 'winget install ArduinoSA.CLI',
      guide: {
        label: 'Official install guide (arduino.github.io)',
        url: 'https://arduino.github.io/arduino-cli/latest/installation/',
      },
    },
    platformio: {
      tools: 'PlatformIO Core (pio)',
      install: 'pip install platformio',
      guide: {
        label: 'Official install guide (docs.platformio.org)',
        url: 'https://docs.platformio.org/en/latest/core/installation/',
      },
      note: 'Run the install once, then everything below needs no extra setup.',
    },
    pi: {
      tools: 'OpenSSH client (ssh, scp)',
      install: 'Workstation side is built in on Win 10/11 and macOS; enable SSH on the Pi with raspi-config and have your SSH key ready.',
      guide: {
        label: 'Raspberry Pi remote access docs',
        url: 'https://www.raspberrypi.com/documentation/computers/remote-access.html',
      },
      note: 'rsync (utils on the Pi; part of Git Bash useful for Windows) makes the Sync action work; Copy works without it.',
    },
  };

  function runKey(item: CommandAction) {
    return `${mode}:${item.label}`;
  }

  async function copyCommand(command: string) {
    const value = command.trim();
    if (!value) return;

    try {
      await copyTextToClipboard(value);
      showToast('Command copied', 'info');
    } catch (err) {
      showToast(`Copy failed: ${err}`, 'error');
    }
  }

  async function probeConnection(targetMode: EmbeddedMode) {
    const proj = get(activeProject);
    if (!proj) {
      setConnection((c) => ({ ...c, [targetMode]: IDLE_CONNECTION }));
      return;
    }

    setConnection((c) => ({
      ...c,
      [targetMode]: { status: 'checking', detail: '' },
    }));

    const command =
      targetMode === 'arduino'
        ? 'arduino-cli board list --format json'
        : `ssh -o BatchMode=yes -o ConnectTimeout=4 ${piTarget} "echo ok"`;

    const result = await runEmbeddedCommand({
      key: `${targetMode}:Connection probe`,
      command,
      label: 'Check connection',
      background: true,
      notify: false,
      timeoutMs: 15 * 1000,
    });

    setConnection((c) => {
      const state = { ...c };
      if (targetMode === 'arduino') {
        if (result.exitCode !== 0) {
          const out = (result.output ?? '').toLowerCase();
          const missingCli = /not (recognized|found)|command not found/i.test(out);
          state.arduino = {
            status: 'error',
            detail: missingCli ? 'arduino-cli not installed — see setup below' : 'Failed to query boards — see terminal',
          };
        } else {
          const detected = parseBoardListJson(result.output ?? '');
          state.arduino = detected
            ? { status: 'connected', detail: `${detected.name ?? 'Board'} on ${detected.port}` }
            : { status: 'none', detail: 'No board detected — is it plugged in?' };
        }
      } else if (targetMode === 'pi') {
        state.pi =
          result.exitCode === 0
            ? { status: 'connected', detail: `${piTarget} reachable` }
            : { status: 'error', detail: 'Not reachable — check host, IP and SSH key' };
      }
      return state;
    });
  }

  // Check connection for the active Arduino/Pi tab whenever it becomes visible,
  // the project changes, or the user hits Recheck. PlatformIO shares the same
  // hardware as Arduino so it has no probe of its own.
  useEffect(() => {
    if (mode === 'platformio') return;
    probeConnection(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, project?.id, probeTick]);

  async function runCommand(item: CommandAction) {
    const value = item.command.trim();
    if (!value) return;

    const proj = get(activeProject);
    if (!proj) {
      showToast('Open a project before running embedded commands', 'warning');
      return;
    }

    const result = await runEmbeddedCommand({
      key: runKey(item),
      command: value,
      label: item.label,
      interactive: item.interactive,
      successMessage: item.success,
    });

    // Auto-apply the detected board+port straight into the config, the way the
    // Arduino IDE's port picker settles on the one board that's actually there.
    if (item.label === 'Detect boards' && result.output) {
      const detected = parseBoardListJson(result.output);
      if (detected) {
        if (detected.fqbn) setArduinoFqbn(detected.fqbn);
        if (detected.port) setArduinoPort(detected.port);
        setConnection((c) => ({
          ...c,
          arduino: { status: 'connected', detail: `${detected.name ?? 'Board'} on ${detected.port}` },
        }));
        showToast(
          `Detected ${detected.name ?? 'a board'} on ${detected.port}`,
          'success',
          5000,
          true,
        );
      } else {
        showToast('No board detected yet — is it plugged in?', 'info');
      }
    }
  }

  const conn = connection[mode];
  const setup = setupByMode[mode];
  const guide = setup.guide ?? null;

  return (
    <div className="embedded-panel">
      <div className="embedded-toolbar">
        <div className="mode-tabs" aria-label="Embedded workflow" ref={modeTabsRef}>
          <button className={mode === 'arduino' ? 'active' : ''} onClick={() => setMode('arduino')}>
            Arduino
          </button>
          <button className={mode === 'platformio' ? 'active' : ''} onClick={() => setMode('platformio')}>
            PlatformIO
          </button>
          <button className={mode === 'pi' ? 'active' : ''} onClick={() => setMode('pi')}>
            Raspberry Pi
          </button>
        </div>
        <div className="toolbar-status">
          <div className="project-chip" title={activeRoot ?? 'No project open'}>
            {activeRoot ? 'Project ready' : 'No project'}
          </div>
          {mode !== 'platformio' && (
            <div className="embedded-connection">
              {conn.status === 'checking' ? (
                <span className="embedded-status checking" role="status">
                  <span className="embedded-status-dot" aria-hidden="true" />
                  Checking…
                </span>
              ) : conn.status === 'connected' ? (
                <span className="embedded-status success" role="status">
                  <span className="embedded-status-dot" aria-hidden="true" />
                  Connected — {conn.detail}
                </span>
              ) : conn.status === 'none' ? (
                <span className="embedded-status idle" role="status">
                  <span className="embedded-status-dot" aria-hidden="true" />
                  {conn.detail || 'No device'}
                </span>
              ) : (
                <span className="embedded-status error" role="status">
                  <span className="embedded-status-dot" aria-hidden="true" />
                  {conn.detail || 'Connection unknown'}
                </span>
              )}
              <button className="recheck-btn" onClick={() => setProbeTick((t) => t + 1)}>
                Recheck
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="embedded-setup" role="note">
        <span className="embedded-setup-tag">First-time setup</span>
        <p>
          This tab needs <strong>{setup.tools}</strong> installed. On Windows run{' '}
          <code>{setup.install}</code>
          {guide ? (
            <>
              {' '}
              — open the{' '}
              <a
                className="embedded-guide-link"
                href={guide.url}
                onClick={(e) => {
                  e.preventDefault();
                  void openUrlInPreviewPanel(guide.url);
                }}
              >
                {guide.label}
              </a>{' '}
              for full instructions
            </>
          ) : (
            ''
          )}
          . {setup.note ?? 'Install once, then everything on this tab works.'}
        </p>
      </div>

      <section className="embedded-config">
        <div className="section-heading">
          <span>{modeTitle}</span>
          <span>{visibleCommands.length} actions</span>
        </div>

        {mode === 'arduino' ? (
          <>
            <div className="field-grid">
              <label>
                <span>Board FQBN</span>
                <input value={arduinoFqbn} onChange={(e) => setArduinoFqbn(e.target.value)} placeholder="arduino:avr:uno" />
              </label>
              <label>
                <span>Port</span>
                <input value={arduinoPort} onChange={(e) => setArduinoPort(e.target.value)} placeholder="COM3" />
              </label>
              <label>
                <span>Baud</span>
                <input value={arduinoBaud} onChange={(e) => setArduinoBaud(e.target.value)} placeholder="115200" inputMode="numeric" />
              </label>
            </div>
            <p className="embedded-hint">
              Click <strong>Detect boards</strong> (or use <strong>Recheck</strong>) and Spacron
              fills in the port and board of the Arduino that's actually plugged in — then{' '}
              <strong>Upload</strong> flashes the sketch from this project directly to the
              microcontroller, no Arduino app needed. The status dot beside "Project ready"
              turns green when a board is detected.
            </p>
          </>
        ) : mode === 'platformio' ? (
          <div className="field-grid">
            <label>
              <span>Board ID</span>
              <input value={platformioBoard} onChange={(e) => setPlatformioBoard(e.target.value)} placeholder="uno" />
            </label>
            <label>
              <span>Baud</span>
              <input value={arduinoBaud} onChange={(e) => setArduinoBaud(e.target.value)} placeholder="115200" inputMode="numeric" />
            </label>
          </div>
        ) : (
          <div className="field-grid">
            <label>
              <span>User</span>
              <input value={piUser} onChange={(e) => setPiUser(e.target.value)} placeholder="pi" />
            </label>
            <label>
              <span>Host</span>
              <input value={piHost} onChange={(e) => setPiHost(e.target.value)} placeholder="raspberrypi.local" />
            </label>
            <label className="wide">
              <span>Remote path</span>
              <input value={piPath} onChange={(e) => setPiPath(e.target.value)} placeholder="~/spacron-project" />
            </label>
          </div>
        )}
      </section>

      <section className="command-list scrollable">
        {visibleCommands.map((item, i) => {
          const run = runs[runKey(item)];
          const status = run?.status ?? 'idle';
          return (
            <article
              key={`${item.label}-${i}`}
              className={`command-item${item.tone === 'primary' ? ' primary' : ''}${item.tone === 'warning' ? ' warning' : ''}${status === 'running' ? ' running' : ''}`}
            >
              <div className="command-main">
                <div className="command-label">{item.label}</div>
                <code>{item.command}</code>
                {status === 'running' && (
                  <div className="embedded-status running" role="status">
                    <span className="embedded-status-dot" aria-hidden="true" />
                    {runningLabel(item)}
                  </div>
                )}
                {status === 'success' && (
                  <div className="embedded-status success">
                    ✓ {item.success ?? `${item.label} finished`}
                    {run?.exitCode !== null && run?.exitCode !== undefined ? ` (exit ${run.exitCode})` : ''}
                  </div>
                )}
                {status === 'error' && (
                  <div className="embedded-status error">
                    ✗ {item.label} failed
                    {run?.exitCode !== null && run?.exitCode !== undefined ? ` (exit ${run.exitCode})` : ' — see terminal'}
                  </div>
                )}
              </div>
              <div className="command-actions">
                <button
                  className="icon-btn"
                  title="Copy command"
                  aria-label={`Copy ${item.label} command`}
                  onClick={() => copyCommand(item.command)}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
                  </svg>
                </button>
                <button className="run-btn" title="Run in terminal" onClick={() => runCommand(item)}>
                  {status === 'running' ? runningLabel(item) : 'Run'}
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}