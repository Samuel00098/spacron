import { commandBlocks, toggleCommandBlockCollapse, promptBarInput } from '$lib/stores/terminal';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { sendChatMessage } from '$lib/stores/orchestrator';
import { showToast } from '$lib/stores/notification';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import './CommandBlockStrip.css';

interface CommandBlock {
  id: string;
  sessionId: number;
  command: string;
  startTime: number;
  endTime?: number;
  output?: string;
  exitCode?: number;
  collapsed: boolean;
}

function formatDuration(start: number, end?: number): string {
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;]*[mGKHFABCDJrsu]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07]*\x07/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, '').replace(ANSI_OSC, '');
}

export default function CommandBlockStrip({ sessionId }: { sessionId: number }) {
  const allBlocks = useStore(commandBlocks);
  const blocks = (allBlocks.get(sessionId) ?? []).slice(-10);
  const project = useStore(activeProject);

  const projectId = project?.id ?? '';
  const rootPath = project?.root_path ?? '';

  if (blocks.length === 0) return null;

  const handleFix = async (block: CommandBlock) => {
    if (!projectId || !rootPath) {
      showToast('No active project to route request', 'warning');
      return;
    }
    const promptText = `Fix the error for command: "${block.command}" which exited with code ${block.exitCode ?? -1}. Here is the output:\n\`\`\`\n${stripAnsi(block.output || '')}\n\`\`\``;
    showToast(`Dispatched troubleshooting request to orchestrator for command: "${block.command}"`, 'info');
    await sendChatMessage(projectId, rootPath, promptText);
  };

  const handleExplain = async (block: CommandBlock) => {
    if (!projectId || !rootPath) {
      showToast('No active project to route request', 'warning');
      return;
    }
    const promptText = `Explain what this command did and interpret its output:\nCommand: ${block.command}\nOutput:\n\`\`\`\n${stripAnsi(block.output || '')}\n\`\`\``;
    showToast(`Requesting explanation for command: "${block.command}"`, 'info');
    await sendChatMessage(projectId, rootPath, promptText);
  };

  const handlePipe = (block: CommandBlock) => {
    const textToPipe = stripAnsi(block.output || '');
    copyTextToClipboard(textToPipe).then(() => {
      promptBarInput.set(textToPipe);
      showToast('Output copied to clipboard and loaded into prompt composer', 'success');
    }).catch((err) => {
      console.error('Failed to copy text: ', err);
      showToast('Failed to copy output', 'error');
    });
  };

  return (
    <div className="block-strip">
      {blocks.map((block) => (
        <div key={block.id} className={`cmd-block${block.endTime === undefined ? ' running' : ''}`}>
          <div className="cmd-header">
            <span className="cmd-status">
              {block.endTime === undefined ? (
                <span className="dot dot-running"></span>
              ) : (block.exitCode ?? 0) === 0 ? (
                <span className="dot dot-ok"></span>
              ) : (
                <span className="dot dot-err"></span>
              )}
            </span>
            <span className="cmd-text">{block.command}</span>
            <span className="cmd-duration">{formatDuration(block.startTime, block.endTime)}</span>
            
            {block.endTime !== undefined && (
              <div className="cmd-actions">
                {(block.exitCode ?? 0) !== 0 && (
                  <button className="cmd-action-btn fix-btn" onClick={() => handleFix(block)} title="Fix with Orchestrator Agent">Fix</button>
                )}
                <button className="cmd-action-btn" onClick={() => handleExplain(block)} title="Explain Command Output">Explain</button>
                <button className="cmd-action-btn" onClick={() => handlePipe(block)} title="Pipe Output to Clipboard / Composer">Pipe</button>
              </div>
            )}

            <span
              className="cmd-toggle"
              onClick={() => toggleCommandBlockCollapse(sessionId, block.id)}
              title={block.collapsed ? 'Expand output' : 'Collapse output'}
            >
              {block.collapsed ? '▸' : '▾'}
            </span>
          </div>
          {!block.collapsed && block.output && (
            <pre className="cmd-output">{stripAnsi(block.output)}</pre>
          )}
        </div>
      ))}
    </div>
  );
}
