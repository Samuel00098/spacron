import { describe, expect, it } from 'vitest';
import {
  buildOrchestratorBriefBody,
  buildOrchestratorSkill,
  REPORTS_DIR,
} from './orchestrator-brief';
import { ORCHESTRATOR_BRIEF_PATH, ROLE_BRIEFS, buildAgentCharter } from './agent-charter';

describe('buildOrchestratorBriefBody', () => {
  it('routes delegation through the waiting tools', () => {
    const body = buildOrchestratorBriefBody();
    expect(body).toContain('delegate_task(preset, prompt, files, name)');
    expect(body).toContain('check_task(handle)');
    // Every status the tool can return must be documented, or the orchestrator
    // will not know that `working` means "call check_task" rather than "failed".
    for (const status of ['complete', 'blocked', 'working', 'gone']) {
      expect(body).toContain(`\`${status}\``);
    }
  });

  it('tells the orchestrator NOT to hand-write reporting instructions', () => {
    // The report protocol — including the ABSOLUTE paths that keep a worker from
    // writing its report inside its own worktree, where nobody looks — is
    // appended by the server in `delegate_task`. An orchestrator that writes its
    // own version will get the relative-path trap wrong and then wait forever.
    expect(buildOrchestratorBriefBody()).toMatch(
      /Do not write\s+reporting instructions into the prompt/,
    );
  });

  it('uses bounce_task rather than send_to_agent for another round', () => {
    // send_to_agent leaves the previous report in place, so the next wait returns
    // the stale one immediately and the loop "converges" with nothing redone.
    const body = buildOrchestratorBriefBody();
    expect(body).toContain('bounce_task(handle, feedback)');
    expect(body).toMatch(/\*\*Use this, not `send_to_agent`, for another round\*\*/);
  });

  it('keeps in-process sub-agents out of work that writes code', () => {
    const body = buildOrchestratorBriefBody();
    expect(body).toMatch(
      /Do not use your own in-process sub-agent feature for work that writes code/,
    );
    // ...but does not ban them outright: read-only fan-out is genuinely better
    // in-process, and over-broad advice gets ignored wholesale.
    expect(body).toMatch(/fine\s+for read-only research/);
  });

  it('still requires disjoint file ownership, for merge sanity', () => {
    // Worktrees stop workers clobbering each other on disk, but their branches
    // still have to converge — overlapping edits become merge conflicts.
    expect(buildOrchestratorBriefBody()).toContain('Keep file sets disjoint');
  });

  it('reviews the branch diff rather than terminal output', () => {
    const body = buildOrchestratorBriefBody();
    expect(body).toContain('git diff <your-branch>..<worker-branch>');
    expect(body).toContain('Never review from `read_agent_output`');
  });

  it('gates completion on the project checks, not on the reviewer liking it', () => {
    const body = buildOrchestratorBriefBody();
    expect(body).toContain('The checks decide whether the work is done');
    expect(body).toMatch(/run them yourself/);
  });

  it('caps the loop and forbids stopping silently', () => {
    const body = buildOrchestratorBriefBody();
    expect(body).toContain('3 rounds');
    expect(body).toContain('Never stop silently');
  });

  it('tells the orchestrator to stop when the tools are missing', () => {
    // Discovery is wired per preset and fails silently; an orchestrator with no
    // tools must say so rather than quietly doing the whole job alone.
    expect(buildOrchestratorBriefBody()).toMatch(/If these tools are unavailable, stop/);
  });
});

describe('buildOrchestratorSkill', () => {
  it('wraps the same body in discoverable skill frontmatter', () => {
    const skill = buildOrchestratorSkill();
    expect(skill.startsWith('---\nname: orchestrate-fleet\n')).toBe(true);
    expect(skill).toContain('description:');
    // One protocol, two delivery surfaces — the skill must not drift from the file.
    expect(skill).toContain(buildOrchestratorBriefBody());
  });
});

describe('the orchestrator role brief', () => {
  it('points at the brief file instead of carrying the protocol', () => {
    // ROLE_BRIEFS rides the pasted-charter channel, which truncates on long
    // multi-line input in Ink REPLs. The protocol is ~70 lines, so the role
    // brief must stay a one-line pointer.
    const brief = ROLE_BRIEFS.orchestrator;
    expect(brief).toContain(ORCHESTRATOR_BRIEF_PATH);
    expect(brief.split('\n')).toHaveLength(1);
    expect(brief).not.toContain(REPORTS_DIR);
  });

  it('stays one line when embedded in a full pasted charter', () => {
    const charter = buildAgentCharter('Ship the settings page', { role: 'orchestrator' });
    expect(charter).toContain(ORCHESTRATOR_BRIEF_PATH);
    // Guards the paste budget: the charter's own doc comment explains that a
    // long, decorated brief is committed asynchronously and arrives cut short.
    expect(charter.split('\n').length).toBeLessThan(15);
  });
});
