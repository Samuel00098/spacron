import { invoke } from '@tauri-apps/api/core';

export interface CreateRepoResult {
  html_url: string;
  full_name: string;
  pushed: boolean;
}

/** Which GitHub sign-in entry points are available right now. */
export interface GithubAuthOptions {
  oauth_available: boolean;
  gh_cli_available: boolean;
}

/** The signed-in user: login + granted scopes + how they signed in. */
export interface GithubIdentity {
  login: string;
  scopes: string[];
  source: string;
}

/** The start of a device-flow sign-in, as returned by GitHub. */
export interface GithubOAuthStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type GithubOAuthPollStatus = 'pending' | 'slow_down' | 'signed_in';

export interface GithubOAuthPollResult {
  status: GithubOAuthPollStatus;
  identity: GithubIdentity | null;
}

/** One row of the signed-in user's own-repo picker. */
export interface GithubRepo {
  full_name: string;
  clone_url: string;
  private: boolean;
  updated_at: string;
  description: string | null;
}

/** True if a GitHub personal access token is saved in the OS keychain. */
export async function githubTokenExists(): Promise<boolean> {
  try {
    return await invoke<boolean>('github_token_exists');
  } catch {
    return false;
  }
}

/** Save the GitHub token to the keychain (pass an empty string to clear it). */
export async function saveGithubToken(token: string): Promise<void> {
  await invoke('github_token_set', { token });
}

export async function deleteGithubToken(): Promise<void> {
  await invoke('github_token_delete');
}

export async function githubAuthOptions(): Promise<GithubAuthOptions> {
  return await invoke<GithubAuthOptions>('github_auth_options');
}

/** Start a device-flow sign-in; returns the code to show the user. */
export async function githubOauthStart(): Promise<GithubOAuthStart> {
  return await invoke<GithubOAuthStart>('github_oauth_start');
}

/** Poll for approval of an in-progress device-flow sign-in. */
export async function githubOauthPoll(deviceCode: string): Promise<GithubOAuthPollResult> {
  return await invoke<GithubOAuthPollResult>('github_oauth_poll', { deviceCode });
}

/** The currently signed-in user, or null. */
export async function githubSignedInUser(): Promise<GithubIdentity | null> {
  return await invoke<GithubIdentity | null>('github_signed_in_user');
}

/** The signed-in user's repositories, most recently updated first. */
export async function githubListRepos(): Promise<GithubRepo[]> {
  return await invoke<GithubRepo[]>('github_list_repos');
}

/** One-click sign-in using the user's existing `gh auth` session. */
export async function githubCliSignIn(): Promise<GithubIdentity> {
  return await invoke<GithubIdentity>('github_cli_sign_in');
}

/**
 * Create a new repository on the user's GitHub account, set it as origin for the
 * active project, and push the initial commit.
 */
export async function createGithubRepo(
  projectId: string,
  name: string,
  description: string,
  isPrivate: boolean
): Promise<CreateRepoResult> {
  return await invoke<CreateRepoResult>('workspace_github_create_repo', {
    projectId,
    name,
    description: description || null,
    private: isPrivate,
  });
}
