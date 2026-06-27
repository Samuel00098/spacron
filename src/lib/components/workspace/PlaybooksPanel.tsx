import { useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { activeSessionId, writeToSession, isAgentSession } from '$lib/stores/terminal';
import { sendChatMessage, getDispatchableAgents } from '$lib/stores/orchestrator';
import { showToast } from '$lib/stores/notification';
import { invoke } from '@tauri-apps/api/core';
import Dropdown from '$lib/components/shared/Dropdown.tsx';
import './PlaybooksPanel.css';

interface PlaybookStep {
  id: string;
  name: string;
  command: string;
}

interface PlaybookData {
  filename: string;
  path: string;
  title: string;
  description: string;
  steps: PlaybookStep[];
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string;
}

function parsePlaybook(content: string, filename: string, path: string): PlaybookData {
  const lines = content.split(/\r?\n/);
  let title = filename.replace(/\.md$/i, '');
  let description = '';
  const steps: PlaybookStep[] = [];
  
  let currentStepDesc = '';
  let inCodeBlock = false;
  let currentCode: string[] = [];
  
  for (const line of lines) {
    if (line.startsWith('# ') && title === filename.replace(/\.md$/i, '')) {
      title = line.substring(2).trim();
      continue;
    }
    
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        const commandText = currentCode.join('\n').trim();
        if (commandText) {
          steps.push({
            id: Math.random().toString(36).substring(2, 9),
            name: currentStepDesc.trim() || `Step ${steps.length + 1}`,
            command: commandText,
          });
        }
        currentCode = [];
        currentStepDesc = '';
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    
    if (inCodeBlock) {
      currentCode.push(line);
    } else {
      if (line.startsWith('## ') || line.startsWith('### ')) {
        currentStepDesc = line.replace(/^#+\s+/, '').trim();
      } else if (line.trim()) {
        if (steps.length === 0) {
          if (!description) description = line.trim();
          else description += '\n' + line.trim();
        } else {
          if (!currentStepDesc) currentStepDesc = line.trim();
          else currentStepDesc += '\n' + line.trim();
        }
      }
    }
  }
  
  return { filename, path, title, description, steps };
}

export default function PlaybooksPanel() {
  const project = useStore(activeProject);
  const activeId = useStore(activeSessionId);
  
  const [playbooks, setPlaybooks] = useState<PlaybookData[]>([]);
  const [selectedPlaybook, setSelectedPlaybook] = useState<PlaybookData | null>(null);
  const [hasFolder, setHasFolder] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);
  const [selectedAgents, setSelectedAgents] = useState<Record<string, string>>({});

  const projectRoot = project?.root_path ?? '';
  const projectId = project?.id ?? '';
  const playbooksPath = projectRoot ? `${projectRoot}/.soryq/playbooks`.replace(/\\/g, '/') : '';

  const loadPlaybooks = async () => {
    if (!projectRoot) return;
    setLoading(true);
    try {
      // First, read dir
      const entries = await invoke<FileEntry[]>('fs_read_dir', { path: playbooksPath });
      setHasFolder(true);
      
      const parsedFiles: PlaybookData[] = [];
      for (const entry of entries) {
        if (!entry.is_dir && entry.name.endsWith('.md')) {
          try {
            const content = await invoke<string>('fs_read_file', { path: entry.path });
            parsedFiles.push(parsePlaybook(content, entry.name, entry.path));
          } catch (e) {
            console.error(`Failed to read playbook ${entry.name}:`, e);
          }
        }
      }
      setPlaybooks(parsedFiles);
    } catch (e) {
      console.warn('Playbooks directory does not exist or failed to load:', e);
      setHasFolder(false);
      setPlaybooks([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectRoot) {
      void loadPlaybooks();
      setSelectedPlaybook(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  const handleCreateFolder = async () => {
    if (!projectRoot) return;
    try {
      const soryqPath = `${projectRoot}/.soryq`.replace(/\\/g, '/');
      try {
        await invoke('fs_create_dir', { path: soryqPath });
      } catch {
        // Ignored if .soryq already exists
      }
      await invoke('fs_create_dir', { path: playbooksPath });
      
      // Write a sample welcome playbook
      const samplePath = `${playbooksPath}/welcome_playbook.md`.replace(/\\/g, '/');
      const sampleContent = `# Soryq Staging Playbook

This is a sample staging playbook. Run the steps below in sequence to test your application.

## Run Development Server
Start the local Vite or Next development server.
\`\`\`bash
npm run dev
\`\`\`

## Compile and Build Project
Verify that TypeScript compiles and the production bundle builds without errors.
\`\`\`bash
npm run build
\`\`\`

## Run Unit Tests
Run the test runner to execute unit and integration tests.
\`\`\`bash
npm test
\`\`\``;
      
      await invoke('fs_write_file', { path: samplePath, content: sampleContent });
      showToast('Created playbooks directory with a sample welcome playbook', 'success');
      await loadPlaybooks();
    } catch (e) {
      console.error('Failed to create playbooks directory:', e);
      showToast('Failed to create playbooks directory', 'error');
    }
  };

  const handleRunStep = (step: PlaybookStep) => {
    if (activeId === null || activeId === undefined) {
      showToast('No active terminal session to execute command. Open a pane first.', 'warning');
      return;
    }
    writeToSession(activeId, step.command + '\r');
    showToast(`Executed step in active terminal: "${step.name}"`, 'success');
  };

  const handleDelegateStep = async (step: PlaybookStep, forcedAgent?: string) => {
    if (!projectId || !projectRoot) {
      showToast('No active project', 'warning');
      return;
    }
    const agentChoice = forcedAgent && forcedAgent !== 'auto' ? forcedAgent : undefined;
    const promptText = `Please run this command: "${step.command}" in the workspace and ensure it completes successfully.`;
    
    if (agentChoice) {
      showToast(`Delegating step to AI Orchestrator (${agentChoice}): "${step.name}"`, 'info');
      await sendChatMessage(projectId, projectRoot, promptText, { forcedAgent: agentChoice });
    } else {
      showToast(`Delegating step to AI Orchestrator (Auto): "${step.name}"`, 'info');
      await sendChatMessage(projectId, projectRoot, promptText);
    }
  };

  const agents = getDispatchableAgents(projectId);

  return (
    <div className="playbooks-panel">
      <div className="playbooks-header">
        <h3>Playbooks</h3>
        <div className="playbooks-actions">
          <button className="playbooks-btn" onClick={() => void loadPlaybooks()} title="Refresh playbooks" aria-label="Refresh playbooks">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>
        </div>
      </div>

      <div className="playbooks-content">
        {loading ? (
          <div className="playbooks-empty">
            <p>Loading playbooks...</p>
          </div>
        ) : !hasFolder ? (
          <div className="playbooks-empty">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <p>Soryq Playbooks help you run interactive markdown workflows block-by-block, or delegate them to AI agents.</p>
            <button className="create-playbooks-btn" onClick={() => void handleCreateFolder()}>
              Create Playbooks Folder
            </button>
          </div>
        ) : selectedPlaybook ? (
          <div className="playbook-detail">
            <button className="playbook-back-link" onClick={() => setSelectedPlaybook(null)}>
              ← Back to Playbooks
            </button>
            <div className="playbook-info">
              <h2>{selectedPlaybook.title}</h2>
              {selectedPlaybook.description && <p>{selectedPlaybook.description}</p>}
            </div>

            <div className="playbook-steps-list">
              {selectedPlaybook.steps.length === 0 ? (
                <p className="playbooks-empty">No executable code blocks found in this playbook.</p>
              ) : (
                selectedPlaybook.steps.map((step) => (
                  <div key={step.id} className="playbook-step-card">
                    <div className="playbook-step-title">{step.name}</div>
                    <div className="playbook-step-code-container">
                      <pre className="playbook-step-code">{step.command}</pre>
                    </div>
                    <div className="playbook-step-actions">
                      <button className="playbook-step-btn run-btn" onClick={() => handleRunStep(step)}>
                        ▶ Run
                      </button>
                      <button className="playbook-step-btn" onClick={() => void handleDelegateStep(step, selectedAgents[step.id] || 'auto')}>
                        🤖 Delegate
                      </button>
                      {agents.length > 0 && (
                        <div className="playbook-dropdown-container">
                          <Dropdown
                            options={[
                              { value: 'auto', label: 'Auto-route' },
                              ...agents.map(a => ({ value: a.command, label: a.name }))
                            ]}
                            value={selectedAgents[step.id] || 'auto'}
                            onChange={(val) => setSelectedAgents(prev => ({ ...prev, [step.id]: val }))}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="playbooks-list">
            {playbooks.length === 0 ? (
              <div className="playbooks-empty">
                <p>No playbooks found in `.soryq/playbooks/`. Add markdown files with code blocks to get started.</p>
              </div>
            ) : (
              playbooks.map((pb) => (
                <div key={pb.path} className="playbook-card" onClick={() => setSelectedPlaybook(pb)}>
                  <div className="playbook-card-title">{pb.title}</div>
                  {pb.description && <div className="playbook-card-desc">{pb.description}</div>}
                  <div className="playbook-card-steps">{pb.steps.length} steps</div>
                </div>
              ))
            )}

            <div className="playbook-hint-card">
              <div className="hint-title">💡 Soryq Playbooks Guide</div>
              <p>
                Store your markdown files (e.g. <code>deploy.md</code>) in the project playbooks directory:
              </p>
              <div className="hint-path">{playbooksPath || '.soryq/playbooks'}</div>
              <p>
                Use <code># Playbook Title</code>, step headers like <code>## Step Name</code>, and write executable commands inside code blocks:
              </p>
              <pre className="hint-example">
{`# Setup Guide
## Install Deps
\`\`\`bash
npm install
\`\`\``}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
