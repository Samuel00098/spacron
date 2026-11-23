#!/usr/bin/env node
/**
 * Renders the built-in bot avatars to `static/bot-avatars/<id>.webp`.
 *
 * Each avatar is a glossy gradient tile with a large Noto Color Emoji
 * character (SIL Open Font License), rendered by headless Chromium and saved
 * as WebP. Edit AVATARS below and re-run to restyle or add avatars:
 *
 *   node scripts/generate-bot-avatars.cjs
 *
 * Needs Playwright with Chromium and the Noto Color Emoji font installed
 * (Debian/Ubuntu: fonts-noto-color-emoji).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

/** id, label, emoji, gradient stops (top-left -> bottom-right), glow colour. */
const AVATARS = [
  ['robot', 'Robot', '🤖', ['#6d5dfc', '#2b1f8f'], '#b3a8ff'],
  ['brain', 'Thinker', '🧠', ['#ff7eb3', '#b8326a'], '#ffc2da'],
  ['owl', 'Night owl', '🦉', ['#3a4a8c', '#121a3d'], '#8fa2ff'],
  ['satellite', 'Satellite', '🛰️', ['#1fb6ff', '#0b4f8a'], '#9fe0ff'],
  ['rocket', 'Rocket', '🚀', ['#ff8a3d', '#c2341a'], '#ffc9a3'],
  ['news', 'Newsroom', '📰', ['#9aa5b8', '#3d4659'], '#e3e8f2'],
  ['mail', 'Inbox', '📬', ['#ff5f6d', '#b3123a'], '#ffb3bd'],
  ['video', 'Studio', '🎬', ['#ff3d3d', '#7a0a1c'], '#ffb0b0'],
  ['lock', 'Guardian', '🛡️', ['#22c55e', '#0d5c33'], '#a7f3c4'],
  ['search', 'Researcher', '🔎', ['#14b8a6', '#0b5450'], '#99f0e4'],
  ['idea', 'Idea scout', '💡', ['#facc15', '#b8730b'], '#fff1a8'],
  ['chart', 'Analyst', '📈', ['#38bdf8', '#1d4ed8'], '#bfe8ff'],
  ['pen', 'Writer', '✍️', ['#f472b6', '#7e22ce'], '#f5c6ff'],
  ['calendar', 'Planner', '🗓️', ['#60a5fa', '#3730a3'], '#c7d7ff'],
  ['code', 'Coder', '👩‍💻', ['#0ea5e9', '#0f2a4a'], '#a5ddff'],
  ['globe', 'Traveller', '🌍', ['#34d399', '#065f73'], '#b5f5dd'],
  ['bolt', 'Automator', '⚡', ['#fbbf24', '#d9480f'], '#ffe2a1'],
  ['builder', 'Bot Builder', '🏗️', ['#a78bfa', '#4c1d95'], '#ddd1ff'],
  ['music', 'DJ', '🎧', ['#e879f9', '#6b21a8'], '#f6c8ff'],
  ['money', 'Money', '💸', ['#4ade80', '#15803d'], '#c4f7d4'],
  ['cat', 'Cat', '🐱', ['#fb923c', '#9a3412'], '#ffd3b0'],
  ['alien', 'Alien', '👽', ['#a3e635', '#3f6212'], '#e2fbb0'],
  ['crystal', 'Oracle', '🔮', ['#c084fc', '#312e81'], '#e9d5ff'],
  ['chat', 'Chatter', '💬', ['#94a3b8', '#1e293b'], '#e2e8f0'],
];

const SIZE = 256;

function page(emoji, [a, b], glow) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent}
  .tile{position:relative;width:${SIZE}px;height:${SIZE}px;border-radius:${SIZE * 0.24}px;overflow:hidden;
    background:radial-gradient(120% 90% at 22% 12%, ${glow}55 0%, transparent 46%), linear-gradient(145deg, ${a} 0%, ${b} 100%);
    box-shadow: inset 0 ${SIZE * 0.012}px 0 rgba(255,255,255,.35), inset 0 -${SIZE * 0.03}px ${SIZE * 0.08}px rgba(0,0,0,.28);}
  .grid{position:absolute;inset:0;opacity:.13;background-image:radial-gradient(rgba(255,255,255,.9) 1.2px, transparent 1.3px);background-size:${SIZE / 12}px ${SIZE / 12}px;
    -webkit-mask-image:radial-gradient(80% 70% at 50% 40%, #000 0%, transparent 75%)}
  .halo{position:absolute;left:50%;top:54%;width:${SIZE * 0.78}px;height:${SIZE * 0.78}px;transform:translate(-50%,-50%);border-radius:50%;
    background:radial-gradient(circle, ${glow}66 0%, ${glow}00 62%)}
  .glyph{position:absolute;left:50%;top:53%;transform:translate(-50%,-50%);font-size:${SIZE * 0.56}px;line-height:1;
    font-family:'Noto Color Emoji',sans-serif;filter:drop-shadow(0 ${SIZE * 0.035}px ${SIZE * 0.03}px rgba(0,0,0,.35)) drop-shadow(0 ${SIZE * 0.01}px ${SIZE * 0.008}px rgba(0,0,0,.25))}
  .gloss{position:absolute;left:-10%;top:-38%;width:120%;height:70%;border-radius:50%;
    background:linear-gradient(180deg, rgba(255,255,255,.30) 0%, rgba(255,255,255,0) 70%)}
  .rim{position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 ${SIZE * 0.008}px rgba(255,255,255,.14)}
  </style></head><body><div class="tile"><div class="grid"></div><div class="halo"></div><div class="glyph">${emoji}</div><div class="gloss"></div><div class="rim"></div></div></body></html>`;
}

(async () => {
  const out = path.join(__dirname, '..', 'static', 'bot-avatars');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const tab = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  for (const [id, , emoji, stops, glow] of AVATARS) {
    await tab.setContent(page(emoji, stops, glow));
    await tab.evaluate(() => document.fonts.ready);
    const png = await tab.locator('.tile').screenshot({ omitBackground: true, type: 'png' });
    fs.writeFileSync(path.join(out, `${id}.png`), png);
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'avatars.json'), JSON.stringify(AVATARS.map(([id, label]) => ({ id, label })), null, 2) + '\n');
  console.log(`Rendered ${AVATARS.length} avatars to ${out}`);
})();
