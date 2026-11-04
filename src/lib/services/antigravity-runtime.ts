import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/tauri';

/**
 * The managed Antigravity ACP runtime.
 *
 * Antigravity's ACP server is not the `agy` CLI — Google ships it as a separate
 * extension archive — so Chat needs a real path to launch. The backend
 * downloads the registry archive for this platform, checks its sha256 and
 * unpacks it; this module is the thin bridge plus the status the Settings row
 * shows.
 */
export interface AntigravityRuntimeStatus {
  installed: boolean;
  managed: boolean;
  version: string;
  path: string | null;
  supported: boolean;
}

/** Registry version the backend's archive table describes. */
export const ANTIGRAVITY_RUNTIME_VERSION = '1.4.5';

/** Null when the desktop backend is unavailable (web preview, tests). */
export async function getAntigravityRuntimeStatus(): Promise<AntigravityRuntimeStatus | null> {
  if (!isTauriRuntime()) return null;
  return invoke<AntigravityRuntimeStatus>('antigravity_runtime_status').catch(() => null);
}

/**
 * Download and install the runtime. Throws the backend's message on any failure
 * (unsupported platform, checksum mismatch, network) — the caller shows it
 * verbatim, because "install failed" alone would hide a checksum refusal.
 */
export async function installAntigravityRuntime(): Promise<AntigravityRuntimeStatus> {
  if (!isTauriRuntime()) {
    throw new Error('Installing the Antigravity runtime needs the desktop app.');
  }
  return invoke<AntigravityRuntimeStatus>('antigravity_runtime_install');
}
