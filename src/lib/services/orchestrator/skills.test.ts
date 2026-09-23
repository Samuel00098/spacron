import { describe, expect, it } from 'vitest';
import { BRAIN_SKILLS, MAX_CUSTOM_SKILL_CHARS, buildSkillsPrompt, sanitizeCustomSkills } from './skills';

describe('orchestrator skills', () => {
  it('includes every built-in skill by default', () => {
    const prompt = buildSkillsPrompt();
    for (const skill of BRAIN_SKILLS) expect(prompt).toContain(`${skill.title} SKILL:`);
  });

  it('leaves out switched-off built-ins and disabled custom skills', () => {
    const prompt = buildSkillsPrompt({
      disabled: ['debugging'],
      custom: [
        { id: 'a', title: 'Release notes', instructions: 'Write notes in past tense.', enabled: true },
        { id: 'b', title: 'Old habit', instructions: 'Never used.', enabled: false },
      ],
    });
    expect(prompt).not.toContain('DEBUGGING SKILL:');
    expect(prompt).toContain('RELEASE NOTES SKILL (written by the user');
    expect(prompt).not.toContain('Never used.');
  });

  it('returns nothing when every skill is off', () => {
    expect(buildSkillsPrompt({ disabled: BRAIN_SKILLS.map((s) => s.id) })).toBe('');
  });

  it('drops malformed custom skills and caps long ones', () => {
    const clean = sanitizeCustomSkills([
      { id: 'x', title: '  Spaced   title ', instructions: 'a'.repeat(MAX_CUSTOM_SKILL_CHARS + 50), enabled: true },
      { id: 'y', title: '', instructions: 'no title' },
      'not a skill',
      null,
    ]);
    expect(clean).toHaveLength(1);
    expect(clean[0].title).toBe('Spaced title');
    expect(clean[0].instructions).toHaveLength(MAX_CUSTOM_SKILL_CHARS);
    expect(sanitizeCustomSkills('nope')).toEqual([]);
  });
});
