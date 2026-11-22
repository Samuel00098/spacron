import { useState, useCallback } from 'react';
import { useStore } from '$lib/react/useStore';
import {
  browserDefaultPort,
  browserPreferredHost,
  browserThemeMode,
  browserOpenLinksIn,
  browserOpenLinksInBackground,
  browserDesignModeAutoScreenshot,
  browserDesignModeIncludeStyles,
  browserDesignModeIncludeHtml,
  browserDesignModeMaxHtmlLength,
  browserConsoleAutoOpenOnError,
  browserConsolePreserveLog,
  browserDefaultZoom,
  browserDefaultViewport,
  previewPlacement,
  type BrowserThemeMode,
  type BrowserLinkRouting,
  type PreviewPlacement,
} from '$lib/stores/settings';
import { clearPreviewData } from '$lib/stores/preview';
import { clearBrowsingHistory } from '$lib/stores/previewHistory';
import { showToast } from '$lib/stores/notification';

function settingsSearchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function SettingRow({
  title,
  searchKey,
  detail,
  children,
}: {
  title: string | React.ReactNode;
  searchKey?: string;
  detail?: string;
  children: React.ReactNode;
}) {
  const key = searchKey ?? (typeof title === 'string' ? settingsSearchKey(title) : '');
  return (
    <div className="settings-control-row" data-settings-key={key}>
      <div className="settings-control-copy">
        <span>{title}</span>
        {detail && <small>{detail}</small>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-card" data-settings-section={settingsSearchKey(title)}>
      <h3>{title}</h3>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle${checked ? ' active' : ''}`}
      disabled={disabled}
      style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
      onClick={() => onChange(!checked)}
      aria-label={label}
      aria-pressed={checked}
    >
      <span />
    </button>
  );
}

export default function BrowserSettingsSection() {
  const defaultPort = useStore(browserDefaultPort);
  const preferredHost = useStore(browserPreferredHost);
  const themeMode = useStore(browserThemeMode);
  const openLinksIn = useStore(browserOpenLinksIn);
  const openLinksInBackground = useStore(browserOpenLinksInBackground);
  const autoScreenshot = useStore(browserDesignModeAutoScreenshot);
  const includeStyles = useStore(browserDesignModeIncludeStyles);
  const includeHtml = useStore(browserDesignModeIncludeHtml);
  const maxHtmlLength = useStore(browserDesignModeMaxHtmlLength);
  const consoleAutoOpen = useStore(browserConsoleAutoOpenOnError);
  const consolePreserveLog = useStore(browserConsolePreserveLog);
  const defaultZoom = useStore(browserDefaultZoom);
  const defaultViewport = useStore(browserDefaultViewport);
  const placement = useStore(previewPlacement);

  const [clearingCache, setClearingCache] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  const handleClearCache = useCallback(async () => {
    setClearingCache(true);
    try {
      await clearPreviewData();
    } finally {
      setClearingCache(false);
    }
  }, []);

  const handleClearHistory = useCallback(() => {
    setClearingHistory(true);
    try {
      clearBrowsingHistory();
      showToast('Browsing history cleared', 'success');
    } finally {
      setClearingHistory(false);
    }
  }, []);

  const handleResetDefaults = useCallback(() => {
    browserDefaultPort.set(3000);
    browserPreferredHost.set('localhost');
    browserThemeMode.set('system');
    browserOpenLinksIn.set('preview');
    browserOpenLinksInBackground.set('preview' as any === false ? false : false);
    browserDesignModeAutoScreenshot.set(true);
    browserDesignModeIncludeStyles.set(true);
    browserDesignModeIncludeHtml.set(true);
    browserDesignModeMaxHtmlLength.set(2000);
    browserConsoleAutoOpenOnError.set(false);
    browserConsolePreserveLog.set(false);
    browserDefaultZoom.set('fit');
    browserDefaultViewport.set('desktop');
    previewPlacement.set('sidebar');
    showToast('Browser settings reset to defaults', 'success');
  }, []);

  return (
    <>
      <Section title="Dev server & Connection">
        <SettingRow
          title="Default port"
          detail="The local dev port Spacron defaults to when opening a project or starting preview."
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="number"
              min={1}
              max={65535}
              value={defaultPort || ''}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val > 0 && val <= 65535) {
                  browserDefaultPort.set(val);
                }
              }}
              style={{
                width: '84px',
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                fontSize: '13px',
              }}
            />
            <div style={{ display: 'flex', gap: '4px' }}>
              {[3000, 5173, 8000, 8080].map((port) => (
                <button
                  key={port}
                  type="button"
                  onClick={() => browserDefaultPort.set(port)}
                  className="settings-secondary"
                  style={{
                    padding: '3px 7px',
                    fontSize: '11px',
                    fontWeight: defaultPort === port ? 600 : 400,
                    borderColor: defaultPort === port ? 'var(--accent)' : undefined,
                    color: defaultPort === port ? 'var(--accent)' : undefined,
                  }}
                >
                  {port}
                </button>
              ))}
            </div>
          </div>
        </SettingRow>

        <SettingRow
          title="Preferred local host"
          detail="Host format used when building preview addresses."
        >
          <select
            value={preferredHost}
            onChange={(e) => browserPreferredHost.set(e.target.value as 'localhost' | '127.0.0.1')}
            aria-label="Preferred local host"
          >
            <option value="localhost">localhost</option>
            <option value="127.0.0.1">127.0.0.1</option>
          </select>
        </SettingRow>

        <SettingRow
          title="Initial panel placement"
          detail="Where a newly opened preview panel is docked."
        >
          <select
            value={placement}
            onChange={(e) => previewPlacement.set(e.target.value as PreviewPlacement)}
            aria-label="Initial panel placement"
          >
            <option value="sidebar">Sidebar (Right utility drawer)</option>
            <option value="room">Stage room (Full workspace tab)</option>
          </select>
        </SettingRow>
      </Section>

      <Section title="Appearance & Themes">
        <SettingRow
          title="Browser color scheme"
          detail="Decouples preview pages from the application theme. Allows testing dark and light sites independently."
        >
          <select
            value={themeMode}
            onChange={(e) => browserThemeMode.set(e.target.value as BrowserThemeMode)}
            aria-label="Browser color scheme"
          >
            <option value="system">Follow application theme</option>
            <option value="light">Force light mode</option>
            <option value="dark">Force dark mode</option>
          </select>
        </SettingRow>

        <SettingRow
          title="Default device viewport"
          detail="Initial device emulation size when opening preview."
        >
          <select
            value={defaultViewport}
            onChange={(e) => browserDefaultViewport.set(e.target.value)}
            aria-label="Default device viewport"
          >
            <option value="desktop">Desktop (1280 × 800)</option>
            <option value="phone">Phone (iPhone 14 / 15 · 393 × 852)</option>
            <option value="tablet">Tablet (iPad · 820 × 1180)</option>
          </select>
        </SettingRow>

        <SettingRow
          title="Default zoom"
          detail="Initial zoom scale for preview viewports."
        >
          <select
            value={defaultZoom}
            onChange={(e) => browserDefaultZoom.set(e.target.value)}
            aria-label="Default zoom"
          >
            <option value="fit">Auto-fit to panel</option>
            <option value="100">100% (Actual size)</option>
            <option value="75">75%</option>
            <option value="50">50%</option>
          </select>
        </SettingRow>
      </Section>

      <Section title="Orca Design Mode">
        <p className="shell-hint" style={{ marginTop: 0, marginBottom: '14px' }}>
          Orca-style visual inspection that connects elements directly to your AI coding agents, eliminating ambiguity in frontend UI edits.
        </p>

        <SettingRow
          title="Auto-capture element screenshots"
          detail="Automatically captures a cropped visual snapshot when clicking an element in Design Mode."
        >
          <Toggle
            label="Auto-capture element screenshots"
            checked={autoScreenshot}
            onChange={browserDesignModeAutoScreenshot.set}
          />
        </SettingRow>

        <SettingRow
          title="Include computed CSS styles"
          detail="Packages essential layout, spacing, colors, and typography into the element context."
        >
          <Toggle
            label="Include computed CSS styles"
            checked={includeStyles}
            onChange={browserDesignModeIncludeStyles.set}
          />
        </SettingRow>

        <SettingRow
          title="Include raw HTML snippet"
          detail="Includes the element's outerHTML snippet in the prompt sent to the AI agent."
        >
          <Toggle
            label="Include raw HTML snippet"
            checked={includeHtml}
            onChange={browserDesignModeIncludeHtml.set}
          />
        </SettingRow>

        <SettingRow
          title="Max HTML snippet characters"
          detail="Upper character limit for the included HTML snippet to keep prompts concise."
        >
          <select
            value={maxHtmlLength}
            onChange={(e) => browserDesignModeMaxHtmlLength.set(parseInt(e.target.value, 10))}
            aria-label="Max HTML snippet length"
          >
            <option value={1000}>1,000 characters</option>
            <option value={2000}>2,000 characters (Recommended)</option>
            <option value={3000}>3,000 characters</option>
            <option value={5000}>5,000 characters</option>
          </select>
        </SettingRow>
      </Section>

      <Section title="Link routing & Tabs">
        <SettingRow
          title="Open web links in"
          detail="Where links clicked in terminal sessions or agent chats are opened."
        >
          <select
            value={openLinksIn}
            onChange={(e) => browserOpenLinksIn.set(e.target.value as BrowserLinkRouting)}
            aria-label="Open web links in"
          >
            <option value="preview">Built-in Preview Browser</option>
            <option value="external">System Default Browser</option>
          </select>
        </SettingRow>

        <SettingRow
          title="Open in background"
          detail="Open clicked links in background tabs without immediately stealing focus."
        >
          <Toggle
            label="Open in background"
            checked={openLinksInBackground}
            onChange={browserOpenLinksInBackground.set}
          />
        </SettingRow>
      </Section>

      <Section title="Console & Diagnostics">
        <SettingRow
          title="Auto-open on error"
          detail="Automatically open the preview console drawer when JavaScript errors occur."
        >
          <Toggle
            label="Auto-open console on error"
            checked={consoleAutoOpen}
            onChange={browserConsoleAutoOpenOnError.set}
          />
        </SettingRow>

        <SettingRow
          title="Preserve log"
          detail="Keep console logs across page reloads and internal navigations."
        >
          <Toggle
            label="Preserve log"
            checked={consolePreserveLog}
            onChange={browserConsolePreserveLog.set}
          />
        </SettingRow>
      </Section>

      <Section title="Data, Cache & History">
        <SettingRow
          title="Preview cookies & cache"
          detail="Clear all stored cookies, localStorage data, and cached resources for previewed sites."
        >
          <button
            type="button"
            className="settings-secondary"
            onClick={handleClearCache}
            disabled={clearingCache}
          >
            {clearingCache ? 'Clearing…' : 'Clear cookies & cache'}
          </button>
        </SettingRow>

        <SettingRow
          title="Browsing history"
          detail="Clear the list of previously visited web addresses in the preview address bar."
        >
          <button
            type="button"
            className="settings-secondary"
            onClick={handleClearHistory}
            disabled={clearingHistory}
          >
            {clearingHistory ? 'Clearing…' : 'Clear history'}
          </button>
        </SettingRow>

        <div className="settings-action-row" style={{ marginTop: '16px' }}>
          <button
            type="button"
            className="settings-secondary"
            onClick={handleResetDefaults}
          >
            Reset browser settings to defaults
          </button>
        </div>
      </Section>
    </>
  );
}
