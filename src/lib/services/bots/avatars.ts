/**
 * Built-in bot avatars: mascot portraits in `static/bot-avatars/<id>.webp`.
 * Keep these IDs stable so saved bots can resolve their selected avatar.
 * A bot can also use an uploaded picture, kept as a small data URL.
 */
export const BOT_AVATARS: { id: string; label: string }[] = [
  { id: 'robot', label: 'Robot' },
  { id: 'brain', label: 'Thinker' },
  { id: 'owl', label: 'Night owl' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'rocket', label: 'Rocket' },
  { id: 'news', label: 'Newsroom' },
  { id: 'mail', label: 'Inbox' },
  { id: 'video', label: 'Studio' },
  { id: 'lock', label: 'Guardian' },
  { id: 'search', label: 'Researcher' },
  { id: 'idea', label: 'Idea scout' },
  { id: 'chart', label: 'Analyst' },
  { id: 'pen', label: 'Writer' },
  { id: 'calendar', label: 'Planner' },
  { id: 'code', label: 'Coder' },
  { id: 'globe', label: 'Traveller' },
  { id: 'bolt', label: 'Automator' },
  { id: 'builder', label: 'Bot Builder' },
  { id: 'music', label: 'DJ' },
  { id: 'money', label: 'Money' },
  { id: 'cat', label: 'Cat' },
  { id: 'alien', label: 'Alien' },
  { id: 'crystal', label: 'Oracle' },
  { id: 'chat', label: 'Chatter' },
];

export const DEFAULT_AVATAR = 'robot';
const IDS = new Set(BOT_AVATARS.map((a) => a.id));

export function isBuiltInAvatar(avatar: string): boolean {
  return IDS.has(avatar);
}

/** The image URL for a bot's avatar (built-in id or uploaded data URL). */
export function avatarUrl(avatar: string | null | undefined): string {
  if (avatar && avatar.startsWith('data:image/')) return avatar;
  return `/bot-avatars/${avatar && IDS.has(avatar) ? avatar : DEFAULT_AVATAR}.webp`;
}

/**
 * Shrink an uploaded picture to a square avatar (cropped to the centre) and
 * return it as a WebP data URL small enough to keep with the bot.
 */
export function resizeAvatar(file: File, size = 160): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { reject(new Error('Choose a PNG, JPEG, WebP or GIF picture.')); return; }
    if (file.size > 15 * 1024 * 1024) { reject(new Error('That picture is over 15 MB.')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error('Could not read the picture.')); return; }
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      const webp = canvas.toDataURL('image/webp', 0.86);
      resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the picture.')); };
    img.src = url;
  });
}
