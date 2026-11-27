import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectChatModePanel } from './ChatModePanel';

describe('ProjectChatModePanel', () => {
  // A new chat has no thread until the first message, and a project's first
  // render comes before its thread is made.
  it('renders before any thread exists', () => {
    const project = { id: 'p-empty', name: 'Empty', root_path: '/tmp/empty' };
    for (const standalone of [true, false]) {
      expect(renderToStaticMarkup(createElement(ProjectChatModePanel as FunctionComponent<Record<string, unknown>>, { chatProject: project, standalone }))).toContain('chat-mode-transcript');
    }
  });
});
