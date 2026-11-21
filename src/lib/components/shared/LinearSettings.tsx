import { useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import {
  connectLinear,
  disconnectLinear,
  getLinearAccount,
  getLinearMapping,
  linearError,
  listLinearScopes,
  setLinearMapping,
  type LinearMapping,
  type LinearScope,
  type LinearScopeKind,
} from '$lib/services/linear';
import Dropdown from './Dropdown';

export default function LinearSettings({ onOpenKeyHelp }: { onOpenKeyHelp: () => void }) {
  const project = useStore(activeProject);
  const [checking, setChecking] = useState(true);
  const [account, setAccount] = useState<{ name: string } | null>(null);
  const [accountError, setAccountError] = useState('');
  const [accountCheckFailed, setAccountCheckFailed] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');

  useEffect(() => {
    let current = true;
    void getLinearAccount().then(
      (identity) => { if (current) setAccount(identity); },
      (error) => {
        if (current) {
          setAccountError(linearError(error));
          setAccountCheckFailed(true);
        }
      },
    ).finally(() => { if (current) setChecking(false); });
    return () => { current = false; };
  }, []);

  async function updateAccount(action: 'connect' | 'disconnect') {
    setChecking(true);
    setAccountError('');
    const key = keyDraft.trim();
    setKeyDraft('');
    try {
      if (action === 'connect') {
        setAccount(await connectLinear(key));
      } else {
        await disconnectLinear();
        setAccount(null);
      }
      setAccountCheckFailed(false);
    } catch (error) {
      setAccountError(linearError(error));
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <div className="settings-sc-row">
        <div className="settings-sc-copy">
          <span className="settings-sc-brand-icon" aria-hidden="true">
            <img src="/mcp-icons/linear.png" alt="" width="18" height="18" />
          </span>
          <div className="settings-sc-meta">
            <div className="settings-sc-title-row">
              <span className="settings-sc-provider-name">Linear</span>
              <span className={`settings-sc-badge ${account ? 'connected' : 'disconnected'}`}>
                {checking ? 'Checking…' : account ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <span className="settings-sc-detail">
              {account ? `Signed in as ${account.name} on this device.` : 'Connect with a personal API key with Read access.'}
            </span>
            {!account && (
              <button type="button" className="settings-link-button" onClick={onOpenKeyHelp}>Get a key</button>
            )}
          </div>
        </div>
        <div className="settings-sc-control">
          {account ? (
            <button type="button" className="settings-sc-disconnect-btn" disabled={checking}
              onClick={() => void updateAccount('disconnect')}>Disconnect</button>
          ) : (
            <>
              <form className="settings-sc-input-group" onSubmit={(event) => {
                event.preventDefault();
                if (!checking && keyDraft.trim()) void updateAccount('connect');
              }}>
                <input type="password" aria-label="Linear personal API key" placeholder="Personal API key"
                  autoComplete="off" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} />
                <button type="submit" className="settings-primary" disabled={checking || !keyDraft.trim()}>Connect</button>
              </form>
              {accountCheckFailed && (
                <button type="button" className="settings-sc-disconnect-btn" disabled={checking}
                  onClick={() => void updateAccount('disconnect')}>Remove saved key</button>
              )}
            </>
          )}
          {accountError && <span role="alert" className="settings-sc-error-msg">{accountError}</span>}
        </div>
      </div>
      {account && project && <LinearProjectMapping key={project.id} projectId={project.id} projectName={project.name} />}
      {account && !project && <p className="settings-sc-detail">Open a project to choose which Linear issues appear in it.</p>}
    </>
  );
}

function LinearProjectMapping({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [mapping, setMapping] = useState(() => getLinearMapping(projectId));
  const [kind, setKind] = useState<LinearScopeKind>(mapping?.kind ?? 'team');
  const [scopes, setScopes] = useState<LinearScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setScopes([]);
    setError('');
    void listLinearScopes(kind).then(
      (options) => {
        if (current) setScopes(options.sort((a, b) => a.name.localeCompare(b.name)));
      },
      (failure) => { if (current) setError(linearError(failure)); },
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [kind, revision]);

  function save(mapping: LinearMapping | null) {
    try {
      setLinearMapping(projectId, mapping);
      setMapping(mapping);
      setError('');
    } catch {
      setError('Could not save the Linear mapping on this device.');
    }
  }

  const selected = mapping?.kind === kind ? mapping : null;
  const options = scopes.map(({ id, name }) => ({ value: id, label: name }));
  if (selected && !options.some((option) => option.value === selected.id)) {
    options.unshift({ value: selected.id, label: selected.name });
  }

  return (
    <div className="settings-sc-row">
      <div className="settings-sc-meta">
        <span className="settings-sc-provider-name">{projectName}</span>
        <span className="settings-sc-detail">
          {mapping ? `Linear ${mapping.kind}: ${mapping.name}` : 'Choose a Linear team or project for this Spacron project.'}
        </span>
      </div>
      <div className="settings-sc-control">
        <Dropdown ariaLabel="Linear scope type" value={kind}
          options={[{ value: 'team', label: 'Team' }, { value: 'project', label: 'Project' }]}
          onChange={(value) => setKind(value === 'project' ? 'project' : 'team')} />
        <Dropdown ariaLabel={`Linear ${kind}`} value={selected?.id ?? ''} options={options}
          placeholder={loading ? 'Loading…' : options.length ? `Choose a ${kind}` : `No Linear ${kind}s available`}
          disabled={loading || !options.length}
          onChange={(id) => {
            const scope = scopes.find((option) => option.id === id);
            if (scope) save({ ...scope, kind });
          }} />
        {mapping && <button type="button" className="settings-secondary" onClick={() => save(null)}>Clear mapping</button>}
        {error && (
          <>
            <span role="alert" className="settings-sc-error-msg">{error}</span>
            <button type="button" className="settings-secondary" onClick={() => setRevision((value) => value + 1)}>Retry</button>
          </>
        )}
      </div>
    </div>
  );
}
