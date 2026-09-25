The download page and license check

- Free mode: while the licensing settings are empty, /download shows "Early access" with direct download buttons. I tested this on your running dev server and the Windows button goes to the v5.1.0 installer.
- Licensed mode: turns on when all three licensing settings are filled in. It fixes every problem I found:
  - Only keys for your Spacron product in your Lemon Squeezy store are accepted.
  - A new device is activated once. Repeat visits only re-check the key, so they don't use up the buyer's device slots.
  - The key is no longer in the download URL or saved in the browser. Download links are signed and expire after 15 minutes.
  - The license endpoint allows 10 tries per 10 minutes per visitor.
- Half-finished setup: if only some of the settings are filled in, downloads switch off instead of quietly becoming free.
- I tested licensed mode with simulated Lemon Squeezy responses: another store's key, a wrong key, a key out of device slots, a returning device, a forged or expired link, and the license server being unreachable. It hasn't been tested against the real Lemon Squeezy account yet.

Turning on licensing later

1. In Lemon Squeezy, create a "Spacron" product at $49 one-time, turn on license keys, and set the activation limit to 3.
2. In Vercel, go to Project, then Settings, then Environment Variables, and add:
   - LEMONSQUEEZY_STORE_ID: shown under Settings > Stores.
   - LEMONSQUEEZY_PRODUCT_ID: the number in the product page's URL.
   - DOWNLOAD_TOKEN_SECRET: generate one with node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   - SPACRON_CHECKOUT_URL: your checkout link, which the "Buy now" buttons use.
3. Redeploy, then buy the product yourself in Lemon Squeezy's test mode to try the whole flow.
4. Optionally, add a Vercel Firewall rate-limit rule on /api/license/\*. The built-in limit only applies per server instance, so it isn't a hard limit.

These steps are also written into website/.env.example.

Still open (on purpose, for now)

- The installers are still on the public GitHub releases repo, so anyone can bypass the page even in licensed mode. That's fine while you're sharing with friends. When you go paid, the updater and remote-server downloads need to move with it.
- The app itself doesn't check for a license yet.
- Installers aren't code-signed yet.

Nothing is committed: several of these website files are other people's unfinished work, so committing would include theirs too. Say the word and I'll commit just my changes and push so CI goes green.
