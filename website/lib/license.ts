import { createHmac, timingSafeEqual } from 'node:crypto';

const LS_LICENSES = 'https://api.lemonsqueezy.com/v1/licenses';

/** How long an unlocked download link stays usable. */
export const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * - `open`: no Lemon Squeezy settings at all. Downloads are free (early access
 *   for friends); nothing asks for a key.
 * - `enforced`: store id, product id and token secret are all set. A valid
 *   Spacron key is required to download.
 * - `misconfigured`: only some of them are set. Fails closed, so a half-done
 *   setup never silently hands out free downloads.
 */
export type LicensingMode = 'open' | 'enforced' | 'misconfigured';

function config() {
  return {
    storeId: process.env.LEMONSQUEEZY_STORE_ID?.trim() || '',
    productId: process.env.LEMONSQUEEZY_PRODUCT_ID?.trim() || '',
    secret: process.env.DOWNLOAD_TOKEN_SECRET?.trim() || '',
  };
}

export function licensingMode(): LicensingMode {
  const { storeId, productId, secret } = config();
  if (!storeId && !productId && !secret) return 'open';
  if (storeId && productId && secret.length >= 32) return 'enforced';
  return 'misconfigured';
}

interface LicenseApiResponse {
  valid?: boolean;
  activated?: boolean;
  error?: string | null;
  license_key?: { status?: string } | null;
  instance?: { id?: string } | null;
  meta?: { store_id?: number | string; product_id?: number | string } | null;
}

async function callLicenseApi(action: 'validate' | 'activate', fields: Record<string, string>) {
  try {
    const res = await fetch(`${LS_LICENSES}/${action}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      cache: 'no-store',
    });
    // Lemon Squeezy answers a bad key with a 4xx *and* a JSON body; read both.
    const data = (await res.json().catch(() => null)) as LicenseApiResponse | null;
    return data ?? { error: `HTTP_${res.status}` };
  } catch {
    return null;
  }
}

/**
 * Any Lemon Squeezy store's key passes Lemon Squeezy's own check, so the key
 * must be proven to belong to *this* store and product, and still be usable.
 */
function isSpacronKey(data: LicenseApiResponse): boolean {
  const { storeId, productId } = config();
  const status = data.license_key?.status;
  return (
    String(data.meta?.store_id ?? '') === storeId &&
    String(data.meta?.product_id ?? '') === productId &&
    status !== 'disabled' &&
    status !== 'expired'
  );
}

export type Unlock = { ok: true; instanceId: string } | { ok: false; error: string };

/**
 * Unlock downloads for one device. A device that already has an activation
 * (`instanceId`) is only re-validated, which costs nothing; a new device is
 * activated once, taking one of the key's activation slots. Activation is not
 * deduplicated by name on Lemon Squeezy's side, so callers must pass the
 * stored `instanceId` back rather than activating on every visit.
 */
export async function unlockDevice(licenseKey: string, instanceName: string, instanceId?: string): Promise<Unlock> {
  if (licensingMode() !== 'enforced') return { ok: false, error: 'LICENSING_NOT_ENFORCED' };

  if (instanceId) {
    const existing = await callLicenseApi('validate', { license_key: licenseKey, instance_id: instanceId });
    if (!existing) return { ok: false, error: 'UPSTREAM_UNREACHABLE' };
    if (existing.valid === true && isSpacronKey(existing) && existing.instance?.id === instanceId) {
      return { ok: true, instanceId };
    }
    // Stale or deactivated instance: fall through and activate afresh.
  }

  // Check the key belongs to Spacron *before* activating, so a foreign key
  // never gets as far as consuming a slot.
  const check = await callLicenseApi('validate', { license_key: licenseKey });
  if (!check) return { ok: false, error: 'UPSTREAM_UNREACHABLE' };
  if (check.valid !== true || !isSpacronKey(check)) return { ok: false, error: 'INVALID_KEY' };

  const activation = await callLicenseApi('activate', { license_key: licenseKey, instance_name: instanceName });
  if (!activation) return { ok: false, error: 'UPSTREAM_UNREACHABLE' };
  const newId = activation.instance?.id;
  if (activation.activated !== true || !newId || !isSpacronKey(activation)) {
    // Most often: the key has used all of its activation slots.
    return { ok: false, error: activation.error ? 'ACTIVATION_REFUSED' : 'INVALID_KEY' };
  }
  return { ok: true, instanceId: newId };
}

function sign(payload: string): string {
  return createHmac('sha256', config().secret).update(payload).digest('base64url');
}

/** A short-lived, key-free token that proves this browser just unlocked downloads. */
export function issueDownloadToken(now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + DOWNLOAD_TOKEN_TTL_MS;
  const payload = `dl1.${expiresAt}`;
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

export function verifyDownloadToken(token: string, now = Date.now()): boolean {
  if (licensingMode() !== 'enforced') return false;
  const lastDot = token.lastIndexOf('.');
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const given = Buffer.from(token.slice(lastDot + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const match = /^dl1\.(\d+)$/.exec(payload);
  return !!match && Number(match[1]) > now;
}
