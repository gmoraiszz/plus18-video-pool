# +18 Video Pool

Paste Instagram Reel links — or forward them to a Telegram bot from your phone — into a shared pool. Batch-download them, optionally re-templated onto a background image with a procedurally-generated caption header (randomized font, color, position, and emoji on every render, plus per-clip crop/rotation/color jitter, so a batch never looks like a copy-paste job).

## How it works

- **Batch tab**: paste one or more Instagram Reel links, optionally pick a "template" (a background image an account has uploaded), and hit Generate. Each link gets downloaded via `yt-dlp`, optionally composited onto the template with `ffmpeg`/`@napi-rs/canvas`, and uploaded to your storage bucket.
- **Pool tab**: forward a Reel link to your Telegram bot from anywhere, and it lands here — deduplicated (by shortcode), with a real first-frame thumbnail, ready to select and send into the Batch tab instead of manually copy-pasting links.
- **Raw mode**: leave the template empty and Generate just downloads the source video untouched (still guaranteed to come out as playable H.264, regardless of what codec Instagram originally served).

No database — everything is flat JSON files on disk plus your storage bucket for media. Single shared-password login, not a multi-user system.

## Setup

### 1. Install dependencies

```
npm install
```

You'll also need `yt-dlp` and `ffmpeg` (with `ffprobe`) available on `PATH` — install via your platform's package manager (`brew install yt-dlp ffmpeg` on macOS, `apt install ffmpeg` + a manual `yt-dlp` install on most Linux distros).

### 2. Create a storage bucket

Any S3-compatible bucket works; Cloudflare R2 is a good free-tier option:

1. Create an R2 bucket in the Cloudflare dashboard.
2. Enable public access on it (or set up a custom domain) and note the public URL.
3. Create an API token with R2 read/write access — note the Account ID, Access Key ID, and Secret Access Key.

### 3. Create a Telegram bot for the pool

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and follow the prompts. It replies with a bot token.
2. Generate your own random string for `TELEGRAM_POOL_WEBHOOK_SECRET` (e.g. `openssl rand -hex 24`).
3. Once your app is deployed and reachable at a public URL, register the webhook:

```
curl -X POST "https://api.telegram.org/bot<TELEGRAM_POOL_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"<APP_URL>/api/webhooks/telegram-pool","secret_token":"<TELEGRAM_POOL_WEBHOOK_SECRET>"}'
```

Anyone who knows your bot's username can now forward it Reel links to add them to the pool — there's no per-sender allowlist, so treat the bot username as semi-private if that matters to you.

### 4. Configure environment variables

```
cp .env.example .env
```

Fill in `SESSION_SECRET`, `ADMIN_PASSWORD`, the `R2_*` values, and the `TELEGRAM_POOL_*` values from above. `INSTAGRAM_COOKIES_B64` is optional — only needed if you want to download Reels Instagram has flagged as sensitive content when viewed anonymously (export a Netscape-format `cookies.txt` from a logged-in account via a browser extension, then `base64 -i cookies.txt | tr -d '\n'` and paste the result in).

### 5. Run it

```
npm start
```

Visit `http://localhost:3000` (or whatever `PORT`/`APP_URL` you configured) and log in with `ADMIN_PASSWORD`.

## Architecture

A single Express server with no framework beyond that — flat JSON-file stores under `DATA_DIR` (accounts, jobs, pool entries), no database. Media (rendered videos, background templates, pool thumbnails) lives in your S3-compatible bucket, referenced by public URL. All video work (`yt-dlp` download, `ffprobe`/`ffmpeg` compositing and codec verification) happens via subprocess calls, not a library — keeps the Node process itself lightweight and lets you upgrade `yt-dlp` independently of the app whenever Instagram changes something upstream.
