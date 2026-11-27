/**
 * The on/off switches under the chat's model list: Fast mode for Claude Code
 * and Codex, Claude Code's Ultracode and Codex's Ultra level. Which ones a
 * model gets comes from the CLI's own model list where it says.
 */

export type ModelToggleId = 'fast' | 'ultra';

export interface ModelToggleSpec {
  id: ModelToggleId;
  label: string;
  hint: string;
}

export interface ToggleModel {
  id: string;
  /** What the CLI reported; undefined where its list does not say. */
  supportsFast?: boolean;
}

/**
 * Claude Code's saved model catalogue does not mark Fast mode, so a
 * terminal-backed chat goes by name. Matches `supportsFastMode` in 2.1.332's
 * `initialize` answer: Opus 4.8 and later, Fable 5 and 5.2.
 */
export function claudeSupportsFast(modelId: string): boolean {
  const id = modelId.toLowerCase().replace(/\[1m\]$/, '');
  if (id === 'default' || id === 'opus' || id === 'fable') return true;
  return /opus-(4-[89]|[5-9])(?!\d)/.test(id) || /fable-(5(-2)?$|[6-9])/.test(id);
}

export function modelTogglesFor(
  agent: string | null,
  model: ToggleModel | null,
  efforts: readonly string[],
): ModelToggleSpec[] {
  if (agent !== 'claude' && agent !== 'codex') return [];
  const toggles: ModelToggleSpec[] = [];
  const fast = model ? model.supportsFast ?? (agent === 'claude' && claudeSupportsFast(model.id)) : false;
  if (fast) {
    toggles.push({ id: 'fast', label: 'Fast', hint: 'Quicker answers at a higher usage cost' });
  }
  if (agent === 'claude' && efforts.includes('xhigh')) {
    toggles.push({ id: 'ultra', label: 'Ultracode', hint: 'Runs agent workflows on every task' });
  }
  if (agent === 'codex' && efforts.includes('ultra')) {
    toggles.push({ id: 'ultra', label: 'Ultra', hint: 'Highest reasoning, delegates tasks itself' });
  }
  return toggles;
}
