/**
 * Turns a raw error (npm output, an OS error code, a git refusal, an HTTP
 * status) into something a person can act on: what went wrong, in plain words,
 * and what to do next. The raw text is kept as `details` so nothing is lost —
 * surfaces show it behind a "Show details" toggle rather than as the headline.
 *
 * Rules are matched in order against the whole raw text; the first hit wins, so
 * the more specific patterns sit above the generic ones.
 */

export interface ExplainedError {
  /** One short sentence: what went wrong. */
  summary: string;
  /** What the user should do about it, when we know. */
  nextStep?: string;
  /** The original text, when it says more than `summary` does. */
  details?: string;
}

export interface ExplainContext {
  /** The thing that failed, e.g. "Codex CLI", used to make sentences specific. */
  subject?: string;
  /** What was being attempted, e.g. "update". */
  action?: string;
}

interface Rule {
  test: RegExp;
  explain: (ctx: Required<ExplainContext>, raw: string) => Omit<ExplainedError, 'details'>;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const RULES: Rule[] = [
  // ── Files locked or in use ────────────────────────────────────────────────
  {
    test: /\bEBUSY\b|resource busy or locked|being used by another process|os error 32\b/i,
    explain: ({ subject, action }) => ({
      summary:
        action === 'update'
          ? `${subject} couldn't be updated because it's still running.`
          : 'A file is in use by another program.',
      nextStep:
        action === 'update'
          ? `Close every terminal or pane running ${subject}, then click Try again.`
          : 'Close whatever has the file open (another terminal, editor or agent), then try again.',
    }),
  },
  {
    test: /\bEPERM\b|\bEACCES\b|permission denied|access is denied|os error 5\b|operation not permitted/i,
    explain: ({ subject, action }) => ({
      summary:
        action === 'update'
          ? `${subject} couldn't be updated: Windows blocked access to its files.`
          : "Spacron wasn't allowed to access a file or folder it needed.",
      nextStep:
        action === 'update'
          ? `Close anything running ${subject} and try again. If it keeps failing, your antivirus may be locking the files, or the install folder needs admin rights.`
          : 'Close programs that might be using it and try again. If it keeps happening, check the folder permissions or your antivirus.',
    }),
  },
  {
    test: /\bENOSPC\b|no space left on device|not enough space on the disk|os error 112\b/i,
    explain: () => ({
      summary: 'Your disk is full.',
      nextStep: 'Free up some disk space, then try again.',
    }),
  },

  // ── Missing programs / files ──────────────────────────────────────────────
  {
    test: /is not recognized as an internal or external command|command not found|program not found|No such file or directory \(os error 2\)|The system cannot find the file specified|\bENOENT\b.*\bspawn\b|spawn .* ENOENT/i,
    explain: ({ subject }) => ({
      summary: `A program ${subject === 'this' ? 'Spacron' : subject} needs isn't installed or isn't on your PATH.`,
      nextStep: 'Install it (or reinstall it), then restart Spacron so it picks up the new PATH.',
    }),
  },
  {
    test: /\bENOENT\b|no such file or directory|cannot find the path specified|os error 3\b/i,
    explain: () => ({
      summary: "A file or folder that was expected isn't there any more.",
      nextStep: 'Check it wasn’t moved or deleted, then try again.',
    }),
  },

  // ── Network ───────────────────────────────────────────────────────────────
  {
    test: /\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo|dns error|failed to lookup address|could not resolve host|No such host is known/i,
    explain: () => ({
      summary: "Couldn't reach the server. It looks like you're offline or DNS is failing.",
      nextStep: 'Check your internet connection (and VPN or proxy), then try again.',
    }),
  },
  {
    test: /\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|timed out|timeout|deadline has elapsed/i,
    explain: () => ({
      summary: 'The request took too long and was abandoned.',
      nextStep: 'Your connection or the service may be slow. Wait a moment and try again.',
    }),
  },
  {
    test: /\bECONNREFUSED\b|connection refused|actively refused/i,
    explain: () => ({
      summary: "The service didn't accept the connection. It probably isn't running.",
      nextStep: 'Make sure the server or app you are connecting to is started, then try again.',
    }),
  },
  {
    test: /\bECONNRESET\b|connection reset|socket hang up|broken pipe|\bEPIPE\b/i,
    explain: () => ({
      summary: 'The connection dropped part-way through.',
      nextStep: 'This is usually temporary. Try again.',
    }),
  },
  {
    test: /\bEADDRINUSE\b|address already in use|only one usage of each socket address/i,
    explain: () => ({
      summary: 'That port is already being used by another program.',
      nextStep: 'Stop the other program (often a dev server left running) or pick a different port.',
    }),
  },
  {
    test: /certificate (verify|has expired|is not trusted)|invalid peer certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ssl handshake/i,
    explain: () => ({
      summary: "The secure connection couldn't be verified.",
      nextStep: 'If you are on a work network or VPN it may be intercepting traffic. Try another network or ask your IT team.',
    }),
  },

  // ── HTTP / provider errors ────────────────────────────────────────────────
  {
    test: /\b401\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|authentication failed|not logged in|please log ?in/i,
    explain: ({ subject }) => ({
      summary: `${subject === 'this' ? 'The service' : subject} rejected the sign-in or API key.`,
      nextStep: 'Sign in again, or check the API key in Settings.',
    }),
  },
  {
    test: /\b403\b|forbidden|not allowed to access|does not have access/i,
    explain: () => ({
      summary: "Your account doesn't have access to this.",
      nextStep: 'Check you are signed in to the right account and that your plan includes it.',
    }),
  },
  {
    test: /\b429\b|rate.?limit|too many requests|quota|usage limit|insufficient_quota|credit balance/i,
    explain: () => ({
      summary: "You've hit a usage or rate limit.",
      nextStep: 'Wait a few minutes and try again, or check your plan or credits with the provider.',
    }),
  },
  {
    test: /\b(500|502|503|504|529)\b|internal server error|bad gateway|service unavailable|overloaded/i,
    explain: () => ({
      summary: 'The service is having problems on its end.',
      nextStep: "This isn't something you did. Wait a minute and try again.",
    }),
  },
  {
    test: /\bE404\b|\bETARGET\b|No matching version|404 Not Found/i,
    explain: ({ action }) => ({
      summary: action === 'update' ? "The new version couldn't be found on the package registry." : 'What was requested could not be found.',
      nextStep: action === 'update' ? 'It may still be publishing. Try again in a few minutes.' : 'Check the name or address and try again.',
    }),
  },

  // ── git ───────────────────────────────────────────────────────────────────
  {
    test: /not a git repository/i,
    explain: () => ({
      summary: "This folder isn't a git repository.",
      nextStep: 'Open a project that uses git, or run "git init" in this folder first.',
    }),
  },
  {
    test: /Permission denied \(publickey\)|could not read Username|Authentication failed for|terminal prompts disabled/i,
    explain: () => ({
      summary: "git couldn't sign in to the remote.",
      nextStep: 'Set up your SSH key or git credentials (try pushing once from a terminal), then try again.',
    }),
  },
  {
    test: /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i,
    explain: () => ({
      summary: 'The remote has changes you don’t have yet, so the push was refused.',
      nextStep: 'Pull (or fetch and merge) first, then push again.',
    }),
  },
  {
    test: /merge conflict|CONFLICT \(|fix conflicts|unmerged files/i,
    explain: () => ({
      summary: 'The changes conflict with each other.',
      nextStep: 'Open the conflicting files, pick which changes to keep, then commit.',
    }),
  },
  {
    test: /nothing to commit|no changes added to commit/i,
    explain: () => ({
      summary: 'There is nothing to commit.',
      nextStep: 'Stage some changes first.',
    }),
  },
  {
    test: /would be overwritten by (merge|checkout)|local changes .* would be overwritten|commit your changes or stash them/i,
    explain: () => ({
      summary: 'You have uncommitted changes that would be overwritten.',
      nextStep: 'Commit or stash your changes first, then try again.',
    }),
  },
  {
    test: /index\.lock|another git process seems to be running/i,
    explain: () => ({
      summary: 'Another git command is already running in this project.',
      nextStep: 'Wait for it to finish and try again. If nothing is running, delete .git/index.lock.',
    }),
  },

  // ── Docker ────────────────────────────────────────────────────────────────
  {
    test: /docker daemon|Cannot connect to the Docker|docker_engine|dockerDesktopLinuxEngine/i,
    explain: () => ({
      summary: "Docker isn't running.",
      nextStep: 'Start Docker Desktop, wait until it says it is running, then try again.',
    }),
  },
];

/** Strip ANSI, the leading "Error:" noise and npm's per-line prefixes. */
function clean(raw: string): string {
  return raw
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(npm (error|ERR!)|error:|Error:)\s*/i, '').trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n')
    .trim();
}

/** Whether a message already reads like a sentence meant for a person. */
function looksFriendly(text: string): boolean {
  if (text.includes('\n') || text.length > 180) return false;
  // Paths, stack frames, error codes and JSON are signs of a raw dump.
  if (/^(fatal|error\[|thread '|Traceback)|panicked at|[A-Za-z]:\\|\/[\w.-]+\/[\w.-]+\/|\bat \S+ \(|\bE[A-Z]{3,}\b|os error \d+|^\s*[{[]/.test(text)) return false;
  return true;
}

export function errorText(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === 'object') {
    const e = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason', 'detail']) {
      if (typeof e[key] === 'string' && e[key]) return e[key] as string;
    }
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through */
    }
  }
  return String(error);
}

/**
 * Explain an error for a person. Known failures get a plain-English summary
 * and a next step; unknown ones are left alone when they already read well, or
 * reduced to their first meaningful line with the rest kept as details.
 */
export function explainError(error: unknown, context: ExplainContext = {}): ExplainedError {
  const raw = errorText(error).replace(ANSI, '').trim();
  const text = clean(raw);
  const ctx: Required<ExplainContext> = { subject: context.subject || 'this', action: context.action || '' };

  if (!text) {
    return { summary: 'Something went wrong, but no reason was given.', nextStep: 'Try again. If it keeps happening, restart Spacron.' };
  }

  const friendly = looksFriendly(text);
  for (const rule of RULES) {
    if (rule.test.test(raw)) {
      const { summary, nextStep } = rule.explain(ctx, raw);
      // A message someone already wrote for people keeps its wording; it only
      // gains the next step.
      if (friendly) return { summary: text, nextStep };
      return { summary, nextStep, details: raw };
    }
  }

  if (friendly) return { summary: text };

  const first = text.split('\n')[0];
  const summary = first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first;
  return {
    summary,
    nextStep: 'Try again. If it keeps happening, copy the details and report it.',
    details: raw,
  };
}
