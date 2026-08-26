/**
 * Pure helpers for the "Set up a remote VPS" wizard (RemoteSetupWizard.tsx).
 * Kept out of the component so the rules are unit-testable and shared if the
 * wizard ever grows a second entry point.
 */

/** OS the target server runs — the deploy supervisor differs per platform. */
export type DeployPlatform = 'linux' | 'macos' | 'windows';

export const DEPLOY_PLATFORMS: DeployPlatform[] = ['linux', 'macos', 'windows'];

/** Display name for a deploy platform — proper nouns ("Windows", "macOS"),
 *  never the raw enum value, everywhere the wizard shows one. */
export function platformLabel(p: DeployPlatform): string {
  return p === 'macos' ? 'macOS' : p === 'windows' ? 'Windows' : 'Linux';
}

export interface DeployInput {
  host: string;
  username: string;
  sshPort: number;
  keyPath: string;
  workspace: string;
  serverPort: number;
  platform: DeployPlatform;
}

/** Result of `remote_deploy_vps` — the connection coordinates to save. */
export interface DeployResult {
  host: string;
  port: number;
  url: string;
  token: string;
}

/** Result of `remote_server_binary_status` — can we deploy to this OS at all? */
export interface ServerBinaryStatus {
  available: boolean;
  path: string | null;
  detail: string | null;
  downloadable: boolean;
}

/** Result of `remote_download_server`. */
export interface ServerDownloadResult {
  path: string;
  bytes: number;
  source: string;
}

/**
 * What the wizard should say about the server binary for `platform`.
 *
 * Kept pure and separate from the component because it is the one piece of
 * this flow with real branching: four states, and the wrong one either hides a
 * blocker until the deploy fails or nags about a binary that is already there.
 * `null` status = not checked yet (or checking), which deliberately renders
 * nothing rather than a scary placeholder.
 */
export type BinaryNotice =
  | { kind: 'none' }
  | { kind: 'ready'; text: string }
  | { kind: 'download'; text: string; action: string }
  | { kind: 'blocked'; text: string };

export function binaryNotice(
  platform: DeployPlatform,
  status: ServerBinaryStatus | null,
  hostOs: DeployPlatform | null,
): BinaryNotice {
  if (!status) return { kind: 'none' };
  const os = platformLabel(platform);
  if (status.available) {
    // Deploying to the OS you are running is the ordinary case and needs no
    // commentary; a cross-OS deploy that *is* ready is worth confirming,
    // because the user was probably just told it wasn't.
    if (hostOs && hostOs === platform) return { kind: 'none' };
    return { kind: 'ready', text: `A ${os} server build is ready on this machine.` };
  }
  if (status.downloadable) {
    return {
      kind: 'download',
      text: `This app ships the ${hostOs ? platformLabel(hostOs) : 'host'} build of the server. Deploying to ${os} needs the ${os} build. Download it once and it stays on this machine.`,
      action: `Get the ${os} server`,
    };
  }
  return {
    kind: 'blocked',
    text:
      status.detail ??
      `No ${os} server build is available on this machine, and there is no published build to download.`,
  };
}

/** Returns an error message, or null when the input is safe to send. */
export function validateDeployInput(input: DeployInput): string | null {
  const host = input.host.trim();
  const username = input.username.trim();
  const workspace = input.workspace.trim();

  if (!host) return 'Host is required.';
  if (host.length > 255 || !/^[A-Za-z0-9._-]+$/.test(host)) {
    return 'Host may only contain letters, digits, dots, dashes and underscores.';
  }
  if (!username) return 'SSH username is required.';
  if (username.length > 64 || !/^[A-Za-z0-9._-]+$/.test(username)) {
    return 'Username may only contain letters, digits, dots, dashes and underscores.';
  }
  if (!workspace) return 'Workspace folder is required.';
  if (workspace.length > 64 || !/^[A-Za-z0-9_-]+$/.test(workspace)) {
    return 'Workspace folder may only contain letters, digits, dashes and underscores.';
  }
  if (!Number.isInteger(input.sshPort) || input.sshPort < 1 || input.sshPort > 65535) {
    return 'SSH port must be between 1 and 65535.';
  }
  if (!Number.isInteger(input.serverPort) || input.serverPort < 1 || input.serverPort > 65535) {
    return 'Server port must be between 1 and 65535.';
  }
  if (!DEPLOY_PLATFORMS.includes(input.platform)) {
    return 'Choose a server platform (Linux, macOS or Windows).';
  }
  return null;
}

/** The `/pty` WebSocket endpoint the client dials for a deployed server. */
export function deployServerUrl(host: string, serverPort: number): string {
  return `ws://${host.trim()}:${serverPort}/pty`;
}
