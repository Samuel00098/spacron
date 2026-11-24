import { describe, expect, it } from 'vitest';
import { aboutYouContext, ABOUT_YOU_MAX } from './aboutYou';
import { getProfileLinesWithAboutYou } from '$lib/services/orchestrator/evolve';

describe('about you', () => {
  it('gives models nothing when the user wrote nothing', () => {
    expect(aboutYouContext('   ')).toBe('');
  });

  it('wraps and caps what the user wrote', () => {
    const text = aboutYouContext('  I build apps.  ');
    expect(text).toContain('in their own words');
    expect(text.endsWith('I build apps.')).toBe(true);
    expect(aboutYouContext('x'.repeat(ABOUT_YOU_MAX + 50)).endsWith('x'.repeat(10))).toBe(true);
    expect(aboutYouContext('x'.repeat(ABOUT_YOU_MAX + 50)).length).toBeLessThan(ABOUT_YOU_MAX + 200);
  });

  it('leads the assistant profile and leaves it alone when empty', () => {
    expect(getProfileLinesWithAboutYou('p', 'I am Alex.\nShort answers.')[0]).toBe('[you, in their own words] I am Alex. Short answers.');
    expect(getProfileLinesWithAboutYou('p', '  ')).toEqual(getProfileLinesWithAboutYou('p', ''));
  });
});
