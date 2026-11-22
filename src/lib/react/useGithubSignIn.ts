import { openUrlInPreviewPanel } from '$lib/stores/preview';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  deleteGithubToken,
  githubAuthOptions,
  githubCliSignIn,
  githubOauthPoll,
  githubOauthStart,
  githubSignedInUser,
  type GithubAuthOptions,
  type GithubIdentity,
  type GithubOAuthStart,
} from '$lib/services/github';

/** Turn an unknown invoke failure into a user-facing message. */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}

/**
 * Shared GitHub sign-in state machine (device flow + gh CLI + status), used by
 * both the Clone dialog and the Settings GitHub section so the polling logic
 * lives in exactly one place. The token itself never crosses into the
 * frontend — the backend stores it straight into the OS keychain.
 */
export function useGithubSignIn() {
  const [options, setOptions] = useState<GithubAuthOptions | null>(null);
  const [identity, setIdentity] = useState<GithubIdentity | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [device, setDevice] = useState<GithubOAuthStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollActive = useRef(false);

  const load = useCallback(async () => {
    try {
      const [opts, user] = await Promise.all([githubAuthOptions(), githubSignedInUser()]);
      setOptions(opts);
      setIdentity(user);
    } catch {
      // Degrade to PAT-only rather than leaving the sign-in section in a
      // broken half-loaded state.
      setOptions({ oauth_available: false, gh_cli_available: false });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      pollActive.current = false;
    };
  }, [load]);

  async function openInBrowser(url: string) {
    await openUrlInPreviewPanel(url);
  }

  /** Start a device-flow sign-in: shows the code, opens the approval page,
   *  and polls until the user approves, cancels, or the request expires. */
  const start = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    try {
      const start = await githubOauthStart();
      setDevice(start);
      void openInBrowser(start.verification_uri);
      pollActive.current = true;
      const deadline = Date.now() + start.expires_in * 1000;
      let intervalMs = Math.max(start.interval, 1) * 1000;
      void (async () => {
        while (pollActive.current && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          if (!pollActive.current || Date.now() >= deadline) break;
          try {
            const result = await githubOauthPoll(start.device_code);
            if (result.status === 'signed_in' && result.identity) {
              pollActive.current = false;
              setDevice(null);
              setSigningIn(false);
              setIdentity(result.identity);
              return;
            }
            if (result.status === 'slow_down') intervalMs += 5000;
          } catch (e) {
            pollActive.current = false;
            setDevice(null);
            setSigningIn(false);
            setError(errorText(e));
            return;
          }
        }
        if (pollActive.current) {
          pollActive.current = false;
          setDevice(null);
          setSigningIn(false);
          setError('The sign-in request expired. Start again.');
        }
      })();
    } catch (e) {
      setSigningIn(false);
      setError(errorText(e));
    }
  }, []);

  /** Stop an in-progress sign-in (device flow or gh CLI import). */
  const cancel = useCallback(() => {
    pollActive.current = false;
    setDevice(null);
    setSigningIn(false);
  }, []);

  /** One-click sign-in reusing the user's `gh auth` session. */
  const importGhCli = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    try {
      const identity = await githubCliSignIn();
      setIdentity(identity);
      setSigningIn(false);
    } catch (e) {
      setSigningIn(false);
      setError(errorText(e));
    }
  }, []);

  /** Clear the keychain entry and drop the in-memory identity. */
  const signOut = useCallback(async () => {
    pollActive.current = false;
    try {
      await deleteGithubToken();
    } catch {
      // Even if the keychain call fails, drop the in-memory state.
    }
    setIdentity(null);
    setDevice(null);
    setSigningIn(false);
    setError(null);
  }, []);

  return {
    options,
    identity,
    signingIn,
    device,
    error,
    load,
    start,
    cancel,
    importGhCli,
    signOut,
    openInBrowser,
  };
}
