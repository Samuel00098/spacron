# Spacron pricing & license model

Spacron sells as a **one-time $49 perpetual license**, single tier, per user
(all the user's own machines and OSes). Decided Sep 2026 based on the
one-time-priced agent-workspace market (Lemonade $5, Maestri $18, Nyx $29,
1DevTool $29–89, Sublime/TablePlus $99 anchors): $49 sits above the $5–$29
throwaway tools and under the $99 flagships.

License terms advertised on the site (website/app/page.tsx `licensePoints`):
12 months of updates included, optional renewal after, 30-day money-back, no
account, local-first. Key theory of value: buyer already pays for AI
subscriptions, so the price is anchored against those, not against free VS Code.

## How buying/downloading works now (provider: Lemon Squeezy)

- Three modes, from env (website/lib/license.ts `licensingMode`): all of
  LEMONSQUEEZY_STORE_ID / LEMONSQUEEZY_PRODUCT_ID / DOWNLOAD_TOKEN_SECRET empty
  = **open** (free downloads, the "share with friends" phase); all set =
  **enforced**; partly set = downloads off (fails closed on purpose).
- Enforced flow: `/api/license/validate` checks the key belongs to *our*
  store+product (Lemon Squeezy accepts any store's key otherwise) *before*
  activating, activates once per device, and returns the instance id plus a
  15-min HMAC download token. The browser keeps the instance id and sends it
  back, so return visits re-validate instead of activating again: Lemon
  Squeezy does not document deduping activations by instance name, so assume each one burns a slot.
- The license API needs no Lemon Squeezy API key; it is form-encoded.
- The in-memory rate limit is per serverless instance only; a Vercel Firewall
  rule on /api/license/* is the real limit.

## Not wired yet

- The desktop app has **no in-app license activation/validation** — a licensed
  install today can't be locked to a key, and there's no settings field to
  paste one. The website is the only gate.
- No webhook handling (order/license events) on the site.
- Installers still live in the **public** spacron-releases repo, so the gate
  is bypassable by going to GitHub directly. Making it private also breaks the
  in-app updater (`tauri.conf.json` endpoint) and the remote-server wizard's
  binary download, which both read that repo; move all three together.