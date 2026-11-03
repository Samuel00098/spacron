import { beforeEach, describe, expect, it } from 'vitest';
import { favouriteAgentCommands, isFavouriteAgent, sortAgentsByFavourite, toggleFavouriteAgent } from './agentFavourites';

const agents = [
  { command: 'claude', name: 'Claude' },
  { command: 'codex', name: 'Codex' },
  { command: 'cursor-agent', name: 'Cursor' },
  { command: 'agy', name: 'Antigravity' },
];

beforeEach(() => {
  favouriteAgentCommands.set([]);
});

describe('chat agent favourites', () => {
  it('pins an agent to the top in pin order and leaves the rest in place', () => {
    expect(sortAgentsByFavourite(agents).map((agent) => agent.command)).toEqual([
      'claude', 'codex', 'cursor-agent', 'agy',
    ]);

    toggleFavouriteAgent('agy');
    toggleFavouriteAgent('codex');

    expect(sortAgentsByFavourite(agents).map((agent) => agent.command)).toEqual([
      'agy', 'codex', 'claude', 'cursor-agent',
    ]);
  });

  it('unpins on a second toggle and matches case-insensitively', () => {
    expect(toggleFavouriteAgent('Claude')).toBe(true);
    expect(isFavouriteAgent('claude')).toBe(true);
    expect(isFavouriteAgent('CLAUDE')).toBe(true);
    expect(isFavouriteAgent('codex')).toBe(false);

    expect(toggleFavouriteAgent('claude')).toBe(false);
    expect(isFavouriteAgent('claude')).toBe(false);
    expect(sortAgentsByFavourite(agents).map((agent) => agent.command)).toEqual(agents.map((agent) => agent.command));
  });

  it('never reorders when nothing is pinned and ignores an empty command', () => {
    expect(toggleFavouriteAgent('   ')).toBe(false);
    expect(sortAgentsByFavourite(agents)).toEqual(agents);
  });
});
