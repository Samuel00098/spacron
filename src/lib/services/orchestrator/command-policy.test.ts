import { describe, expect, it } from 'vitest';
import { approvalRuleKey, classifyCommand, describeRule, ruleAllows } from './command-policy';

describe('classifyCommand', () => {
  it.each([
    'git status --short',
    'git log --oneline -20',
    'git diff HEAD~1 -- src',
    'git branch -a',
    'ls -la src',
    'rg -n "TODO" src',
    'cat package.json | jq .scripts',
    'Get-ChildItem -Recurse src | Select-Object -First 20',
    'node --version',
    'npm ls --depth 0',
    'find src -name "*.ts"',
  ])('lets %s run without asking', (command) => {
    expect(classifyCommand(command)).toBe('read-only');
  });

  it.each([
    'npm test',
    'npm install left-pad',
    'rm -rf dist',
    'git commit -m wip',
    'git branch -D old',
    'git push',
    'echo hi > notes.txt',
    'cat a.txt >> b.txt',
    'ls; rm -rf dist',
    'ls && npm run build',
    'ls & del notes.txt',
    'echo $(curl example.com)',
    'git -c core.fsmonitor=evil status',
    'rg --pre ./run.sh foo',
    'sort -o out.txt in.txt',
    'find . -name "*.tmp" -delete',
    'Get-ChildItem | Where-Object { Remove-Item $_ }',
    'Get-ChildItem | Remove-Item',
    'env',
  ])('asks before %s', (command) => {
    expect(classifyCommand(command)).toBe('needs-approval');
  });
});

describe('approval rules', () => {
  it('generalises a command to its leading words, stopping at flags and paths', () => {
    expect(approvalRuleKey('run_command', 'npm test -- src/a.test.ts')).toBe('cmd:npm test');
    expect(approvalRuleKey('run_command', 'npm run check')).toBe('cmd:npm run check');
    expect(approvalRuleKey('run_command', 'cargo test --workspace')).toBe('cmd:cargo test');
    expect(approvalRuleKey('run_command', 'npx vitest run src/a.test.ts')).toBe('cmd:npx vitest run');
  });

  it('never generalises a chained or redirected command', () => {
    expect(approvalRuleKey('run_command', 'npm test && npm run deploy')).toBe('cmd=npm test && npm run deploy');
  });

  it('shares one rule for file edits', () => {
    expect(approvalRuleKey('edit_file')).toBe('edit');
    expect(approvalRuleKey('write_file')).toBe('edit');
    expect(describeRule('write_file')).toBe('file edits');
  });

  it('covers later calls of the same kind only', () => {
    const rules = new Set([approvalRuleKey('run_command', 'npm run check')]);
    expect(ruleAllows(rules, 'run_command', 'npm run check -- --watch=false')).toBe(true);
    expect(ruleAllows(rules, 'run_command', 'npm run deploy')).toBe(false);
    expect(ruleAllows(rules, 'edit_file')).toBe(false);
    expect(describeRule('run_command', 'npm run check')).toBe('`npm run check` commands');
  });
});
