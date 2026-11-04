import { invoke } from '@tauri-apps/api/core';

/** Which sign-in entry points are available for a source control provider. */
export interface SourceControlAuthOptions {
  oauth_available: boolean;
  pat_available: boolean;
}

/** The signed-in user for a provider (login may be empty for PAT-only). */
export interface SourceControlIdentity {
  login: string;
  source: string; // "pat" | "oauth"
  scopes: string[];
}

/** True if a source control token is saved in the OS keychain for this provider. */
export async function sourceControlTokenExists(provider: string): Promise<boolean> {
  try {
    return await invoke<boolean>('source_control_token_exists', { provider });
  } catch {
    return false;
  }
}

/** Save the source control token to the keychain (pass an empty string to clear it). */
export async function saveSourceControlToken(provider: string, token: string): Promise<void> {
  await invoke('source_control_token_set', { provider, token });
}

export async function deleteSourceControlToken(provider: string): Promise<void> {
  await invoke('source_control_token_delete', { provider });
}

export async function sourceControlAuthOptions(provider: string): Promise<SourceControlAuthOptions> {
  return await invoke<SourceControlAuthOptions>('source_control_auth_options', { provider });
}

/** The currently signed-in user for a provider, or null. */
export async function sourceControlSignedInUser(
  provider: string
): Promise<SourceControlIdentity | null> {
  return await invoke<SourceControlIdentity | null>('source_control_signed_in_user', { provider });
}

export const SOURCE_CONTROL_PROVIDERS: { value: 'github' | 'gitlab' | 'bitbucket' | 'other'; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'bitbucket', label: 'Bitbucket' },
  { value: 'other', label: 'Other (PAT only)' },
];
