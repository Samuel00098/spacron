/**
 * Best-effort fixed-window limiter, kept in memory. On Vercel each serverless
 * instance has its own copy, so this slows down a script hammering one warm
 * instance but is not a hard global limit. Pair it with a Vercel Firewall rate
 * limit rule on /api/license/* for that.
 */
const windows = new Map<string, { start: number; count: number }>();

export function rateLimited(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const entry = windows.get(key);
  if (!entry || now - entry.start >= windowMs) {
    if (windows.size > 10_000) windows.clear();
    windows.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

export function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown';
}
