import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextHandoffButton from './ContextHandoffButton';

vi.mock('$lib/services/structured-chat/handoff-coordinator', () => ({
  isHandoffInProgress: vi.fn((_id: number) => false),
  usePaneHandoff: vi.fn((_id: number) => null),
  initiateHandoff: vi.fn(),
  clearPaneHandoff: vi.fn(),
}));

vi.mock('$lib/stores/runs', () => ({
  getAgentRoster: vi.fn(() => [
    { command: 'claude', name: 'Claude Code' },
    { command: 'codex', name: 'Codex' },
  ]),
}));

vi.mock('$lib/stores/terminal', () => ({
  getSessionRoot: vi.fn(() => '/workspace/repo'),
}));

vi.mock('$lib/services/structured-chat/panes', () => ({
  structuredChatAgentFor: vi.fn((cmd: string) => (cmd === 'codex' ? 'codex' : null)),
}));

vi.mock('$lib/services/structured-chat/registry', () => ({
  structuredChatProvider: vi.fn((agent: string) => ({
    agent,
    label: agent.toUpperCase(),
  })),
}));

vi.mock('$lib/components/shared/useAgentBrand', () => ({
  AgentBrandMark: () => <span data-testid="agent-brand-mark" />,
}));

describe('ContextHandoffButton', () => {
  it('renders the handoff button with accessible label', () => {
    render(
      <ContextHandoffButton
        sessionId={1}
        sourceAgentName="Claude Code"
        sourcePreset="claude"
      />
    );

    const button = screen.getByRole('button', { name: /hand off context to another agent/i });
    expect(button).toBeDefined();
    expect(button.getAttribute('title')).toBe('Hand off context to another agent');
  });

  it('opens the modal when clicked', () => {
    render(
      <ContextHandoffButton
        sessionId={1}
        sourceAgentName="Claude Code"
        sourcePreset="claude"
      />
    );

    const button = screen.getByRole('button', { name: /hand off context to another agent/i });
    fireEvent.click(button);

    // The modal should portal to body and display the title
    expect(screen.getByRole('dialog', { name: /hand off context to another agent/i })).toBeDefined();
    expect(screen.getByText('Claude Code')).toBeDefined();
    expect(screen.getByText('/workspace/repo')).toBeDefined();
    expect(screen.getByRole('radio', { name: /codex/i })).toBeDefined();
  });
});
