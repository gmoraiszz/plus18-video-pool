# plus18-video-pool

Express app, flat JSON-file storage under `DATA_DIR`, media in an S3-compatible bucket. No database, no build step, no frontend framework — `public/index.html` is a single static page.

Read `README.md` first for what the app does and the full manual setup steps. This file is specifically for a Claude Code (or similar) agent walking a new user through first-time setup in this working directory.

## Setup checklist

Work through these in order. Ask the user for any value you can't determine yourself (API keys, passwords) — never invent or guess a real credential.

1. **Check system dependencies.** Run `yt-dlp --version` and `ffmpeg -version` (also confirms `ffprobe`, which ships with ffmpeg). If either is missing, install via the user's package manager (`brew install yt-dlp ffmpeg` on macOS, `apt install ffmpeg` plus a manual `yt-dlp` binary/pip install on most Linux distros) — ask before installing system packages if the user hasn't already granted that.
2. **Install Node dependencies:** `npm install` in this directory. Requires Node >= 18.
3. **Create `.env`:** copy `.env.example` to `.env`. Fill in each value:
   - `SESSION_SECRET` — generate one yourself: `openssl rand -hex 32`. No need to ask the user.
   - `ADMIN_PASSWORD` — ask the user to pick one; this is the single login password for the whole app (no multi-user accounts).
   - `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` / `R2_PUBLIC_BASE_URL` — the user needs an S3-compatible bucket (Cloudflare R2's free tier is the easiest). Point them at the README's "Create a storage bucket" section; you cannot create the bucket for them (it needs their Cloudflare account), but once they paste in the values, plug them into `.env`.
   - `TELEGRAM_POOL_BOT_TOKEN` — the user creates a bot by messaging `@BotFather` on Telegram and sending `/newbot`. They'll get back a token to paste in.
   - `TELEGRAM_POOL_WEBHOOK_SECRET` — generate yourself: `openssl rand -hex 24`. No need to ask.
   - `APP_URL` — the public HTTPS URL this app will be reachable at. **Telegram's webhook requires a real public URL — `localhost` will not work.** If the user is only running this locally for now, use a tunnel (`ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`) and use the tunnel's URL here; otherwise use their real deployment URL (Railway, Render, Fly.io, a VPS, etc.).
   - `INSTAGRAM_COOKIES_B64` — optional, leave blank unless the user specifically needs to download Reels Instagram flags as sensitive/+18 content. If they want it: they export a Netscape-format `cookies.txt` from a logged-in Instagram account (browser extension like "Get cookies.txt"), then `base64 -i cookies.txt | tr -d '\n'` and paste the result in.
4. **Start the app:** `npm start`. Confirm it boots without errors and `http://localhost:PORT` returns the login page.
5. **Register the Telegram webhook** (only once `APP_URL` is a real reachable public HTTPS URL — via tunnel or real deploy):
   ```
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_POOL_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"<APP_URL>/api/webhooks/telegram-pool","secret_token":"<TELEGRAM_POOL_WEBHOOK_SECRET>"}'
   ```
   Confirm success with `{"ok":true,...}`. If `APP_URL` isn't reachable yet, this call will fail — get a public URL sorted first.
6. **Smoke test:** log in with `ADMIN_PASSWORD`, add an account under the accounts modal (optionally upload a background image as a template), paste one public Instagram Reel link into the Batch tab, and Generate. Confirm a rendered/downloaded video comes back. Then send a Reel link to the Telegram bot and confirm it shows up in the Pool tab after refreshing.

## Notes for future changes in this repo

- `lib/reels-fetch.js`'s `fetchReelVideoBuffer` always verifies the downloaded codec via `ffprobe` and transcodes to H.264 if it isn't already — this is intentional (Instagram sometimes serves VP9/HEVC/AV1, which most players including QuickTime/iOS won't play). Don't remove this check to save time; it's the fix for a real recurring bug, not a defensive extra.
- `lib/reels18-header.js` uses `@napi-rs/canvas` for font/image compositing and loads fonts/emoji from `public/assets/`. If you move those asset files, update `ASSETS_DIR`/`EMOJI_DIR` in that file to match.
- No automated test suite exists yet in this repo. If you add significant logic, consider adding `node --test` tests (Node's built-in test runner, no extra dependency needed) rather than introducing a new test framework.
- Auth is intentionally minimal (one shared password via `express-session`) — this is a single-operator tool, not a multi-tenant product. Don't add user accounts/roles unless that's an explicit, deliberate scope change.
