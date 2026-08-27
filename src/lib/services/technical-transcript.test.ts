import { describe, expect, it } from 'vitest';
import { normalizeTechnicalTranscript } from '$lib/services/technical-transcript';

const norm = (input: string) => normalizeTechnicalTranscript(input);
const prose = (input: string) => normalizeTechnicalTranscript(input, { capitalize: true });

describe('spelled-out product names', () => {
  it.each([
    ['push it to get hub', 'push it to GitHub'],
    ['push it to git hub', 'push it to GitHub'],
    ['open a get hub actions run', 'open a GitHub Actions run'],
    ['rewrite it in type script', 'rewrite it in TypeScript'],
    ['this is plain java script', 'this is plain JavaScript'],
    ['upgrade node js first', 'upgrade Node.js first'],
    ['the next js router', 'the Next.js router'],
    ['migrate to post gres sequel', 'migrate to PostgreSQL'],
    ['store it in my sequel', 'store it in MySQL'],
    ['use sequel light locally', 'use SQLite locally'],
    ['a mongo db collection', 'a MongoDB collection'],
    ['restart red is', 'restart Redis'],
    ['the graph ql schema', 'the GraphQL schema'],
    ['behind engine x', 'behind nginx'],
    ['run cube control get pods', 'run kubectl get pods'],
    ['open v s code', 'open VS Code'],
    ['written in c sharp', 'written in C#'],
    ['serve it on local host', 'serve it on localhost'],
    ['fix the es lint errors', 'fix the ESLint errors'],
    ['deploy with docker compose', 'deploy with Docker Compose'],
    ['the o auth callback', 'the OAuth callback'],
  ])('rewrites %j', (input, expected) => {
    expect(norm(input)).toBe(expected);
  });

  it('leaves a name it does not know alone', () => {
    expect(norm('ship it with Foobarify')).toBe('ship it with Foobarify');
  });
});

describe('acronyms', () => {
  it('collapses spelled-out letters into the acronym', () => {
    expect(norm('the a p i returns an error')).toBe('the API returns an error');
    expect(norm('sign the j w t')).toBe('sign the JWT');
    expect(norm('check the c. l. i. flags')).toBe('check the CLI flags');
    // A period that ends the sentence is not part of the spelling.
    expect(norm('it goes through the a p i.')).toBe('it goes through the API.');
  });

  it('upper-cases acronyms that arrived lowercase', () => {
    expect(norm('the api returns json over http')).toBe('the API returns JSON over HTTP');
    expect(norm('generate a uuid for each dto')).toBe('generate a UUID for each DTO');
  });

  it('leaves loose letters in prose alone', () => {
    // Joining these would be damage nobody can undo from the text.
    expect(norm('plan A, B and C')).toBe('plan A, B and C');
    expect(norm('option b or d')).toBe('option b or d');
  });

  it('never touches ordinary English that happens to look like an acronym', () => {
    expect(norm('it is on us so no one waits')).toBe('it is on us so no one waits');
  });
});

describe('spoken flags and file extensions', () => {
  it('reconstructs long flags', () => {
    expect(norm('run it with dash dash force')).toBe('run it with --force');
    // Two flag words have to be dictated with the joining dash spoken: there
    // is nothing in the audio that separates "--strict and check the tests"
    // from a two-word flag, so only the explicit form is joined.
    expect(norm('pass dash dash dry dash run')).toBe('pass --dry-run');
    expect(norm('run dash dash strict and check the tests')).toBe('run --strict and check the tests');
  });

  it('reconstructs short flags', () => {
    expect(norm('remove it with dash r')).toBe('remove it with -r');
  });

  it('leaves a dash that is really punctuation', () => {
    // The spoken-punctuation table downstream turns this into a hyphen; the
    // technical pass must not claim it first.
    expect(norm('put a dash between the two numbers')).toBe('put a dash between the two numbers');
  });

  it('reconstructs file extensions before "dot" becomes a full stop', () => {
    expect(norm('open app dot ts')).toBe('open app.ts');
    expect(norm('edit config dot json')).toBe('edit config.json');
    // The word before is a verb, not a filename — keep them apart.
    expect(norm('create a dot env file')).toBe('create a .env file');
  });
});

describe('ambiguous terms are left for the rewrite pass', () => {
  it('only fixes "jason" next to a technical noun', () => {
    expect(norm('parse the jason payload')).toBe('parse the JSON payload');
    expect(norm('ask jason about it')).toBe('ask jason about it');
  });

  it('only fixes "sequel" next to a technical noun', () => {
    expect(norm('write the sequel query')).toBe('write the SQL query');
    expect(norm('the sequel was better')).toBe('the sequel was better');
  });
});

describe('stumbled repeats', () => {
  it('collapses repeated function words', () => {
    expect(norm('we we need to to fix it')).toBe('we need to fix it');
    expect(norm('the the the button')).toBe('the button');
  });

  it('leaves real English repeats alone', () => {
    expect(norm('I had had enough')).toBe('I had had enough');
    expect(norm('the thing that that broke')).toBe('the thing that that broke');
  });
});

describe('sentence capitalization', () => {
  it('is off unless asked for, because terminals must survive verbatim', () => {
    expect(norm('npm install then run the build')).toBe('npm install then run the build');
    expect(norm('check the logs. restart it.')).toBe('check the logs. restart it.');
  });

  it('capitalizes sentence openings in prose', () => {
    expect(prose('check the logs. restart it.')).toBe('Check the logs. Restart it.');
  });

  it('never capitalizes a name whose canonical form is lowercase', () => {
    expect(prose('npm install is enough. webpack will complain.')).toBe(
      'npm install is enough. webpack will complain.',
    );
  });

  it('leaves an identifier with its own casing alone', () => {
    expect(prose('useEffect runs twice. GitHub is down.')).toBe('useEffect runs twice. GitHub is down.');
  });
});

describe('a realistic dictation', () => {
  it('cleans a whole spoken sentence', () => {
    expect(
      prose(
        'so the the a p i returns jason data but type script says it is any, run dash dash strict and check app dot ts',
      ),
    ).toBe(
      'So the API returns JSON data but TypeScript says it is any, run --strict and check app.ts',
    );
  });
});
