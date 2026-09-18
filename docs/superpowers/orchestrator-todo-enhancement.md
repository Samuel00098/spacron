# Orchestrator Todo Enhancement — Research & Implementation Plan

## Executive Summary

The goal is to elevate the orchestrator from a pure delegator to a competitive agent that handles planning and execution on par with Claude Code, Codex CLI, and OpenCode. The key insight: **Understand first, plan second, execute third** — rather than immediately delegating.

## Current State Analysis

### What We Have
- `update_todos` tool with status markers: `[ ]`, `[~]`, `[x]`, `[!]`, `[-]`
- Sticky merging (`mergeTodoItems`) to prevent paraphrase duplicates
- Auto-completion based on tool results (`advanceTodoItems`)
- `MAX_TICKER_ITEMS = 6` cap
- Fuzzy deduplication with verb classes and word stemming

### What's Missing (Competitive Gap)

| Feature | Claude Code | Codex CLI | OpenCode | Spacron |
|---------|-------------|-----------|----------|---------|
| Forced exploration before planning | Plan mode | read-only | No | No |
| Hierarchical tasks (tasks to subtasks) | TaskCreate | subagents | No | No |
| Dependency tracking | No | dependency graph | No | No |
| Verification step | acceptance criteria | PostToolUse hooks | No | No |
| Structured completion report | Yes | No | No | No |
| Recon integration | No | No | No | No (recon.ts exists) |

## Implementation Plan

### Phase 1: Forced Exploration Before Planning

**Problem**: The brain currently creates todo lists without first understanding the project. This leads to incomplete or irrelevant plans.

**Solution**: Add a mandatory exploration phase for multi-step tasks.

```typescript
// In orchestrator-brain.ts, add to system prompt:
'- EXPLORATION FIRST: For any task requiring 3+ steps, you MUST call read_project or glob_files + grep_code BEFORE creating a todo list. The plan must be grounded in what you actually found, not what you assume exists. Only after gathering context should you call update_todos with your plan.',
```

**Implementation**:
1. Add a new brain mode `explore` that runs before `plan`
2. In `explore` mode, only read-only tools are available
3. The explore results feed into the plan phase
4. The plan phase then creates the todo list

### Phase 2: Hierarchical Task Structure

**Problem**: Flat todo lists don't capture the relationship between tasks.

**Solution**: Extend `ChatTurnTodoItem` to support subtasks.

```typescript
export interface ChatTurnTodoItem {
  label: string;
  done: boolean;
  status?: TodoStatus;
  reason?: string;
  // NEW: Subtasks
  subtasks?: ChatTurnTodoItem[];
  // NEW: Dependency (task IDs that must complete first)
  dependsOn?: string[];
  // NEW: Unique ID for dependency tracking
  id?: string;
}
```

**Implementation**:
1. Add `id` field to `ChatTurnTodoItem`
2. Extend `update_todos` to accept nested structure
3. Update `mergeTodoItems` to handle nested structure
4. Update `advanceTodoItems` to auto-complete subtasks

### Phase 3: Dependency Tracking

**Problem**: Tasks can start before their prerequisites are done.

**Solution**: Enforce dependency order in the todo system.

**Implementation**:
1. In `advanceTodoItems`, check `dependsOn` before marking a task as in_progress
2. In the UI, show blocked tasks differently (greyed out with "waiting on: X")
3. In the brain prompt, add:
   ```
   '- DEPENDENCY ORDER: When tasks have dependencies (dependsOn), never mark a task as in_progress until all its dependencies are completed. The system will enforce this automatically.'
   ```

### Phase 4: Verification Step

**Problem**: Tasks auto-complete based on tool results, but we don't verify correctness.

**Solution**: Add a verification phase after implementation.

**Implementation**:
1. After all tasks complete, automatically run verification:
   - `run_command` for tests/typecheck/build
   - Compare results against success criteria
2. In the completion report, clearly state:
   - What works (verified)
   - What works but unverified
   - What doesn't work
   - What needs improvement

### Phase 5: Structured Completion Report

**Problem**: Completion reports are prose-based, not structured.

**Solution**: Generate a structured report at the end of each turn.

```typescript
export interface CompletionReport {
  completed: Array<{
    task: string;
    files: string[];
    verified: boolean;
    evidence: string;
  }>;
  failed: Array<{
    task: string;
    reason: string;
    suggestion: string;
  }>;
  improvements: Array<{
    area: string;
    current: string;
    suggested: string;
  }>;
  verification: {
    tests: 'pass' | 'fail' | 'skipped';
    typecheck: 'pass' | 'fail' | 'skipped';
    build: 'pass' | 'fail' | 'skipped';
  };
}
```

**Implementation**:
1. Add `formatStructuredReport` function in `chat-turn.ts`
2. Call it in the FINAL reply generation
3. Include in the completion card

### Phase 6: Recon Integration

**Problem**: `recon.ts` exists but is not used in the brain's planning flow.

**Solution**: Integrate reconnaissance into the planning phase.

**Implementation**:
1. Before creating a plan for complex tasks, automatically run recon
2. Feed recon findings into the plan creation
3. Use recon to identify relevant files for the todo list

## Priority Order

1. **Phase 1: Forced Exploration** — Quick win, high impact
2. **Phase 5: Structured Reports** — Quick win, high visibility
3. **Phase 2: Hierarchical Tasks** — Medium effort, high value
4. **Phase 3: Dependency Tracking** — Builds on Phase 2
5. **Phase 4: Verification** — Builds on Phase 2
6. **Phase 6: Recon Integration** — Builds on Phase 1

## Testing Strategy

1. Unit tests for new `ChatTurnTodoItem` structure
2. Unit tests for dependency resolution
3. Integration tests for exploration, planning, execution flow
