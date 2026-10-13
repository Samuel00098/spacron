import { describe, expect, it } from 'vitest';
import { advanceTodoItems, agentInputRequest, buildCompletionReport, cleanOrchestratorReply, closeOutTodoItems, composeTurnReply, splitCarriedOverTodos, todoProgress, findClaimedWritePaths, findOmittedPlanItems, formatDocumentsIndexBlock, formatStructuredReport, formatTodoListMarkdown, formatTurnSummary, hasUnverifiedMutation, isDeferredCompletionReply, isPromiseOnlyReply, mediaGenerationRequest, userRequestText, attachedImagePaths, mergeTodoItems, parseTodoList, replyClaimsDocumentWrite, todoIsDone, todoMarkerStatus, writeEvidenceCoversClaims, MAX_PLAN_ITEMS, type ChatTurnTodoItem } from './chat-turn';
import type { BrainToolResult } from './brain-tools';

function toolResult(overrides: Partial<BrainToolResult> & Pick<BrainToolResult, 'name'>): BrainToolResult {
  return { id: 't1', ok: true, output: 'ok', ...overrides };
}

describe('Chat turn presentation', () => {
  it('recognizes the reported promise without rejecting a substantive report', () => {
    expect(isPromiseOnlyReply('I’ll take a quick look through the project’s core files and summarize how it’s structured and what it’s doing.')).toBe(true);
    expect(isPromiseOnlyReply('The app uses React. Authentication is implemented in auth.ts.')).toBe(false);
    // An image request that ended with no generate_image call and no picture.
    expect(isPromiseOnlyReply('I’ll generate a cheerful golden retriever in a sunny meadow.')).toBe(true);
  });

  describe('isDeferredCompletionReply', () => {
    it('catches the screenshot deferral: claim, then offer', () => {
      const screenshot = 'Absolutely, I’ve inspected the project at a high level and I can already see a few good improvement areas. The codebase is fairly Convex heavy, so the most valuable next step is to review the schema, auth, and hot path queries, then I can give you concrete recommendations instead of generic advice.';
      expect(isDeferredCompletionReply(screenshot)).toBe(true);
      expect(isDeferredCompletionReply("I've reviewed the files. Next step is the schema audit, then I can give you concrete recommendations.")).toBe(true);
      expect(isDeferredCompletionReply('The initial look is done. From there I can walk through the detail. Let me know if you want me to continue.')).toBe(true);
    });

    it('accepts genuine completed reports', () => {
      expect(isDeferredCompletionReply('I reviewed the schema. Findings: the users table lacks an index on email, and the auth check runs a full scan.')).toBe(false);
      expect(isDeferredCompletionReply('Here is what the app does: it proxies previews and drives agents.')).toBe(false);
      expect(isDeferredCompletionReply('- The store is bloated\n- The brain loop is bounded')).toBe(false);
    });

    it('stays out of ordinary conversation', () => {
      expect(isDeferredCompletionReply('Hello! How can I help today?')).toBe(false);
      expect(isDeferredCompletionReply('Got it.')).toBe(false);
      expect(isDeferredCompletionReply('')).toBe(false);
    });
  });

  describe('five-state todo model', () => {
    it('parses every status marker', () => {
      expect(todoMarkerStatus('[ ] Read files')).toEqual({ status: 'pending', text: 'Read files' });
      expect(todoMarkerStatus('[~] Fix token refresh')).toEqual({ status: 'in_progress', text: 'Fix token refresh' });
      expect(todoMarkerStatus('[x] Read tests')).toEqual({ status: 'completed', text: 'Read tests' });
      expect(todoMarkerStatus('[!] Needs the API base URL')).toEqual({ status: 'blocked', text: 'Needs the API base URL' });
      expect(todoMarkerStatus('[-] Skip the docs pass')).toEqual({ status: 'cancelled', text: 'Skip the docs pass' });
      expect(todoMarkerStatus('No marker here')).toEqual({ status: null, text: 'No marker here' });
    });

    it('derives done only from completed and cancelled', () => {
      expect(todoIsDone('completed', false)).toBe(true);
      expect(todoIsDone('cancelled', false)).toBe(true);
      expect(todoIsDone('blocked', false)).toBe(false);
      expect(todoIsDone('in_progress', false)).toBe(false);
      expect(todoIsDone('pending', false)).toBe(false);
      // No model-declared status: fall back to the runtime-derived bit.
      expect(todoIsDone(null, true)).toBe(true);
      expect(todoIsDone(undefined, false)).toBe(false);
    });

    it('parses structured update_todos entries with statuses', () => {
      const raw = JSON.stringify({ todos: ['[ ] Inspect auth wiring', '[~] Fix token refresh', '[x] Read tests', '[!] Blocked on the API URL'] });
      const parsed = parseTodoList('', raw);
      expect(parsed.map((t) => t.label)).toEqual(['Inspect auth wiring', 'Fix token refresh', 'Read tests', 'Blocked on the API URL']);
      expect(parsed.map((t) => t.status)).toEqual(['pending', 'in_progress', 'completed', 'blocked']);
      expect(parsed.map((t) => t.done)).toEqual([false, false, true, false]);
    });

    it('never second-guesses model-declared statuses when advancing', () => {
      const todos: ChatTurnTodoItem[] = [
        { label: 'Declared done', done: true, status: 'completed' },
        { label: 'Review project: active project', done: false },
      ];
      const advanced = advanceTodoItems(todos, [toolResult({ id: '1', name: 'read_project', output: 'Read 20 files' })]);
      // The legacy item advances from evidence; the declared one is untouched.
      expect(advanced.todos[0].status).toBe('completed');
      expect(advanced.todos[1].done).toBe(true);
    });

    it('renders statuses as honest markers in the final checklist', () => {
      const md = formatTodoListMarkdown([
        { label: 'Done item', done: true, status: 'completed' },
        { label: 'Active item', done: false, status: 'in_progress' },
        { label: 'Stuck item', done: false, status: 'blocked', reason: 'needs credentials' },
        { label: 'Dropped item', done: true, status: 'cancelled' },
        { label: 'Waiting item', done: false },
      ]);
      expect(md).toContain('- [x] Done item');
      expect(md).toContain('- [~] Active item');
      expect(md).toContain('- [!] Stuck item (needs credentials)');
      expect(md).toContain('- [-] Dropped item');
      expect(md).toContain('- [ ] Waiting item');
    });
  });

  describe('plan counts and follow-up turns', () => {
    it('counts by status and leaves cancelled rows out of both sides', () => {
      expect(todoProgress([
        { label: 'a', done: true, status: 'completed' },
        { label: 'b', done: true, status: 'cancelled' },
        { label: 'c', done: true, status: 'pending' },
        { label: 'd', done: true },
      ])).toEqual({ completed: 2, total: 3 });
    });

    it('closes out the working row but never paints untouched pending work green', () => {
      const closed = closeOutTodoItems([
        { label: 'a', done: false, status: 'completed' },
        { label: 'b', done: false, status: 'in_progress' },
        { label: 'c', done: false, status: 'pending' },
        { label: 'd', done: false, status: 'blocked' },
        { label: 'e', done: false },
      ]);
      expect(closed.map((t) => [t.status, t.done])).toEqual([
        ['completed', true], ['completed', true], ['pending', false], ['blocked', false], ['completed', true],
      ]);
      expect(todoProgress(closed)).toEqual({ completed: 3, total: 5 });
    });

    it('drops rows a follow-up copies from the finished previous plan, but keeps redo requests', () => {
      const previous = [
        { label: 'Inspect the auth module', done: true, status: 'completed' as const },
        { label: 'Fix the token refresh', done: true, status: 'completed' as const },
      ];
      const { fresh, carried } = splitCarriedOverTodos(previous, [
        { label: 'Inspect the auth module', done: true, status: 'completed' },
        { label: 'Fix the token refresh', done: false, status: 'pending' },
        { label: 'Add a logout button', done: false, status: 'in_progress' },
      ]);
      expect(carried.map((t) => t.label)).toEqual(['Inspect the auth module']);
      expect(fresh.map((t) => t.label)).toEqual(['Fix the token refresh', 'Add a logout button']);
    });
  });

  describe('mergeTodoItems (sticky ticker)', () => {
    const seed: ChatTurnTodoItem[] = [
      { label: 'Review project: active project', done: true },
      { label: 'Search: authenticate', done: false },
    ];

    it('appends new items and never shrinks or rewords the existing list', () => {
      const merged = mergeTodoItems(seed, [
        { label: 'Search: auth middleware', done: false },
        { label: 'Run: npm test', done: false },
      ]).todos;
      expect(merged.map((t) => t.label)).toEqual(['Review project: active project', 'Search: authenticate', 'Search: auth middleware', 'Run: npm test']);
    });

    it('treats reworded re-announcements of the same step as the same item', () => {
      const merged = mergeTodoItems(seed, [
        { label: 'Review: project!', done: false },
        { label: 'search authenticate', done: false },
      ]).todos;
      expect(merged).toHaveLength(2);
      // Finished items are never un-finished by a re-announce.
      expect(merged[0].done).toBe(true);
      expect(merged[1].done).toBe(false);
    });

    it('updates model-declared status on the existing item without un-finishing it', () => {
      const withDeclared: ChatTurnTodoItem[] = [{ label: 'Fix token refresh', done: true, status: 'completed' }];
      const merged = mergeTodoItems(withDeclared, [{ label: 'Fix token refresh', done: false, status: 'in_progress' }]).todos;
      expect(merged[0].status).toBe('completed');
      expect(merged[0].done).toBe(true);
    });

    it('adopts the incoming list on the first merge and ignores empty merges', () => {
      const adopted = mergeTodoItems([], [{ label: 'Only step', done: false }]).todos;
      expect(adopted.map((t) => t.label)).toEqual(['Only step']);
      expect(mergeTodoItems(seed, []).todos).toBe(seed);
    });

    it('merges re-narrated plans whose verbs differ but intent matches', () => {
      // The 24-item ticker bug: recovery rounds reworded the same four steps.
      let todos: ChatTurnTodoItem[] = [];
      const rounds = [
        ['Review app structure and identify frontend and UX improvements', 'Review Convex backend for schema consistency and performance hotspots', 'Review docs and onboarding flow for clarity gaps', 'Summarize concrete findings and improvement priorities'],
        ['Check core backend Convex auth, schema, and query safety', 'Check frontend routes, pages, and UX gaps', 'Review docs and onboarding flow for clarity and completeness', 'Summarize working, broken, and improvements'],
        ['Assess backend correctness and hotspots', 'Assess frontend and UX structure', 'Assess documentation and onboarding flow', 'Summarize what works, what is broken, and what to improve'],
      ];
      for (const round of rounds) {
        todos = mergeTodoItems(todos, round.map((label) => ({ label, done: false }))).todos;
      }
      // Re-announcements reconcile into the original rows instead of piling up.
      expect(todos).toHaveLength(4);
    });

    it('keeps a complete multi-step plan instead of truncating it to six', () => {
      const labels = [
        'Plan the migration',
        'Back up the database cluster',
        'Migrate user records',
        'Migrate order records',
        'Migrate billing records',
        'Rebuild the search index',
        'Verify the totals match',
        'Flip the read replica',
      ];
      const todos = mergeTodoItems([], labels.map((label) => ({ label, done: false }))).todos;
      expect(todos.map((todo) => todo.label)).toEqual(labels);
    });

    it('adds genuinely discovered work when the plan is restated with it', () => {
      const seeded: ChatTurnTodoItem[] = [
        { label: 'Plan the migration', done: false },
        { label: 'Back up the database cluster', done: false },
        { label: 'Migrate user records', done: false },
        { label: 'Migrate order records', done: false },
        { label: 'Migrate billing records', done: false },
        { label: 'Rebuild the search index', done: false },
      ];
      const restated = seeded.map((t) => ({ ...t }));
      const merged = mergeTodoItems(seeded, [...restated, { label: 'Flip the read replica', done: false }]);
      expect(merged.truncated).toBe(false);
      expect(merged.todos).toHaveLength(7);
      expect(merged.todos[6].label).toBe('Flip the read replica');
      expect(merged.todos.slice(0, 6).map((t) => t.label)).toEqual(seeded.map((t) => t.label));
    });

    it('reconciles a wholesale re-narration instead of piling up near-duplicates', () => {
      // The real shape of the old "24-item ticker" bug: the model retold the
      // same plan in words the fuzzy matcher cannot link, so every retelling
      // used to append. The list must stay the same length.
      const narration = [
        ['Review the auth flow end to end', 'Review the billing flow end to end', 'Review the export flow end to end'],
        ['Check how sign-in tokens travel through the app', 'Check how invoices are created and charged', 'Check how reports are generated and downloaded'],
      ];
      let todos: ChatTurnTodoItem[] = [];
      for (const round of narration) {
        todos = mergeTodoItems(todos, round.map((label) => ({ label, done: false }))).todos;
      }
      expect(todos).toHaveLength(3);
      expect(todos.map((t) => t.label)).toEqual(narration[1]);
    });

    it('adopts the latest wording for an open row instead of re-adding it', () => {
      const merged = mergeTodoItems(
        [{ label: 'Review Convex backend for schema consistency', done: false }],
        [{ label: 'Review Convex backend schema consistency and performance hotspots', done: false }],
      ).todos;
      expect(merged).toHaveLength(1);
      expect(merged[0].label).toBe('Review Convex backend schema consistency and performance hotspots');
    });

    it('recycles a finished row to make room at the ceiling, never a pending one', () => {
      const pending: ChatTurnTodoItem[] = Array.from({ length: MAX_PLAN_ITEMS - 1 }, (_, i) => ({ label: `Pending step ${i + 1}`, done: false }));
      const atCeiling: ChatTurnTodoItem[] = [{ label: 'Finished setup task', done: true }, ...pending];
      const merged = mergeTodoItems(atCeiling, [...pending, { label: 'Flip the read replica', done: false }]);
      expect(merged.truncated).toBe(false);
      expect(merged.todos).toHaveLength(MAX_PLAN_ITEMS);
      expect(merged.todos.some((t) => t.label === 'Finished setup task')).toBe(false);
      expect(merged.todos.some((t) => t.label === 'Flip the read replica')).toBe(true);
      expect(merged.todos.filter((t) => t.label.startsWith('Pending step'))).toHaveLength(MAX_PLAN_ITEMS - 1);
      expect(merged.todos.some((t) => t.label.startsWith('…and '))).toBe(false);
    });

    it('makes room for a new step when the same update completes a row at the ceiling', () => {
      const plan: ChatTurnTodoItem[] = Array.from({ length: MAX_PLAN_ITEMS }, (_, i) => ({
        id: `step-${i}`, label: `Pending step ${i + 1}`, done: false, status: 'pending',
      }));
      const merged = mergeTodoItems(plan, [
        { ...plan[0], status: 'completed', done: true },
        ...plan.slice(1),
        { id: 'new-step', label: 'Flip the read replica', done: false, status: 'pending' },
      ]);
      expect(merged.truncated).toBe(false);
      expect(merged.todos).toHaveLength(MAX_PLAN_ITEMS);
      expect(merged.todos.map((item) => item.id)).toEqual([...plan.slice(1).map((item) => item.id), 'new-step']);
    });

    it('refuses an addition at the ceiling rather than dropping pending work', () => {
      const fullPlan: ChatTurnTodoItem[] = Array.from({ length: MAX_PLAN_ITEMS }, (_, i) => ({ label: `Pending step ${i + 1}`, done: false }));
      const merged = mergeTodoItems(fullPlan, [...fullPlan, { label: 'Flip the read replica', done: false }]);
      expect(merged.truncated).toBe(true);
      expect(merged.todos).toHaveLength(MAX_PLAN_ITEMS);
      expect(merged.todos.map((t) => t.label)).toEqual(fullPlan.map((t) => t.label));
    });
  });

  describe('findOmittedPlanItems (authoritative plan)', () => {
    const plan: ChatTurnTodoItem[] = [
      { label: 'Inspect the routing', done: false, status: 'pending' },
      { label: 'Fix the emit path', done: false, status: 'in_progress' },
      { label: 'Add regression coverage', done: false, status: 'pending' },
      { label: 'Run focused verification', done: false, status: 'pending' },
      { label: 'Write the changelog entry', done: true, status: 'completed' },
    ];

    it('reports the unfinished rows a later update stopped re-stating', () => {
      const omitted = findOmittedPlanItems(plan, [{ label: 'Fix the emit path', done: false, status: 'in_progress' }]);
      expect(omitted.map((t) => t.label)).toEqual(['Inspect the routing', 'Add regression coverage', 'Run focused verification']);
    });

    it('accepts a complete restatement and ignores rows already finished', () => {
      const omitted = findOmittedPlanItems(plan, [
        { label: 'Inspect the routing', done: false, status: 'pending' },
        { label: 'Fix the emit path', done: false, status: 'in_progress' },
        { label: 'Add regression coverage', done: false, status: 'pending' },
        { label: 'Run focused verification', done: false, status: 'pending' },
      ]);
      expect(omitted).toEqual([]);
    });

    it('treats a reworded row as still present', () => {
      const omitted = findOmittedPlanItems(plan, [
        { label: 'Inspect the orchestrator routing path', done: false, status: 'pending' },
        { label: 'Fix the emit path', done: false, status: 'in_progress' },
        { label: 'Add regression coverage', done: false, status: 'pending' },
        { label: 'Run focused verification', done: false, status: 'pending' },
      ]);
      expect(omitted).toEqual([]);
    });

    it('does not enforce a stub plan the model is still forming', () => {
      const stub: ChatTurnTodoItem[] = [{ label: 'Only step so far', done: false, status: 'pending' }];
      // The full plan replaces the one-liner freely; nothing is treated as dropped.
      expect(findOmittedPlanItems(stub, [{ label: 'A completely different first step', done: false, status: 'pending' }])).toEqual([]);
    });

    it('does not report a row whose id is re-sent under new wording', () => {
      const withId: ChatTurnTodoItem[] = [
        { id: 'step-1', label: 'Inspect the routing', done: false },
        { id: 'step-2', label: 'Fix the emit path', done: false },
      ];
      const omitted = findOmittedPlanItems(withId, [
        { id: 'step-1', label: 'Inspect every routing branch', done: false },
        { id: 'step-2', label: 'Fix the emit path', done: false },
      ]);
      expect(omitted).toEqual([]);
    });
  });

  describe('formatDocumentsIndexBlock', () => {
    it('lists indexed documents with title and excerpt', () => {
      const block = formatDocumentsIndexBlock([
        { path: 'docs/plans/2026-09-01-auth-plan.md', title: 'Auth overhaul plan', excerpt: 'Goal: unify token refresh across all clients.' },
      ]);
      expect(block).toContain('docs/plans/2026-09-01-auth-plan.md');
      expect(block).toContain('Auth overhaul plan');
      expect(block).toContain('Goal: unify token refresh');
      expect(block).toContain('read_file');
    });

    it('returns null with no usable entries so no empty header renders', () => {
      expect(formatDocumentsIndexBlock([])).toBeNull();
      expect(formatDocumentsIndexBlock([{ path: '', title: 'x' }])).toBeNull();
    });
  });

  describe('claimed-write detection', () => {
    it('extracts backticked and plain paths from creation claims', () => {
      expect(findClaimedWritePaths('File created: `docs/2026-09-17-app-review-suggestions.md`')).toEqual(['docs/2026-09-17-app-review-suggestions.md']);
      expect(findClaimedWritePaths('I created notes/ideas.md with the summary.')).toEqual(['notes/ideas.md']);
      expect(findClaimedWritePaths('I have written docs/deep/dir/report.md with the full review.')).toEqual(['docs/deep/dir/report.md']);
      // A mere reference to an existing file is not a creation claim.
      expect(findClaimedWritePaths('The report is at docs/deep/dir/report.md.')).toEqual([]);
    });

    it('ignores reads, links, and offers', () => {
      expect(findClaimedWritePaths('I read docs/plan.md and reviewed it.')).toEqual([]);
      expect(findClaimedWritePaths('See [the guide](docs/guide.md) for details.')).toEqual([]);
      expect(findClaimedWritePaths('I can also turn this into a shorter executive summary.')).toEqual([]);
    });

    it('flags document claims even without a path, but not offers or generic docs', () => {
      expect(replyClaimsDocumentWrite('I saved the suggestions as a project document.')).toBe(true);
      expect(replyClaimsDocumentWrite('File created: `docs/plan.md`')).toBe(true);
      expect(replyClaimsDocumentWrite('I can also turn this into a shorter executive summary if you want.')).toBe(false);
      expect(replyClaimsDocumentWrite('Here is what the documentation says about the API.')).toBe(false);
    });

    it('checks write evidence against the claimed paths by basename', () => {
      const outputs = ['Wrote docs/2026-09-17-app-review-suggestions.md (2400 chars).'];
      expect(writeEvidenceCoversClaims(['docs/2026-09-17-app-review-suggestions.md'], outputs)).toBe(true);
      expect(writeEvidenceCoversClaims(['docs/other-plan.md'], outputs)).toBe(false);
      expect(writeEvidenceCoversClaims([], outputs)).toBe(true);
      expect(writeEvidenceCoversClaims(['docs/plan.md'], [])).toBe(false);
    });
  });

  // No plan-card tests here on purpose: the narration-derived plan card and its
  // helpers (`planCardTitle`, `planSignalText`) were removed so the turn's plan
  // has a single surface — the live ticker driven by the update_todos tool. The
  // ticker's own rules are covered by the `mergeTodoItems` and
  // `findOmittedPlanItems` suites below.

  describe('parseTodoList + advanceTodoItems', () => {
    it('extracts only actionable tool rows, never the narration line', () => {
      const todos = parseTodoList('Plan: map the project structure first.\nReview project: active project\nSearch: authenticate');
      expect(todos.map((todo) => todo.label)).toEqual(['Review project: active project', 'Search: authenticate']);
      expect(todos.every((todo) => !todo.done)).toBe(true);
    });

    it('ticks off matching items in order and skips failed results', () => {
      const todos = parseTodoList('Review project: active project\nSearch: authenticate\nRun: npm test');
      const advanced = advanceTodoItems(todos, [
        toolResult({ id: 'a', name: 'grep_code', ok: false, output: 'authenticate: src/auth.ts:12' }),
        toolResult({ id: 'b', name: 'read_project', output: 'Read 42 files' }),
        toolResult({ id: 'c', name: 'grep_code', output: 'authenticate: src/auth.ts:12' }),
      ]);
      expect(advanced.changed).toBe(true);
      expect(advanced.todos[0].done).toBe(true);
      expect(advanced.todos[1].done).toBe(true);
      expect(advanced.todos[2].done).toBe(false);
    });

    it('returns the same list unchanged when nothing matches', () => {
      const todos = parseTodoList('Run: npm test');
      const advanced = advanceTodoItems(todos, [toolResult({ id: 'a', name: 'read_file', output: 'src/auth.ts' })]);
      expect(advanced.changed).toBe(false);
      expect(advanced.todos).toBe(todos);
    });

    it('parses numbered steps and markdown checklists', () => {
      const numbered = parseTodoList('Plan: auth updates\n1. Inspect auth setup\n2. Modify src/auth.ts\n3. Run tests');
      expect(numbered.map((t) => t.label)).toEqual(['Inspect auth setup', 'Modify src/auth.ts', 'Run tests']);
      expect(numbered.every((t) => !t.done)).toBe(true);

      const checkboxes = parseTodoList('- [ ] Read package.json\n- [x] Review schema\n- [ ] Run verification');
      expect(checkboxes[0]).toEqual({ label: 'Read package.json', done: false });
      expect(checkboxes[1]).toEqual({ label: 'Review schema', done: true });
      expect(checkboxes[2]).toEqual({ label: 'Run verification', done: false });
    });

    it('parses structured todos from raw JSON response', () => {
      const raw = JSON.stringify({
        tool_calls: [{ id: '1', name: 'read_file', args: { path: 'package.json' } }],
        todos: ['1. Explore repo', '2. Update config', '3. Verify'],
      });
      const parsed = parseTodoList('', raw);
      expect(parsed.map((t) => t.label)).toEqual(['Explore repo', 'Update config', 'Verify']);
    });

    it('advances todos with semantic matching for run_command, edit_file, and read_file', () => {
      const todos = [
        { label: 'Explore repo structure', done: false },
        { label: 'Update src/auth.ts', done: false },
        { label: 'Run test suite', done: false },
      ];
      const step1 = advanceTodoItems(todos, [toolResult({ id: '1', name: 'read_project', output: 'Read 20 files' })]);
      expect(step1.todos[0].done).toBe(true);
      expect(step1.todos[1].done).toBe(false);

      const step2 = advanceTodoItems(step1.todos, [toolResult({ id: '2', name: 'edit_file', output: 'Edited src/auth.ts' })]);
      expect(step2.todos[1].done).toBe(true);
      expect(step2.todos[2].done).toBe(false);

      const step3 = advanceTodoItems(step2.todos, [toolResult({ id: '3', name: 'run_command', output: 'exit 0: `npm test`' })]);
      expect(step3.todos[2].done).toBe(true);
    });
  });

  describe('composeTurnReply', () => {
    it('folds the summary into one response body', () => {
      expect(composeTurnReply('Here are the findings.', 'Reviewed 9 sources')).toBe('Here are the findings.\n\nReviewed 9 sources');
      expect(composeTurnReply('Just the reply.', null)).toBe('Just the reply.');
      expect(composeTurnReply('   ', 'Reviewed 9 sources')).toBe('Reviewed 9 sources');
    });

    it('appends completed to-do checklist to report', () => {
      const todos = [
        { label: 'Inspect files', done: true },
        { label: 'Run tests', done: true },
      ];
      const composed = composeTurnReply('Task complete.', 'Ran npm test (exit 0)', todos);
      expect(composed).toContain('Task complete.');
      expect(composed).toContain('### Plan & Tasks');
      expect(composed).toContain('- [x] Inspect files');
      expect(composed).toContain('- [x] Run tests');
      expect(composed).toContain('Ran npm test (exit 0)');
    });

    it('replaces the one-line summary with the structured report for a turn that worked', () => {
      const composed = composeTurnReply(
        'Fixed the lookup.',
        'Changed src/auth.ts; Ran `npm test` (exit 0 in 2.0s). Full detail in Work details above.',
        undefined,
        [
          toolResult({ id: 'a', name: 'edit_file', output: 'Edited src/auth.ts (replaced 12 chars).' }),
          toolResult({ id: 'b', name: 'run_command', output: 'exit 0 in 2.0s: `npm test`\n12 passed' }),
        ],
      );
      expect(composed).toContain('Fixed the lookup.');
      expect(composed).toContain('### What is working');
      expect(composed).toContain('- Edited src/auth.ts [verified]');
      expect(composed).toContain('### Verification');
      expect(composed).toContain('Tests: PASSED');
      // REPLACED, so the evidence line is not printed twice.
      expect(composed).not.toContain('Full detail in Work details above.');
    });

    it('keeps the compact summary for a read-only turn', () => {
      const composed = composeTurnReply(
        'Here is the structure.',
        'Reviewed project snapshot (39 of 80 files)',
        undefined,
        [toolResult({ id: 'a', name: 'read_project', output: 'Broad project snapshot: read 39 of 80 relevant text file(s), 90000 characters.' })],
      );
      expect(composed).toContain('Reviewed project snapshot (39 of 80 files)');
      expect(composed).not.toContain('### Verification');
      expect(composed).not.toContain('### What is working');
    });

    it('keeps a chat reply conversational: no file recap or summary line, failures and checks stay', () => {
      const wrote = toolResult({ id: 'a', name: 'write_file', output: 'Wrote school-plan.md (1200 chars).' });
      const plain = composeTurnReply('I drafted the plan.', 'Changed school-plan.md\nFull detail in Work details above.', undefined, [wrote], { conversational: true });
      expect(plain).toBe('I drafted the plan.');

      const failed = composeTurnReply(
        'Updated the lookup.',
        'Changed src/auth.ts',
        undefined,
        [
          toolResult({ id: 'b', name: 'edit_file', output: 'Edited src/auth.ts (replaced 12 chars).' }),
          toolResult({ id: 'c', name: 'run_command', ok: false, output: 'exit 1 in 2.0s: `npm test`\n1 failed' }),
        ],
        { conversational: true },
      );
      expect(failed).not.toContain('### What is working');
      expect(failed).toContain('### What is not working');
      expect(failed).toContain('Tests: FAILED');

      const readOnly = composeTurnReply('It uses JWTs.', 'Reviewed src/auth.ts\nFull detail in Work details above.', undefined,
        [toolResult({ id: 'd', name: 'read_file', output: 'src/auth.ts' })], { conversational: true });
      expect(readOnly).toBe('It uses JWTs.');
    });

    it('never prints a section the model already headed itself', () => {
      const composed = composeTurnReply(
        'Done.\n\n### What is working\n- The lookup is fixed.',
        'Changed src/auth.ts',
        undefined,
        [
          toolResult({ id: 'a', name: 'edit_file', output: 'Edited src/auth.ts (replaced 12 chars).' }),
          toolResult({ id: 'b', name: 'run_command', output: 'exit 0 in 2.0s: `npm test`\n12 passed' }),
        ],
      );
      expect(composed.match(/### What is working/g)).toHaveLength(1);
      // The runtime-owned section still appears beside the model's prose.
      expect(composed).toContain('### Verification');
    });
  });

  describe('formatTurnSummary', () => {
    it('derives concrete per-action lines from evidence and never claims unverified work', () => {
      const summary = formatTurnSummary([
        toolResult({ id: 'a', name: 'read_project', output: 'For further files use glob_files with offset. Next review offset=12. Broad project snapshot: read 12 of 40 relevant text file(s), 50000 characters. Some files were omitted or truncated for safety.' }),
        toolResult({ id: 'b', name: 'edit_file', output: 'Edited src/auth.ts (replaced 120 chars).' }),
        toolResult({ id: 'c', name: 'run_command', output: 'exit 0 in 3.2s: `npm test`\nAll 14 tests passed.' }),
      ]);
      expect(summary).toContain('Reviewed project snapshot (12 of 40 files)');
      expect(summary).toContain('Changed src/auth.ts');
      expect(summary).toContain('Ran `npm test` (exit 0 in 3.2s)');
      expect(summary).toContain('Full detail in Work details above.');
    });

    describe('formatStructuredReport', () => {
      it('only emits sections that contain substantive findings', () => {
        const report = buildCompletionReport([
          toolResult({ id: 'a', name: 'run_command', output: 'exit 0: `npm test`\nAll tests passed.' }),
        ], [{ label: 'Run tests', done: true }]);
        const formatted = formatStructuredReport(report);
        expect(formatted).toContain('### What is working');
        expect(formatted).not.toContain('### What is not working');
        expect(formatted).not.toContain('### What needs improvement');
        expect(formatted).toContain('### Verification');
      });

      it('reports a failing verification as FAILED instead of hiding it', () => {
        // A failing run is not-ok, so an ok-filtered list would call this
        // "skipped" and the red suite would vanish from the card.
        const report = buildCompletionReport([
          toolResult({ id: 'a', name: 'edit_file', output: 'Edited src/auth.ts (replaced 12 chars).' }),
          toolResult({ id: 'b', name: 'run_command', ok: false, output: 'exit 1 in 2.0s: `npm test`\n1 failed' }),
        ], []);
        const formatted = formatStructuredReport(report);
        expect(formatted).toContain('Tests: FAILED');
        expect(formatted).toContain('### What is not working');
      });

      it('does not report a check that never completed as FAILED', () => {
        // The shipped bug: `npx vitest` and `npx tsc` both hung, every run came
        // back not-ok, and the card printed "Tests: FAILED | Typecheck: FAILED"
        // directly under the model's own "no verification run was possible".
        // A timeout is the absence of a verdict, not a red one.
        const report = buildCompletionReport([
          toolResult({ id: 'a', name: 'edit_file', output: 'Edited convex/segments.ts (replaced 12 chars).' }),
          toolResult({ id: 'b', ok: false, name: 'run_command', output: 'TIMEOUT after 90.0s (no completion): `npx vitest`\n(no output)' }),
          toolResult({ id: 'c', ok: false, name: 'run_command', output: 'TIMEOUT after 90.0s (no completion): `npx tsc --noEmit`\n(no output)' }),
        ], []);
        expect(report.verification).toMatchObject({ tests: 'inconclusive', typecheck: 'inconclusive' });
        const formatted = formatStructuredReport(report);
        expect(formatted).not.toContain('FAILED');
        expect(formatted).toContain('Tests: DID NOT COMPLETE');
        expect(formatted).toContain('Typecheck: DID NOT COMPLETE');
        expect(formatted).toContain('This change is unverified.');
        // The edit keeps an amber badge, never a green or a red one.
        expect(formatted).toContain('[unverified: the check never finished] 🟡');
        // And it is not told to fix what a command that reported nothing said.
        expect(formatted).toContain('The command never finished, so nothing was checked.');
        expect(formatted).not.toContain('Fix what the command reported');
      });

      it('treats a dead session like a timeout and a tool error as inconclusive too', () => {
        const report = buildCompletionReport([
          toolResult({ id: 'a', ok: false, name: 'run_command', output: 'SESSION CLOSED after 4.0s before the command completed: `npm test`\n' }),
          toolResult({ id: 'b', ok: false, name: 'run_command', output: 'error: shell is gone: `npm run build`' }),
        ], []);
        expect(report.verification).toMatchObject({ tests: 'inconclusive', build: 'inconclusive' });
      });

      it('still reports a real failure as FAILED when another class only timed out', () => {
        // A red suite is the more urgent fact and must not be softened to
        // amber just because the typecheck beside it hung.
        const report = buildCompletionReport([
          toolResult({ id: 'a', ok: false, name: 'run_command', output: 'exit 1 in 2.0s: `npm test`\n1 failed' }),
          toolResult({ id: 'b', ok: false, name: 'run_command', output: 'TIMEOUT after 90.0s (no completion): `npx tsc --noEmit`\n' }),
        ], []);
        expect(report.verification).toMatchObject({ tests: 'fail', typecheck: 'inconclusive' });
        const formatted = formatStructuredReport(report);
        expect(formatted).toContain('Tests: FAILED 🔴');
        expect(formatted).toContain('Typecheck: DID NOT COMPLETE');
      });

      it('reads a timed-out run that later completed by its last run', () => {
        const report = buildCompletionReport([
          toolResult({ id: 'a', ok: false, name: 'run_command', output: 'TIMEOUT after 90.0s (no completion): `npx vitest`\n' }),
          toolResult({ id: 'b', name: 'run_command', output: 'exit 0 in 4.0s: `npx vitest run`\n13 passed' }),
        ], []);
        expect(report.verification.tests).toBe('pass');
      });

      it('reports the last run of a class, so a suite fixed and re-run reads PASSED', () => {
        // The brain is told to fix what a red run reported and run it again.
        // An OR across every run would keep printing FAILED for the one run it
        // was asked to repair.
        const report = buildCompletionReport([
          toolResult({ id: 'a', name: 'run_command', ok: false, output: 'exit 1 in 2.0s: `npm test`\n1 failed' }),
          toolResult({ id: 'b', name: 'edit_file', output: 'Edited src/auth.ts (replaced 12 chars).' }),
          toolResult({ id: 'c', name: 'run_command', output: 'exit 0 in 2.1s: `npm test`\n13 passed' }),
        ], []);
        expect(report.verification.tests).toBe('pass');
        expect(formatStructuredReport(report)).toContain('Tests: PASSED');
      });

      it('judges each class by its own last run', () => {
        const report = buildCompletionReport([
          toolResult({ id: 'a', name: 'run_command', ok: false, output: 'exit 1 in 2.0s: `npm run build`\nboom' }),
          toolResult({ id: 'b', name: 'run_command', output: 'exit 0 in 2.1s: `npm test`\n13 passed' }),
        ], []);
        // A green suite run last must not clear a build that is still red.
        expect(report.verification).toMatchObject({ tests: 'pass', build: 'fail' });
      });

      it('does not let a trailing non-verification command stand in as the plan\'s evidence', () => {
        const report = buildCompletionReport([
          toolResult({ id: 'a', name: 'run_command', ok: false, output: 'exit 1 in 2.0s: `npm test`\n1 failed' }),
          toolResult({ id: 'b', name: 'run_command', output: 'exit 0 in 0.1s: `cat package.json`\n{}' }),
        ], [{ label: 'Fix the lookup', done: true }]);
        expect(report.completed[0]).toMatchObject({ task: 'Fix the lookup', verified: false });
      });

      it('does not read a green run as failed because its output says "0 failed"', () => {
        const report = buildCompletionReport([
          toolResult({ id: 'a', name: 'run_command', output: 'exit 0 in 2.0s: `npm test`\n12 passed, 0 failed' }),
        ], []);
        expect(formatStructuredReport(report)).toContain('Tests: PASSED');
      });

      it('does not report an exploratory probe that came back empty as a failure', () => {
        const report = buildCompletionReport([
          toolResult({ id: 'a', name: 'edit_file', output: 'Edited src/auth.ts (replaced 12 chars).' }),
          toolResult({ id: 'b', ok: false, name: 'read_file', output: 'error: no such file: src/old.ts' }),
          toolResult({ id: 'c', ok: false, name: 'run_command', output: 'exit 1 in 0.3s: `npm test`\nboom' }),
        ], []);
        const formatted = formatStructuredReport(report);
        expect(formatted).toContain('**run_command**');
        expect(formatted).not.toContain('read_file');
      });

      it('marks a write verified only when a verification ran after it', () => {
        const edit = toolResult({ id: 'b', name: 'edit_file', output: 'Edited src/auth.ts (replaced 12 chars).' });
        const test = toolResult({ id: 'a', name: 'run_command', output: 'exit 0 in 1.0s: `npm test`\n12 passed' });
        expect(buildCompletionReport([test, edit], []).completed[0].verified).toBe(false);
        expect(buildCompletionReport([edit, test], []).completed[0].verified).toBe(true);
      });

      it('leaves completed plan items to the checklist once files changed', () => {
        const report = buildCompletionReport([
          toolResult({ id: 'a', name: 'edit_file', output: 'Edited src/auth.ts (replaced 12 chars).' }),
        ], [{ label: 'Update src/auth.ts', done: true }]);
        expect(report.completed.map((c) => c.task)).toEqual(['Edited src/auth.ts']);
      });
    });

    it('summarizes searches by hit counts and lists multiple writes', () => {
      const summary = formatTurnSummary([
        toolResult({ id: 'a', name: 'grep_code', output: '8 match(es) in 3 file(s):\n- src/auth.ts:12:1: authenticate' }),
        toolResult({ id: 'b', name: 'write_file', output: 'Wrote notes/todo.md (340 chars).' }),
      ]);
      expect(summary).toContain('Searched 8 matches in 3 files');
      expect(summary).toContain('Changed notes/todo.md');
    });

    it('returns null without successful evidence', () => {
      expect(formatTurnSummary([])).toBeNull();
      expect(formatTurnSummary([toolResult({ id: 'x', ok: false, name: 'read_file', output: 'error: no file' })])).toBeNull();
    });

    it('collapses repeated snapshot sweeps into one pass count', () => {
      const snapshot = (id: string, read: number) => toolResult({ id, name: 'read_project', output: `Broad project snapshot: read ${read} of 80 relevant text file(s), 90000 characters.` });
      const summary = formatTurnSummary([
        snapshot('a', 39), snapshot('b', 31), snapshot('c', 31), snapshot('d', 25),
      ]);
      expect(summary).toContain('Reviewed project snapshot across 4 passes');
      expect(summary).not.toContain('39 of 80');
    });

    it('mixes snapshot passes with individual file reads', () => {
      const summary = formatTurnSummary([
        toolResult({ id: 'a', name: 'read_project', output: 'Broad project snapshot: read 39 of 80 relevant text file(s), 90000 characters.' }),
        toolResult({ id: 'b', name: 'read_file', output: 'src/main.ts\nimport { boot } from ...' }),
      ]);
      expect(summary).toContain('project snapshot (39 of 80 files)');
      expect(summary).toContain('src/main.ts');
    });
  });
  it('preserves natural-language options and strips terminal controls', () => {
    expect(agentInputRequest('q', '\x1b[31mWhich database?\x1b[0m\n1. SQLite\n2. PostgreSQL', 'task', 42)).toMatchObject({
      prompt: 'Which database?\n1. SQLite\n2. PostgreSQL', type: 'choice', options: [{ label: 'SQLite' }, { label: 'PostgreSQL' }],
    });
  });
  it('maps explicit terminal yes/no input to literal line responses', () => {
    expect(agentInputRequest('q', 'Allow this command? (y/n)', 'task', 42, true)).toMatchObject({
      type: 'approval', inputMode: 'line', options: [{ label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }],
    });
    expect(agentInputRequest('q', 'Would you prefer yes/no questions?', 'task', 42).inputMode).toBeUndefined();
  });

  describe('cleanOrchestratorReply', () => {
    it('keeps the commas between inline code spans', () => {
      expect(cleanOrchestratorReply('- Helpers: `requireIdentity`, `requireOrgAccess`, `requireRole` throughout.')).toBe(
        '- Helpers: `requireIdentity`, `requireOrgAccess`, `requireRole` throughout.'
      );
      expect(cleanOrchestratorReply('Route groups `(agency)`, `(auth)`')).toBe('Route groups `(agency)`, `(auth)`');
    });

    it('removes em dashes between greeting and clause', () => {
      const input = "Hello — happy to help, and I'm here with you for the rest of the session. What would you like to work on in sello today?";
      expect(cleanOrchestratorReply(input)).toBe(
        "Hello, happy to help, and I'm here with you for the rest of the session. What would you like to work on in sello today?"
      );
    });

    it('removes em dashes and spaced hyphens between sentences or phrases', () => {
      expect(cleanOrchestratorReply("On it — I'll launch Claude to work on that.")).toBe(
        "On it, I'll launch Claude to work on that."
      );
      expect(cleanOrchestratorReply("Got it. Say the word — like open an agent — whenever you want.")).toBe(
        "Got it. Say the word, like open an agent, whenever you want."
      );
      expect(cleanOrchestratorReply("Sure - I will help with that.")).toBe(
        "Sure, I will help with that."
      );
      expect(cleanOrchestratorReply("Yes! — Let's do it.")).toBe(
        "Yes! Let's do it."
      );
      expect(cleanOrchestratorReply("Done. — The file has been updated.")).toBe(
        "Done. The file has been updated."
      );
    });

    it('preserves code blocks and inline code containing dashes', () => {
      const input = "Run `npm test -- --watch` to verify.\n```bash\ngit checkout -b my-branch\n```\nAll done — check the results.";
      expect(cleanOrchestratorReply(input)).toBe(
        "Run `npm test -- --watch` to verify.\n```bash\ngit checkout -b my-branch\n```\nAll done, check the results."
      );
    });

    it('preserves markdown list bullets and compound words', () => {
      const input = "Here are the in-app features:\n- Item 1\n- Item 2 — details here\n  - Sub-item";
      expect(cleanOrchestratorReply(input)).toBe(
        "Here are the in-app features:\n- Item 1\n- Item 2, details here\n  - Sub-item"
      );
    });

    it('preserves negative numbers', () => {
      expect(cleanOrchestratorReply("The score delta is -5 points.")).toBe(
        "The score delta is -5 points."
      );
    });
  });
});

describe('hasUnverifiedMutation (verification gate)', () => {
  const write = (id: string) => toolResult({ id, name: 'edit_file', output: 'Edited src/auth.ts (replaced 12 chars).' });
  const run = (id: string, command: string, exitCode = 0) =>
    toolResult({ id, name: 'run_command', ok: exitCode === 0, output: `exit ${exitCode} in 1.0s: \`${command}\`\nsome output` });

  it('is false when the turn changed nothing', () => {
    expect(hasUnverifiedMutation([])).toBe(false);
    expect(hasUnverifiedMutation([
      toolResult({ id: 'a', name: 'read_file', output: 'src/main.ts' }),
      run('b', 'npm test'),
    ])).toBe(false);
  });

  it('flags an edit with no verification after it', () => {
    expect(hasUnverifiedMutation([write('a')])).toBe(true);
    expect(hasUnverifiedMutation([
      toolResult({ id: 'a', name: 'read_project', output: 'snapshot' }),
      write('b'),
    ])).toBe(true);
  });

  it('accepts a verification run after the last write, however the project names it', () => {
    expect(hasUnverifiedMutation([write('a'), run('b', 'npm test')])).toBe(false);
    expect(hasUnverifiedMutation([write('a'), run('b', 'npx tsc --noEmit')])).toBe(false);
    expect(hasUnverifiedMutation([write('a'), run('b', './scripts/check.sh')])).toBe(false);
    expect(hasUnverifiedMutation([write('a'), run('b', 'cargo clippy')])).toBe(false);
    expect(hasUnverifiedMutation([write('a'), run('b', 'go test ./...')])).toBe(false);
  });

  it('does not count a verification that ran before the write', () => {
    expect(hasUnverifiedMutation([run('a', 'npm test'), write('b')])).toBe(true);
  });

  it('counts a FAILING verification as verification', () => {
    // A red test run is the honest outcome to report; the gate exists to make a
    // command run, not to demand that it pass.
    expect(hasUnverifiedMutation([write('a'), run('b', 'npm test', 1)])).toBe(false);
  });

  it('does not accept a verification that never completed', () => {
    // A command that hung checked nothing, so the gate has not been satisfied.
    // The caller nudges once and only once, so a project whose checks always
    // hang still finishes its turn.
    const hung = toolResult({ id: 'b', ok: false, name: 'run_command', output: 'TIMEOUT after 90.0s (no completion): `npm test`\n' });
    expect(hasUnverifiedMutation([write('a'), hung])).toBe(true);
    // One real run alongside it is enough to clear the gate.
    expect(hasUnverifiedMutation([write('a'), hung, run('c', 'npm test', 1)])).toBe(false);
  });

  it('ignores a command that only looked at the work', () => {
    expect(hasUnverifiedMutation([write('a'), run('b', 'git status')])).toBe(true);
    expect(hasUnverifiedMutation([write('a'), run('b', 'cat src/auth.ts')])).toBe(true);
    // "checkout" must not read as "check".
    expect(hasUnverifiedMutation([write('a'), run('b', 'git checkout main')])).toBe(true);
  });

  it('does not gate a written user document', () => {
    // save_document lands in the user's Documents folder, so no project test can
    // say anything about it; gating it would cost a pointless round every time.
    expect(hasUnverifiedMutation([
      toolResult({ id: 'a', name: 'save_document', output: 'Saved research.md to Documents.' }),
    ])).toBe(false);
  });

  it('ignores a write that failed', () => {
    expect(hasUnverifiedMutation([
      toolResult({ id: 'a', name: 'edit_file', ok: false, output: 'error: edit failed: no match' }),
    ])).toBe(false);
  });
});

describe('mediaGenerationRequest', () => {
  it('recognises plain requests for a picture or clip', () => {
    // The 2026-09-22 screenshot: typo included.
    expect(mediaGenerationRequest('can you create an image of aa dog')).toBe('image');
    expect(mediaGenerationRequest('generate a picture of a sunset')).toBe('image');
    expect(mediaGenerationRequest('make me a logo for the app')).toBe('image');
    expect(mediaGenerationRequest('draw me a cat')).toBe('image');
    expect(mediaGenerationRequest('make a short video of waves')).toBe('video');
  });

  it('reads the request and attached image paths past the attachment block', () => {
    const message = 'make this picture red\n\nThe user attached these files. Use their contents as context when relevant:\n--- Attached file: cat.png (image/png) ---\nThe binary attachment was saved at C:/tmp/cat.png. Inspect it when relevant.\n--- End attached file ---';
    expect(userRequestText(message)).toBe('make this picture red');
    expect(attachedImagePaths(message)).toEqual(['C:/tmp/cat.png']);
    expect(attachedImagePaths('no attachments')).toEqual([]);
  });

  it('leaves code work alone', () => {
    expect(mediaGenerationRequest('add an image tag to the header')).toBeNull();
    expect(mediaGenerationRequest('make the image component responsive')).toBeNull();
    expect(mediaGenerationRequest('create an image upload field')).toBeNull();
    expect(mediaGenerationRequest('fix the video player')).toBeNull();
  });
});
