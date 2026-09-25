import { readFileSync, writeFileSync } from 'node:fs';

const path = process.cwd() + '\\app\\page.tsx';
let s = readFileSync(path, 'utf8');

const decor = [
  ['Buy Spacron — $49', 'Buy Spacron · $49', 'CTAs (hero + final, both)'],
  ['planning — 3 sub-tasks, disjoint file sets', 'planning · 3 sub-tasks, disjoint file sets', 'terminal row'],
  ['review — 1 bounce returned', 'review · 1 bounce returned', 'terminal row'],
  ['all workers accepted — review bundled, committed to main', 'all workers accepted · review bundled, committed to main', 'terminal row'],
  ['Every running agent as a live card — tile, steer, and bounce work back', 'Every running agent as a live card · tile, steer, and bounce work back', 'fleet card body'],
  ['Perpetual license, per user — Windows, macOS, Linux', 'Perpetual license, per user · Windows, macOS, Linux', 'pricing sub'],
  ['Windows — macOS — Linux', 'Windows · macOS · Linux', 'hero OS row'],
  ['v1.3.0 — Jan 12, 2026', 'v1.3.0 · Jan 12, 2026', 'changelog row'],
  ['v1.2.4 — Dec 3, 2025', 'v1.2.4 · Dec 3, 2025', 'changelog row'],
  ['v1.1.9 — Oct 28, 2025', 'v1.1.9 · Oct 28, 2025', 'changelog row'],
];

let changed = 0;
for (const [from, to, label] of decor) {
  if (s.includes(from)) {
    s = s.split(from).join(to);
    console.log(`OK ${label}: ${(s.split(to).length - 1)} x`);
    changed++;
  } else {
    console.log(`SKIP (not present): ${label}`);
  }
}

if (changed) {
  writeFileSync(path, s, 'utf8');
  console.log(`WROTE page.tsx — ${changed} decorative replacements done`);
} else {
  console.log('NO CHANGES — nothing matched (already clean or text differs)');
}
