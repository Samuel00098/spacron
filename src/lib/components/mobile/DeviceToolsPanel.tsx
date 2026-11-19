import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Dropdown from '$lib/components/shared/Dropdown.tsx';

// The device "Tools" panel: app control, emulator settings, accessibility,
// location and permissions for the device on screen. Android goes through adb,
// the iOS Simulator through `xcrun simctl` (see `commands/device_tools.rs`).
// Controls a platform cannot do are left out rather than shown dead.

export type DevicePlatform = 'android' | 'ios';

interface ToolsState {
  foreground: string | null;
  appearance: string | null;
  text_size: string | null;
  reduce_motion: boolean | null;
  network: boolean | null;
  layout_bounds: boolean | null;
}

const ANDROID_TEXT_SIZES = [
  { value: '0.85', label: 'Small' },
  { value: '1.0', label: 'Default' },
  { value: '1.15', label: 'Large' },
  { value: '1.3', label: 'Largest' },
];

const IOS_TEXT_SIZES = [
  { value: 'extra-small', label: 'Extra small' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Default' },
  { value: 'extra-large', label: 'Large' },
  { value: 'extra-extra-large', label: 'Extra large' },
  { value: 'extra-extra-extra-large', label: 'Largest' },
  { value: 'accessibility-large', label: 'Accessibility large' },
  { value: 'accessibility-extra-extra-extra-large', label: 'Accessibility largest' },
];

const ORIENTATIONS = ['Portrait', 'Landscape', 'Portrait (upside down)', 'Landscape (reversed)'];

const LOCATION_PRESETS = [
  { value: '37.7749,-122.4194', label: 'San Francisco' },
  { value: '40.7128,-74.0060', label: 'New York' },
  { value: '51.5074,-0.1278', label: 'London' },
  { value: '6.5244,3.3792', label: 'Lagos' },
  { value: '35.6762,139.6503', label: 'Tokyo' },
  { value: '-33.8688,151.2093', label: 'Sydney' },
];

const ANDROID_PERMISSIONS = [
  { value: 'camera', label: 'Camera' },
  { value: 'microphone', label: 'Microphone' },
  { value: 'location', label: 'Location' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'photos', label: 'Photos' },
  { value: 'notifications', label: 'Notifications' },
];

const IOS_PERMISSIONS = [
  { value: 'camera', label: 'Camera' },
  { value: 'microphone', label: 'Microphone' },
  { value: 'location', label: 'Location' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'photos', label: 'Photos' },
  { value: 'reminders', label: 'Reminders' },
  { value: 'motion', label: 'Motion' },
];

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`device-tools-switch${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
      disabled={disabled}
    >
      <span className="device-tools-switch-knob" />
    </button>
  );
}

export default function DeviceToolsPanel({
  platform,
  target,
  isEmulator,
  orientation,
  onRotateTo,
  onClose,
  onError,
  onNotice,
  streamSettings,
}: {
  platform: DevicePlatform;
  /** adb serial or simulator UDID. */
  target: string;
  /** Android: whether this is an emulator (location needs one). */
  isEmulator: boolean;
  orientation: number;
  onRotateTo: (index: number) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** The live-stream controls (size, Live/Snapshot), shown in their own section. */
  streamSettings?: ReactNode;
}) {
  const [state, setState] = useState<ToolsState | null>(null);
  const [app, setApp] = useState('');
  const [url, setUrl] = useState('');
  const [launchId, setLaunchId] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [permission, setPermission] = useState('camera');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<ToolsState>('device_tools_state', { platform, target });
      setState(next);
      if (next.foreground) setApp((current) => current || next.foreground || '');
    } catch (e) {
      onError(String(e));
    }
  }, [platform, target]);

  useEffect(() => {
    setState(null);
    setApp('');
    void refresh();
  }, [refresh]);

  /** Run one device command, reporting failure and re-reading the state. */
  async function run(key: string, command: string, args: Record<string, unknown>, done?: string) {
    setBusy(key);
    try {
      await invoke(command, { platform, target, ...args });
      if (done) onNotice(done);
      await refresh();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const appId = app.trim();
  const dark = state?.appearance === 'dark';
  const textSizes = platform === 'ios' ? IOS_TEXT_SIZES : ANDROID_TEXT_SIZES;
  const currentTextSize = platform === 'ios'
    ? state?.text_size ?? 'large'
    : ANDROID_TEXT_SIZES.find((s) => Math.abs(parseFloat(s.value) - parseFloat(state?.text_size ?? '1')) < 0.01)?.value ?? '1.0';
  const permissions = platform === 'ios' ? IOS_PERMISSIONS : ANDROID_PERMISSIONS;
  const canSetLocation = platform === 'ios' || isEmulator;

  function setLocation() {
    const la = parseFloat(lat);
    const ln = parseFloat(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) {
      onError('Enter a latitude and longitude.');
      return;
    }
    void run('location', 'device_set_location', { lat: la, lng: ln }, `Location set to ${la}, ${ln}`);
  }

  return (
    <aside className="device-tools" aria-label="Device tools">
      <header className="device-tools-header">
        <span>Tools</span>
        <button type="button" className="device-tools-close" onClick={onClose} aria-label="Close tools" title="Close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </header>

      <div className="device-tools-body">
        <section className="device-tools-section">
          <h4>App</h4>
          {platform === 'android' && (
            <div className="device-tools-row">
              <span className="device-tools-label">Foreground</span>
              <code className="device-tools-value" title={state?.foreground ?? ''}>{state?.foreground ?? '—'}</code>
            </div>
          )}
          <input
            className="device-tools-input mono"
            value={app}
            onChange={(e) => setApp(e.target.value)}
            placeholder={platform === 'ios' ? 'Bundle id, e.g. com.apple.mobilesafari' : 'Package, e.g. com.example.app'}
            spellCheck={false}
          />
          <div className="device-tools-actions">
            <button type="button" className="device-tools-btn" disabled={!appId || busy !== null} onClick={() => void run('terminate', 'device_app_action', { app: appId, action: 'terminate' }, `Stopped ${appId}`)}>Terminate</button>
            <button type="button" className="device-tools-btn" disabled={!appId || busy !== null} onClick={() => void run('relaunch', 'device_app_action', { app: appId, action: 'relaunch' }, `Relaunched ${appId}`)}>Relaunch</button>
          </div>
          <div className="device-tools-inline">
            <input
              className="device-tools-input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) void run('url', 'device_open_url', { url: url.trim() }); }}
              placeholder="https://… or myapp://"
              spellCheck={false}
            />
            <button type="button" className="device-tools-btn" disabled={!url.trim() || busy !== null} onClick={() => void run('url', 'device_open_url', { url: url.trim() })}>Open</button>
          </div>
          <div className="device-tools-inline">
            <input
              className="device-tools-input mono"
              value={launchId}
              onChange={(e) => setLaunchId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && launchId.trim()) void run('launch', 'device_app_action', { app: launchId.trim(), action: 'launch' }); }}
              placeholder={platform === 'ios' ? 'Bundle id to launch' : 'Package name to launch'}
              spellCheck={false}
            />
            <button type="button" className="device-tools-btn" disabled={!launchId.trim() || busy !== null} onClick={() => void run('launch', 'device_app_action', { app: launchId.trim(), action: 'launch' })}>Launch</button>
          </div>
        </section>

        <section className="device-tools-section">
          <h4>{platform === 'ios' ? 'Simulator' : 'Emulator'}</h4>
          <div className="device-tools-row">
            <span className="device-tools-label">Appearance</span>
            <div className="device-tools-segment" role="radiogroup" aria-label="Appearance">
              <button type="button" role="radio" aria-checked={!dark} className={!dark ? 'active' : ''} onClick={() => void run('appearance', 'device_set_appearance', { dark: false })}>Light</button>
              <button type="button" role="radio" aria-checked={dark} className={dark ? 'active' : ''} onClick={() => void run('appearance', 'device_set_appearance', { dark: true })}>Dark</button>
            </div>
          </div>
          <div className="device-tools-row">
            <span className="device-tools-label">Text size</span>
            <span className="device-tools-control">
              <Dropdown
                options={textSizes}
                value={currentTextSize}
                onChange={(size) => void run('text', 'device_set_text_size', { size })}
                ariaLabel="Text size"
              />
            </span>
          </div>
          <div className="device-tools-row">
            <span className="device-tools-label">Orientation</span>
            <span className="device-tools-control">
              <Dropdown
                options={ORIENTATIONS.map((label, index) => ({ value: String(index), label }))}
                value={String(orientation)}
                onChange={(value) => onRotateTo(Number(value))}
                ariaLabel="Orientation"
              />
            </span>
          </div>
          <div className="device-tools-row">
            <span className="device-tools-label">Reduce Motion</span>
            <Toggle
              label="Reduce Motion"
              on={Boolean(state?.reduce_motion)}
              onChange={(on) => void run('motion', 'device_set_reduce_motion', { on })}
            />
          </div>
          {platform === 'android' && (
            <div className="device-tools-row">
              <span className="device-tools-label">Network</span>
              <Toggle
                label="Network"
                on={state?.network ?? true}
                onChange={(on) => void run('network', 'device_set_network', { on }, on ? 'Wi-Fi and data on' : 'Wi-Fi and data off')}
              />
            </div>
          )}
        </section>

        {platform === 'android' && (
          <section className="device-tools-section">
            <h4>Accessibility</h4>
            <div className="device-tools-row">
              <span className="device-tools-label">Overlay element frames</span>
              <Toggle
                label="Overlay element frames"
                on={Boolean(state?.layout_bounds)}
                onChange={(on) => void run('bounds', 'device_set_layout_bounds', { on })}
              />
            </div>
          </section>
        )}

        <section className="device-tools-section">
          <h4>Location</h4>
          {canSetLocation ? (
            <>
              <div className="device-tools-inline">
                <input className="device-tools-input" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="Latitude" inputMode="decimal" />
                <input className="device-tools-input" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="Longitude" inputMode="decimal" />
              </div>
              <div className="device-tools-inline">
                <span className="device-tools-control grow">
                  <Dropdown
                    options={[{ value: '', label: 'Preset…' }, ...LOCATION_PRESETS]}
                    value=""
                    onChange={(value) => {
                      const [la, ln] = value.split(',');
                      if (la && ln) {
                        setLat(la);
                        setLng(ln);
                      }
                    }}
                    ariaLabel="Location preset"
                  />
                </span>
                <button type="button" className="device-tools-btn" disabled={!lat.trim() || !lng.trim() || busy !== null} onClick={setLocation}>Set</button>
              </div>
            </>
          ) : (
            <p className="device-tools-note">A USB device uses its real GPS; location can only be set on an emulator.</p>
          )}
        </section>

        <section className="device-tools-section">
          <h4>Permissions</h4>
          <input
            className="device-tools-input mono"
            value={app}
            onChange={(e) => setApp(e.target.value)}
            placeholder={platform === 'ios' ? 'Bundle id' : 'Package name'}
            spellCheck={false}
          />
          <div className="device-tools-inline">
            <span className="device-tools-control grow">
              <Dropdown options={permissions} value={permission} onChange={setPermission} ariaLabel="Permission" />
            </span>
            <button type="button" className="device-tools-btn" disabled={!appId || busy !== null} onClick={() => void run('grant', 'device_set_permission', { app: appId, permission, grant: true }, `Granted ${permission} to ${appId}`)}>Grant</button>
          </div>
          <div className="device-tools-actions">
            <button type="button" className="device-tools-btn" disabled={!appId || busy !== null} onClick={() => void run('revoke', 'device_set_permission', { app: appId, permission, grant: false }, `Revoked ${permission} from ${appId}`)}>Revoke</button>
          </div>
        </section>

        {streamSettings && (
          <section className="device-tools-section">
            <h4>Stream</h4>
            {streamSettings}
          </section>
        )}
      </div>
    </aside>
  );
}
