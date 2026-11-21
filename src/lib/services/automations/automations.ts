import { get } from '$lib/stores/storeCompat';
import { activeProject } from '$lib/stores/workspace';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { createTerminalSession, updateSessionTitle, spawnAgentPreset, waitForAgentReady, sendPromptToSession, onSessionExit } from '$lib/stores/terminal';
import { getAgentRoster } from '$lib/stores/runs';
import { watchLeasedAgentTurn } from '$lib/services/orchestrator/agent-turn-watch';
import { agentTurnStates } from '$lib/stores/agentTurnState';
import { getAgentProviderLaunchOptions } from '$lib/services/chat-provider-adapters';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { markStructuredChatPane, structuredChatAgentFor, type StructuredChatAgent } from '$lib/services/structured-chat/panes';
import { getStructuredChat, startStructuredChat, sendStructuredChat, subscribeStructuredChat } from '$lib/services/structured-chat/registry';
import { nextOccurrence, type Schedule } from './schedule';

export interface Automation {
  id: string; name: string; prompt: string; projectId: string; root: string;
  agent: string; schedule: Schedule; time: string; day: number;
  model?: string | null; reasoningEffort?: ChatReasoningEffort;
  enabled: boolean; nextRunAt: number;
}
export interface AutomationRun {
  id: string; automationId: string; name: string; startedAt: number; finishedAt?: number;
  status: 'starting' | 'running' | 'needs_input' | 'completed' | 'failed' | 'missed' | 'interrupted' | 'quiet';
  detail?: string; sessionId?: number;
}
interface State { automations: Automation[]; runs: AutomationRun[] }
const KEY = 'spacron_automations_v1';
let state: State = { automations: [], runs: [] };
let loaded = false;
const listeners = new Set<() => void>();
export const subscribeAutomations = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const automationSnapshot = () => state;
const active = (run: AutomationRun) => ['starting', 'running', 'needs_input'].includes(run.status);

function commit(next: State) {
  // A failed durable claim must never start an agent.
  localStorage.setItem(KEY, JSON.stringify(next));
  state = next;
  listeners.forEach(fn => fn());
}
export function loadAutomations() {
  if (loaded) return;
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const saved = JSON.parse(raw) as State;
    if (!Array.isArray(saved.automations) || !Array.isArray(saved.runs)) throw new Error('Invalid automation storage');
    for (const item of saved.automations) {
      if (!item.id || !item.root || !item.projectId || !item.prompt || typeof item.agent !== 'string' || !item.agent.trim() || !['hourly', 'daily', 'weekdays', 'weekly'].includes(item.schedule) || !Number.isFinite(item.nextRunAt)) throw new Error('Invalid saved automation');
      nextOccurrence(item.schedule, item.time, item.day, Date.now());
    }
    commit({ ...saved, runs: saved.runs.map(({ sessionId: _session, ...run }) => active(run) ? { ...run, status: 'interrupted', finishedAt: Date.now(), detail: 'App restarted; completion was not observed.' } : run) });
  }
  loaded = true;
}
export function saveAutomation(input: Omit<Automation, 'id' | 'nextRunAt'> & { id?: string }) {
  if (!input.name.trim() || !input.prompt.trim()) throw new Error('Enter a name and prompt');
  if (!getAgentRoster().some(agent => agent.command === input.agent)) throw new Error('Choose an installed agent');
  const automation: Automation = { ...input, name: input.name.trim(), prompt: input.prompt.trim(), id: input.id ?? crypto.randomUUID(), nextRunAt: nextOccurrence(input.schedule, input.time, input.day, Date.now()) };
  commit({ ...state, automations: [...state.automations.filter(a => a.id !== automation.id), automation] });
}
export function toggleAutomation(id: string) {
  commit({ ...state, automations: state.automations.map(a => a.id === id ? { ...a, enabled: !a.enabled, nextRunAt: nextOccurrence(a.schedule, a.time, a.day, Date.now()) } : a) });
}
export function removeAutomation(id: string) {
  if (state.runs.some(r => r.automationId === id && active(r))) throw new Error('Wait for the active run to end before deleting');
  commit({ ...state, automations: state.automations.filter(a => a.id !== id) });
}
function updateRun(id: string, patch: Partial<AutomationRun>) {
  const current = state.runs.find(r => r.id === id);
  if (!current || !active(current)) return;
  if (Object.entries(patch).every(([key, value]) => current[key as keyof AutomationRun] === value)) return;
  commit({ ...state, runs: state.runs.map(r => r.id === id ? { ...r, ...patch } : r) });
}
function canRun(a: Automation) {
  const project = get(activeProject);
  return !get(remoteTarget) && project?.id === a.projectId && project.root_path === a.root;
}
export async function runAutomation(id: string, scheduled = false): Promise<void> {
  const a = state.automations.find(item => item.id === id);
  if (!a || (scheduled && !a.enabled)) return;
  if (!canRun(a)) throw new Error('Open this automation’s local project to run it');
  if (state.runs.some(r => r.automationId === id && active(r))) throw new Error('This automation already has an active run');
  const now = Date.now();
  const missed = scheduled && now - a.nextRunAt > 15 * 60_000;
  const run: AutomationRun = { id: crypto.randomUUID(), automationId: id, name: a.name, startedAt: now, status: missed ? 'missed' : 'starting', ...(missed ? { finishedAt: now, detail: 'Schedule missed by more than 15 minutes.' } : {}) };
  commit({ automations: state.automations.map(item => item.id === id && scheduled ? { ...item, nextRunAt: nextOccurrence(a.schedule, a.time, a.day, now) } : item), runs: [run, ...state.runs].filter((r, i) => i < 100 || active(r)) });
  if (missed) return;
  let unsubscribe = () => {};
  try {
    if (!getAgentRoster().some(agent => agent.command === a.agent)) throw new Error('This agent is no longer available. Edit the automation to choose an installed agent.');
    const structured = structuredChatAgentFor(a.agent);
    if (!structured) {
      await launchTerminalAutomation(a, run);
      return;
    }
    const sessionId = await createTerminalSession(a.root, undefined, a.projectId, { assignPane: false, agentPreset: a.agent });
    if (sessionId === null) throw new Error('Could not create an agent session');
    updateRun(run.id, { sessionId });
    if (!canRun(a)) throw new Error('Project or host changed before launch');
    markStructuredChatPane(sessionId, structured as StructuredChatAgent, a.agent);
    updateSessionTitle(sessionId, `Automation: ${a.name}`);
    await startStructuredChat(structured, sessionId, a.root, { access: 'ask', model: a.model ?? null, effort: a.reasoningEffort && a.reasoningEffort !== 'default' ? a.reasoningEffort : undefined });
    if (!canRun(a)) throw new Error('Project or host changed before sending the prompt');
    if (getStructuredChat(structured, sessionId)?.status !== 'ready') throw new Error(getStructuredChat(structured, sessionId)?.error ?? 'Agent did not become ready');
    let observedWork = false;
    const observe = () => {
      const chat = getStructuredChat(structured, sessionId);
      if (!chat) return;
      if (chat.status === 'working') observedWork = true;
      if (chat.status === 'failed' || chat.status === 'closed' || (observedWork && chat.status === 'ready')) {
        const failed = Boolean(chat.error) || chat.status !== 'ready';
        updateRun(run.id, { status: failed ? 'failed' : 'completed', finishedAt: Date.now(), detail: chat.error ?? undefined });
        unsubscribe();
      } else if (observedWork) updateRun(run.id, { status: chat.approvals.length ? 'needs_input' : 'running' });
    };
    unsubscribe = subscribeStructuredChat(structured, observe);
    await sendStructuredChat(structured, sessionId, a.prompt);
    observe();
    if (!observedWork) throw new Error('Agent did not accept the prompt');
  } catch (error) {
    unsubscribe();
    updateRun(run.id, { status: 'failed', finishedAt: Date.now(), detail: String(error) });
  }
}

async function launchTerminalAutomation(a: Automation, run: AutomationRun): Promise<void> {
  const launch = getAgentProviderLaunchOptions(a.agent, { model: a.model ?? null, reasoningEffort: a.reasoningEffort ?? 'default' });
  if (a.model && a.model !== 'default' && !launch.runtimeArgs) throw new Error('This agent cannot apply the selected model. Edit the automation and choose CLI default.');
  const sessionId = await spawnAgentPreset(a.agent, a.root, { projectId: a.projectId, activate: false, skipAutoBrief: true, permissionArgsOverride: '', runtimeArgs: launch.runtimeArgs || undefined });
  if (sessionId === null) throw new Error('Could not launch the agent');
  updateRun(run.id, { sessionId });
  updateSessionTitle(sessionId, `Automation: ${a.name}`);
  let stopExit = () => {};
  let stopPhase = () => {};
  const live = () => state.runs.some(r => r.id === run.id && active(r));
  const cleanup = () => { stopExit(); stopPhase(); };
  stopExit = onSessionExit(info => {
    if (info.sessionId !== sessionId) return;
    updateRun(run.id, { status: info.code === 0 ? 'interrupted' : 'failed', finishedAt: Date.now(), detail: `Agent exited (${info.code}) without confirming completion.` });
    cleanup();
  });
  try {
    const readiness = await waitForAgentReady(sessionId);
    if (readiness !== 'ready') throw new Error(`Agent could not accept the prompt: ${readiness}`);
    if (!live()) return;
    if (!canRun(a)) throw new Error('Project or host changed before sending the prompt');
    let watching = false;
    const watch = async () => {
      if (watching || !live()) return;
      watching = true;
      try {
        const outcome = await watchLeasedAgentTurn(sessionId, { agentCommand: a.agent, shouldContinue: live });
        if (!live()) return;
        if (outcome.kind === 'blocked') updateRun(run.id, { status: 'needs_input', detail: outcome.reason });
        else {
          const status = outcome.kind === 'finished' ? (outcome.via === 'declared' ? 'completed' : outcome.via === 'exit' ? 'interrupted' : 'quiet') : outcome.kind === 'failed' || outcome.kind === 'limited' ? 'failed' : 'interrupted';
          const detail = outcome.kind === 'finished' ? outcome.detail ?? (status === 'quiet' ? 'Agent went quiet; completion was not confirmed.' : undefined) : 'reason' in outcome ? outcome.reason : undefined;
          updateRun(run.id, { status, detail, finishedAt: Date.now() });
          cleanup();
        }
      } catch (error) {
        updateRun(run.id, { status: 'failed', detail: String(error), finishedAt: Date.now() }); cleanup();
      } finally { watching = false; }
    };
    stopPhase = agentTurnStates.subscribe(all => {
      if (all[sessionId]?.phase === 'working' && live()) {
        updateRun(run.id, { status: 'running', detail: undefined });
        void watch();
      }
    });
    updateRun(run.id, { status: 'running' });
    // Arm before delivery so fast reports cannot outrun the watcher.
    void watch();
    sendPromptToSession(sessionId, a.prompt, a.agent);
  } catch (error) { cleanup(); throw error; }
}
export function startAutomationScheduler(onError: (message: string) => void): () => void {
  try { loadAutomations(); } catch (error) { onError(String(error)); return () => {}; }
  const tick = () => {
    for (const a of state.automations) {
      if (a.enabled && a.nextRunAt <= Date.now() && canRun(a) && !state.runs.some(r => r.automationId === a.id && active(r))) void runAutomation(a.id, true).catch(error => onError(String(error)));
    }
  };
  tick();
  const timer = setInterval(tick, 30_000);
  return () => clearInterval(timer);
}
