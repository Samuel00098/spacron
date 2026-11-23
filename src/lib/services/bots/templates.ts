import type { BotAccess, BotSchedule } from './bots';

export interface BotTemplate {
  id: string;
  name: string;
  blurb: string;
  avatar: string;
  instructions: string;
  schedule: BotSchedule;
  time: string;
  day: number;
  access: BotAccess;
  /** Connectors it works best with, by catalog id (picked when set up). */
  connectors?: string[];
  /** Needs a web browser to open and use pages. */
  browser?: boolean;
  /** The Bot Builder. */
  canCreateBots?: boolean;
  /** Uses the computer (this PC's screen, or the box's virtual desktop). */
  computerUse?: boolean;
}

/** Ready-made bots. Nothing here touches a project. */
export const BOT_TEMPLATES: BotTemplate[] = [
  { id: 'builder', name: 'Bot Builder', blurb: 'Describe a bot in chat, it builds it', avatar: 'builder', schedule: 'manual', time: '09:00', day: 1, access: 'folder', canCreateBots: true,
    instructions: 'You design and create bots for the user. When they describe something they want done regularly or on demand, ask at most two short questions if anything important is unclear, then create the bot (or bots) with a clear, specific job, a sensible schedule, the least access that works, the connectors it needs and a fitting avatar. Explain in two or three sentences what you created and how to turn it on.' },
  { id: 'digest', name: 'Morning tech digest', blurb: 'Every day at 08:00', avatar: 'news', schedule: 'daily', time: '08:00', day: 1, access: 'folder',
    instructions: 'Search the web for the most important news from the last 24 hours in AI, cybersecurity and software engineering. Pick the five stories that matter most, and for each write two sentences on what happened and why it matters. Save the digest as digests/<today’s date>.md, keep a one-line entry per day in NOTES.md, and reply with the digest.' },
  { id: 'inbox', name: 'Inbox triage', blurb: 'Gmail · weekdays at 07:30', avatar: 'mail', schedule: 'weekdays', time: '07:30', day: 1, access: 'research', connectors: ['gmail'],
    instructions: 'Go through my Gmail inbox from the last 24 hours. Group what matters into: needs a reply today, waiting on someone, worth reading, and safe to ignore. For each item give the sender, subject and one line on what it needs. Draft short replies for the "needs a reply today" group, but never send anything.' },
  { id: 'youtube', name: 'YouTube trend scout', blurb: 'Browser · Mondays at 10:00', avatar: 'video', schedule: 'weekly', time: '10:00', day: 1, access: 'folder', browser: true,
    instructions: 'Open YouTube and look at what is trending this week in tech, AI and cybersecurity, plus the most-viewed recent videos on those topics. Note the titles, hooks, thumbnail styles and video lengths that are working. Then propose ten video ideas for my channel, each with a hook, a working title and why it could perform now. Check NOTES.md first so you never repeat an idea, append the new ones to it, and save this week’s list as ideas/<today’s date>.md.' },
  { id: 'faceless', name: 'Faceless channel writer', blurb: 'Fridays at 16:00', avatar: 'pen', schedule: 'weekly', time: '16:00', day: 5, access: 'folder',
    instructions: 'Write one complete script for a faceless YouTube video (8 to 10 minutes) on a trending tech or AI topic you research first. Include a strong 15-second hook, chapters, on-screen text cues and a call to action. Save it as scripts/<today’s date>.md and keep a list of covered topics in NOTES.md so you never repeat one.' },
  { id: 'cve', name: 'Security advisory watch', blurb: 'Weekdays at 09:00', avatar: 'lock', schedule: 'weekdays', time: '09:00', day: 1, access: 'research',
    instructions: 'Look up newly published critical and high severity CVEs and security advisories from the last day for widely used software (browsers, operating systems, Node.js, Python, Rust, popular web frameworks). Summarise each in plain language with who is affected and the fix.' },
  { id: 'copy', name: 'Copywriting coach', blurb: 'Daily drill at 19:00', avatar: 'idea', schedule: 'daily', time: '19:00', day: 1, access: 'folder',
    instructions: 'Give me one copywriting drill for today: a real product or offer, a target reader and a task (headline, hook, email or landing page section). Include one strong example and explain why it works in three bullet points. Track the drills you have given in NOTES.md and make each one a little harder than the last.' },
  { id: 'calendar', name: 'Day planner', blurb: 'Calendar · weekdays at 07:00', avatar: 'calendar', schedule: 'weekdays', time: '07:00', day: 1, access: 'research', connectors: ['googlecalendar'],
    instructions: 'Read my Google Calendar for today and tomorrow. Give me a short plan for today: what is fixed, where the free blocks are, and what to prepare for each meeting. Flag clashes and anything that needs travel time.' },
  { id: 'deals', name: 'Price and flight watcher', blurb: 'Browser · every day at 12:00', avatar: 'globe', schedule: 'daily', time: '12:00', day: 1, access: 'folder', browser: true,
    instructions: 'Read WATCHLIST.md in your folder (create it with two example lines and stop if it is missing). For each item, a product page or a flight route and date, open the pages and record today’s price in prices.csv. Reply with anything that dropped by more than 10% since the lowest price you have seen.' },
  { id: 'desktop', name: 'Desktop operator', blurb: 'Computer use · chat with it', avatar: 'robot', schedule: 'manual', time: '09:00', day: 1, access: 'full', computerUse: true,
    instructions: 'You operate a computer for me. Use the desktop tools: take a screenshot first, then click, type and press keys to get the task done, taking a new screenshot after each step to check the result. On a box you have your own virtual desktop and can start programs there. Stop and tell me if something needs a password or a payment.' },
  { id: 'research', name: 'Research assistant', blurb: 'Chat with it on demand', avatar: 'search', schedule: 'manual', time: '09:00', day: 1, access: 'folder', browser: true,
    instructions: 'You are my research assistant. Research whatever I ask thoroughly from reliable sources, open pages when you need the details, and answer with a clear summary and the sources. For anything long, also save a report to reports/<today’s date>-<topic>.md.' },
];
