import { describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import { acpCommandsFrom, agentCommands, agentCommandsKey, commandRows, setAgentCommands } from './agent-commands';

describe('agent commands', () => {
  it('reads an ACP available_commands_update', () => {
    const notification = { method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'goal', description: 'Run  until\ndone' }, { name: '/plan' }] } } };
    expect(acpCommandsFrom(notification)).toEqual([
      { name: '/goal', description: 'Run until done' },
      { name: '/plan', description: '' },
    ]);
    expect(acpCommandsFrom({ params: { update: { sessionUpdate: 'agent_message_chunk' } } })).toBeNull();
  });

  it('drops nameless, spaced and repeated entries', () => {
    expect(commandRows([{ name: 'skill:orca' }, { name: 'two words' }, {}, null, { name: 'Skill:Orca' }]).map((c) => c.name)).toEqual(['/skill:orca']);
  });

  it('keeps a list per agent and folder, however the path is written', () => {
    expect(agentCommandsKey('grok', 'C:\\Work\\App\\')).toBe(agentCommandsKey('grok', 'c:/work/app'));
    setAgentCommands('grok', 'C:\\Work\\App', [{ name: '/loop', description: '' }]);
    setAgentCommands('grok', 'C:\\Work\\App', []);
    expect(get(agentCommands)[agentCommandsKey('grok', 'c:/work/app')]).toEqual([{ name: '/loop', description: '' }]);
  });
});
