import { openUrlInPreviewPanel } from '$lib/stores/preview';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  deleteSourceControlToken,
  saveSourceControlToken,
  sourceControlAuthOptions,
  sourceControlSignedInUser,
  sourceControlTokenExists,
  type SourceControlAuthOptions,
  type SourceControlIdentity,
} from '$lib/services/source-control';

/** Turn an unknown invoke failure into a user-facing message. */
export function scErrorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}

/**
 * Provider-aware source control sign-in state.
 *
 * GitHub keeps its own rich hook (`useGithubSignIn`) with OAuth device flow
 * and gh CLI import. This hook handles PAT-only sign-in for GitLab, Bitbucket
 * and Other, plus the shared token exists/save/delete/status operations used
 * by every provider.
 */
export function useSourceControlSignIn(provider: 'github' | 'gitlab' | 'bitbucket' | 'other') {
  const [options, setOptions] = useState<SourceControlAuthOptions | null>(null);
  const [identity, setIdentity] = useState<SourceControlIdentity | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenExists, setTokenExists] = useState<boolean | null>(null);
  const pollActive = useRef(false);

  const load = useCallback(async () => {
    try {
      const [opts, user, exists] = await Promise.all([
        sourceControlAuthOptions(provider),
        sourceControlSignedInUser(provider),
        sourceControlTokenExists(provider),
      ]);
      setOptions(opts);
      setIdentity(user);
      setTokenExists(exists);
    } catch {
      setOptions({ oauth_available: false, pat_available: true });
      setIdentity(null);
      setTokenExists(false);
    }
  }, [provider]);

  useEffect(() => {
    void load();
    return () => {
      pollActive.current = false;
    };
  }, [load, provider]);

  /** Save a personal access token for this provider. */
  const saveToken = useCallback(
    async (token: string) => {
      setError(null);
      setSigningIn(true);
      try {
        await saveSourceControlToken(provider, token);
        const user = await sourceControlSignedInUser(provider);
        setIdentity(user ?? { login: '', source: 'pat', scopes: [] });
        setTokenExists(true);
        setSigningIn(false);
      } catch (e) {
        setSigningIn(false);
        setError(scErrorText(e));
      }
    },
    [provider]
  );

  /** Clear the saved token and drop the in-memory identity. */
  const signOut = useCallback(async () => {
    pollActive.current = false;
    setSigningIn(true);
    try {
      await deleteSourceControlToken(provider);
    } catch {
      // Even if the keychain call fails, drop the in-memory state.
    }
    setIdentity(null);
    setTokenExists(false);
    setSigningIn(false);
    setError(null);
  }, [provider]);

  return {
    provider,
    options,
    identity,
    signingIn,
    tokenExists,
    error,
    load,
    saveToken,
    signOut,
    openInBrowser: (url: string) => {
      void openUrlInPreviewPanel(url);
    },
  };
}
