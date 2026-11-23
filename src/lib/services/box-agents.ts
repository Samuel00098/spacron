/**
 * Agents the box started on its own (`spawn_agent` / `delegate_task` of the
 * box's MCP server, see `remote/box_agents.rs`), shown as normal panes.
 *
 * The box owns those terminals, and they keep running while this laptop is
 * closed. While connected, this asks the box what it started and attaches
 * any it has not shown yet, named and tagged with their agent.
 */
import { get } from '$lib/stores/storeCompat';
import { activeProject } from '$lib/stores/workspace';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { backendInvoke } from '$lib/services/backend';

export interface BoxAgent {
  id: number;
  name: string;
  preset: string;
  cwd: string;
  startedAt: number;
  state: string;
  summary?: string | null;
}

const shown = new Set<number>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Attach every box-started agent that is not a pane yet. Returns how many were added. */
export async function adoptBoxAgents(): Promise<number> {
  const project = get(activeProject);
  if (!get(remoteTarget) || !project) return 0;
  let list: BoxAgent[];
  try {
    list = await backendInvoke<BoxAgent[]>('box_agents_list');
  } catch {
    return 0; // An older box server without box agents.
  }
  const { attachTerminalSession } = await import('$lib/stores/terminal');
  let added = 0;
  for (const agent of list) {
    if (shown.has(agent.id)) continue;
    const id = await attachTerminalSession(agent.id, agent.cwd, undefined, project.id, {
      title: agent.name, agentName: agent.name, agentPreset: agent.preset, role: 'Agent',
    });
    if (id !== null) { shown.add(agent.id); added += 1; }
  }
  return added;
}

/** Keep adopting while connected to a box. */
export function watchBoxAgents(): void {
  if (timer) return;
  void adoptBoxAgents();
  timer = setInterval(() => {
    if (!get(remoteTarget)) { stopWatchingBoxAgents(); return; }
    void adoptBoxAgents();
  }, 5_000);
}

export function stopWatchingBoxAgents(): void {
  if (timer) clearInterval(timer);
  timer = null;
  shown.clear();
}
