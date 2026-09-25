'use client';

import { FormEvent, useEffect, useState } from 'react';
import type { LicensingMode } from '@/lib/license';

const PLATFORMS = [
  { key: 'windows', label: 'Windows', sub: 'x64 .exe' },
  { key: 'windows-arm64', label: 'Windows on ARM', sub: 'ARM64 .exe' },
  { key: 'mac', label: 'macOS', sub: 'Apple Silicon .dmg' },
  { key: 'linux', label: 'Linux', sub: '.AppImage' },
] as const;

// The key itself is never stored; only the device name and which activation
// this browser owns, so a return visit re-validates instead of using up
// another activation slot.
const LS_DEVICE = 'spacron.deviceName';
const LS_ACTIVATION = 'spacron.activation';
const LEGACY_LS_KEY = 'spacron.licenseKey';

type SavedActivation = { keyTail: string; instanceId: string };

function keyTail(key: string) {
  return key.slice(-8);
}

function maskKey(key: string) {
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function readStorage(name: string): string {
  try {
    return localStorage.getItem(name) || '';
  } catch {
    return '';
  }
}

function writeStorage(name: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch {
    // Private mode or blocked storage: the page still works, it just forgets.
  }
}

function savedActivationFor(key: string): string | undefined {
  try {
    const saved = JSON.parse(readStorage(LS_ACTIVATION) || 'null') as SavedActivation | null;
    return saved && saved.keyTail === keyTail(key) ? saved.instanceId : undefined;
  } catch {
    return undefined;
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_KEY: 'That license key is not valid for Spacron. Check it against your purchase email.',
  ACTIVATION_REFUSED:
    'This key could not be activated on a new device. It may have reached its device limit; contact support to free one up.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  UPSTREAM_UNREACHABLE: 'Could not reach the license server. Try again.',
  LICENSE_SERVICE_NOT_CONFIGURED: 'Downloads are temporarily unavailable. Please try again later.',
};

function PlatformButtons({ href }: { href: (platform: string) => string }) {
  return (
    <div className="download-platforms" data-reveal="scale">
      {PLATFORMS.map((p) => (
        <a key={p.key} className="btn btn-primary" href={href(p.key)}>
          {p.label} <span className="pill">{p.sub}</span>
        </a>
      ))}
    </div>
  );
}

export default function DownloadGate({ checkoutUrl, mode }: { checkoutUrl: string; mode: LicensingMode }) {
  const [licenseKey, setLicenseKey] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const [message, setMessage] = useState('');
  const [downloadToken, setDownloadToken] = useState('');

  useEffect(() => {
    // Older builds of this page kept the raw key in storage; drop it.
    writeStorage(LEGACY_LS_KEY, null);
    setDeviceName(readStorage(LS_DEVICE));
  }, []);

  useEffect(() => {
    if (deviceName) writeStorage(LS_DEVICE, deviceName);
  }, [deviceName]);

  if (mode === 'open') {
    return (
      <section className="section download-gate">
        <div className="download-card">
          <p className="section-eyebrow" data-reveal>Early access</p>
          <h1 className="download-title" data-reveal>Download Spacron</h1>
          <p className="download-lead" data-reveal>Free while Spacron is in early access. Pick your platform.</p>
          <PlatformButtons href={(p) => `/download/${p}`} />
        </div>
      </section>
    );
  }

  if (mode === 'misconfigured') {
    return (
      <section className="section download-gate">
        <div className="download-card">
          <h1 className="download-title" data-reveal>Download Spacron</h1>
          <p className="download-lead" data-reveal>{ERROR_MESSAGES.LICENSE_SERVICE_NOT_CONFIGURED}</p>
        </div>
      </section>
    );
  }

  const buyHref = checkoutUrl || '/download';
  const trimKey = licenseKey.trim();
  const trimDevice = deviceName.trim();

  async function redeem(e: FormEvent) {
    e.preventDefault();
    if (!trimKey || !trimDevice) {
      setStatus('invalid');
      setMessage('Enter your license key and a device name.');
      return;
    }
    setStatus('checking');
    setMessage('');
    try {
      const res = await fetch('/api/license/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey: trimKey,
          instanceName: trimDevice,
          instanceId: savedActivationFor(trimKey),
        }),
      });
      const data = await res.json().catch(() => null);
      if (data && data.ok && data.downloadToken) {
        writeStorage(LS_ACTIVATION, JSON.stringify({ keyTail: keyTail(trimKey), instanceId: data.instanceId }));
        setDownloadToken(data.downloadToken);
        setStatus('valid');
        return;
      }
      setStatus('invalid');
      setMessage(ERROR_MESSAGES[data?.error] ?? ERROR_MESSAGES.INVALID_KEY);
    } catch {
      setStatus('invalid');
      setMessage(ERROR_MESSAGES.UPSTREAM_UNREACHABLE);
    }
  }

  if (status === 'valid') {
    return (
      <section className="section download-gate">
        <div className="download-card is-unlocked">
          <p className="section-eyebrow" data-reveal>License verified</p>
          <h1 className="download-title" data-reveal>Download Spacron</h1>
          <p className="download-lead" data-reveal>
            {maskKey(trimKey)} &#183; device {trimDevice}
          </p>
          <PlatformButtons href={(p) => `/download/${p}?token=${encodeURIComponent(downloadToken)}`} />
          <p className="download-note">
            These links work for 15 minutes. Installing on another machine? Unlock again with the same key and a new
            device name.
          </p>
          <button className="link-btn" onClick={() => setStatus('idle')}>Use a different key or device</button>
        </div>
      </section>
    );
  }

  return (
    <section className="section download-gate">
      <div className="download-card">
        <p className="section-eyebrow" data-reveal>Get Spacron</p>
        <h1 className="download-title" data-reveal>Buy once. Own it forever.</h1>
        <p className="download-lead" data-reveal>Pay $49 once for a perpetual Spacron license.</p>
        <a className="btn btn-primary download-buy" href={buyHref} data-reveal="scale">Buy now · $49</a>
        <p className="download-note" data-reveal>
          Your unique license key is emailed to you the moment checkout completes. No two buyers get the same key.
        </p>

        <hr className="download-divider" />

        <h2 className="download-sub" data-reveal>Already own a license?</h2>
        <p className="download-sub-lead" data-reveal>Enter your key and a device name to unlock the downloads.</p>
        <form className="download-form" onSubmit={redeem} data-reveal>
          <label htmlFor="license-key">License key</label>
          <input
            id="license-key"
            className="download-input"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXX"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
          />
          <label htmlFor="device-name">Device name</label>
          <input
            id="device-name"
            className="download-input"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="e.g. my-desktop"
            required
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
          />
          <button type="submit" className="btn btn-ghost" disabled={status === 'checking'}>
            {status === 'checking' ? 'Checking…' : 'Unlock downloads'}
          </button>
        </form>
        {status === 'invalid' && message && <p className="download-error" data-reveal>{message}</p>}
      </div>
    </section>
  );
}
