'use strict';

// +18 Video Pool -- a standalone Express app: paste Instagram Reel links
// (or forward them to a Telegram bot) to batch-download them, optionally
// re-templated onto a background image with a procedurally-generated
// caption header. No database -- flat JSON-file stores on disk, media in
// Cloudflare R2 (or any S3-compatible bucket), yt-dlp/ffmpeg subprocess
// calls for everything video-related. Single shared-password auth, not a
// multi-user system.

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const { uploadObject, deleteObject } = require('./lib/r2');
const { fetchReelVideoBuffer, fetchReelFirstFrameBuffer } = require('./lib/reels-fetch');
const { composeReel18 } = require('./lib/reels18-render');
const { composeProceduralHeader } = require('./lib/reels18-header');
const { streamBatchZip } = require('./lib/reels18-zip');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!process.env.ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is required. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is required. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) return res.status(401).json({ error: 'Not authorized.' });
  next();
}

app.post('/api/login', express.json(), (req, res) => {
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const expected = Buffer.from(process.env.ADMIN_PASSWORD);
  const given = Buffer.from(password);
  const ok = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!ok) return res.status(401).json({ error: 'Wrong password.' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ isAdmin: Boolean(req.session && req.session.isAdmin) });
});

// --- Serializes every mutation through one promise chain -- the only
// concurrency this process can actually have (single Node instance, no
// cluster mode). ---------------------------------------------------------
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
  const result = writeQueue.then(fn);
  writeQueue = result.catch(() => {});
  return result;
}

async function atomicWriteJson(file, data) {
  const tmpPath = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, file);
}
async function ensureJsonStore(file) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await atomicWriteJson(file, []);
  }
}
async function readJsonStore(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

// --- Accounts (background/template management) ---------------------------
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ensureAccountsStore = () => ensureJsonStore(ACCOUNTS_FILE);
const readAccounts = () => readJsonStore(ACCOUNTS_FILE);
const writeAccounts = (accounts) => atomicWriteJson(ACCOUNTS_FILE, accounts);
const makeAccountId = () => `acct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// --- Jobs (one record per link x template pairing produced by a batch) ---
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const ensureJobsStore = () => ensureJsonStore(JOBS_FILE);
const readJobs = () => readJsonStore(JOBS_FILE);
const writeJobs = (jobs) => atomicWriteJson(JOBS_FILE, jobs);
const makeJobId = () => `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const makeBatchId = () => `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function updateJob(id, patch) {
  await withWriteLock(async () => {
    const jobs = await readJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    Object.assign(job, patch, { updatedAt: Date.now() });
    await writeJobs(jobs);
  });
}

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
async function sweepExpiredJobs() {
  const jobs = await readJobs();
  const now = Date.now();
  const expired = jobs.filter((j) => j.expiresAt && j.expiresAt <= now);
  for (const job of expired) {
    if (job.renderedKey) await deleteObject(job.renderedKey).catch(() => {});
  }
  if (expired.length === 0) return;
  const expiredIds = new Set(expired.map((j) => j.id));
  await withWriteLock(async () => {
    const fresh = await readJobs();
    await writeJobs(fresh.filter((j) => !expiredIds.has(j.id)));
  });
}

// --- Pool (Telegram drop-box) ---------------------------------------------
const POOL_FILE = path.join(DATA_DIR, 'pool.json');
const ensurePoolStore = () => ensureJsonStore(POOL_FILE);
const readPool = () => readJsonStore(POOL_FILE);
const writePool = (pool) => atomicWriteJson(POOL_FILE, pool);
const makePoolId = () => `pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Instagram sometimes wraps a shared link through an l.instagram.com
// redirect (?u=<encoded target>) -- unwrap that first so the shortcode
// regex below sees the real instagram.com/reel/<code> URL either way.
function extractShortcode(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let target = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    const wrapped = parsed.searchParams.get('u');
    if (wrapped) target = decodeURIComponent(wrapped);
  } catch {
    // Not a valid absolute URL -- fall through and try the regex on the raw string anyway.
  }
  const match = target.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

function extractUrlFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/https?:\/\/[^\s]*instagram\.com\/(?:reel|reels|p)\/[^\s]+/i);
  return match ? match[0] : null;
}

// Dedup key is the shortcode when extractable, falling back to the raw URL
// (still catches an exact repeat send even when shortcode resolution
// fails). A duplicate is still appended -- not dropped -- with status
// 'duplicate' so the send is visibly acknowledged in the pool list. A
// duplicate reuses the ORIGINAL's already-resolved thumbnail (if any)
// synchronously, so it renders with a thumbnail immediately too.
async function addPoolEntry(rawUrl) {
  const shortcode = extractShortcode(rawUrl);
  const dedupKey = shortcode || rawUrl;
  let entry;
  await withWriteLock(async () => {
    const pool = await readPool();
    const existing = pool.find((e) => (e.shortcode || e.url) === dedupKey);
    entry = {
      id: makePoolId(),
      shortcode: shortcode || null,
      url: rawUrl,
      thumbnailUrl: existing ? existing.thumbnailUrl : null,
      receivedAt: Date.now(),
      status: existing ? 'duplicate' : 'new',
    };
    pool.push(entry);
    await writePool(pool);
  });
  return entry;
}

async function updatePoolEntry(id, patch) {
  await withWriteLock(async () => {
    const pool = await readPool();
    const entry = pool.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    await writePool(pool);
  });
}

// Fire-and-forget from the webhook handler (never awaited) -- thumbnail
// resolution is best-effort and shouldn't delay the sender's confirmation
// reply. Uploads to storage (not just the raw extracted-frame bytes'
// origin) since this needs a stable, permanent URL for the pool grid.
async function resolvePoolThumbnail(id, url, opts = {}) {
  const fetchReelFirstFrameBufferImpl = opts.fetchReelFirstFrameBufferImpl || fetchReelFirstFrameBuffer;
  const uploadObjectImpl = opts.uploadObjectImpl || uploadObject;
  try {
    const buffer = await fetchReelFirstFrameBufferImpl(url);
    if (!buffer) return;
    const thumbnailUrl = await uploadObjectImpl(`pool/${id}.jpg`, buffer, 'image/jpeg');
    await updatePoolEntry(id, { thumbnailUrl });
  } catch (err) {
    console.error('Pool thumbnail resolution failed:', err.message);
  }
}

// --- Batch runner ----------------------------------------------------------
// Processes a batch's jobs with a small worker pool rather than either
// fully sequential or unbounded Promise.all -- downloading (yt-dlp
// lookup + fetch) is network-bound/near-zero CPU, so letting one job's
// network wait overlap with another job's ffmpeg work meaningfully speeds
// up a batch without the unbounded-parallel-ffmpeg risk of no cap at all.
// One bad link never aborts the rest of the batch.
async function runBatch(batchId, opts = {}) {
  const fetchReelVideoBufferImpl = opts.fetchReelVideoBufferImpl || fetchReelVideoBuffer;
  const composeProceduralHeaderImpl = opts.composeProceduralHeaderImpl || composeProceduralHeader;
  const composeReel18Impl = opts.composeReel18Impl || composeReel18;
  const fetchImpl = opts.fetchImpl || fetch;
  const uploadObjectImpl = opts.uploadObjectImpl || uploadObject;
  const concurrency = opts.concurrency || 3;

  const jobs = (await readJobs()).filter((j) => j.batchId === batchId);

  // Every job in a batch targeting the same source link shares the SAME
  // downloaded video (if the same link appears more than once), and every
  // job in a "template" mode batch shares the SAME account background --
  // these caches turn that into one yt-dlp lookup / one fetch instead of
  // one per job. They hold PROMISES rather than resolved buffers so two
  // concurrent workers racing for the same link/background share one
  // in-flight fetch instead of double-fetching.
  const videoCache = new Map();
  function getVideoBuffer(sourceUrl) {
    if (!videoCache.has(sourceUrl)) videoCache.set(sourceUrl, fetchReelVideoBufferImpl(sourceUrl));
    return videoCache.get(sourceUrl);
  }
  const backgroundCache = new Map();
  function getBackgroundBuffer(backgroundUrl) {
    if (!backgroundCache.has(backgroundUrl)) {
      backgroundCache.set(backgroundUrl, (async () => {
        const backgroundRes = await fetchImpl(backgroundUrl);
        if (!backgroundRes.ok) throw new Error(`Background fetch failed: ${backgroundRes.status}`);
        return Buffer.from(await backgroundRes.arrayBuffer());
      })());
    }
    return backgroundCache.get(backgroundUrl);
  }

  async function processJob(job) {
    try {
      await updateJob(job.id, { status: 'downloading' });
      const videoBuffer = await getVideoBuffer(job.sourceUrl);
      if (!videoBuffer) {
        await updateJob(job.id, { status: 'failed', error: "Couldn't download this link -- check it's a public Instagram Reel." });
        return;
      }

      // Raw-mode jobs (job.backgroundKey is null) skip compositing entirely
      // -- the fetched buffer is uploaded exactly as downloaded, no crop/
      // jitter/header.
      let outputBuffer;
      if (job.backgroundKey) {
        await updateJob(job.id, { status: 'rendering' });
        const backgroundBuffer = await getBackgroundBuffer(job.backgroundUrl);
        // Generated fresh PER JOB (not cached like the background itself)
        // -- every job gets its own random font/color/position/emoji, even
        // within the same batch sharing one background.
        const { buffer: templateBuffer, headerBottomPx } = await composeProceduralHeaderImpl(backgroundBuffer);
        outputBuffer = await composeReel18Impl({ videoBuffer, templateBuffer, headerBottomPx, mirror: job.mirror });
      } else {
        outputBuffer = videoBuffer;
      }

      const renderedKey = `jobs/${job.id}/rendered.mp4`;
      const renderedUrl = await uploadObjectImpl(renderedKey, outputBuffer, 'video/mp4');
      await updateJob(job.id, { status: 'rendered', renderedKey, renderedUrl, renderedAt: Date.now(), error: null });
    } catch (err) {
      await updateJob(job.id, { status: 'failed', error: err.message || 'Failed to render.' });
      if (err.cookiesLikelyDown) {
        console.error('The Instagram cookies session looks dead (downloads are failing). Export a fresh cookies.txt and update INSTAGRAM_COOKIES_B64.');
      }
    }
  }

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < jobs.length) {
      const job = jobs[nextIndex++];
      await processJob(job);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
}

// --- Telegram pool webhook --------------------------------------------------
// Anyone with the bot's username can forward a Reel link to it; the bot
// replies confirming add/duplicate so the sender knows it landed.
// Authenticated via Telegram's own X-Telegram-Bot-Api-Secret-Token header
// (set at webhook-registration time, see README) -- server-to-server from
// Telegram, not a logged-in session.
async function sendTelegramPoolReply(chatId, text) {
  if (!process.env.TELEGRAM_POOL_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_POOL_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // Best-effort UX confirmation -- a failed reply shouldn't affect the pool insert, which already happened.
  }
}

app.post('/api/webhooks/telegram-pool', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!process.env.TELEGRAM_POOL_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_POOL_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack immediately -- pool insert + reply happen best-effort after
  try {
    const message = req.body && req.body.message;
    if (!message) return;
    const url = extractUrlFromText(message.text || message.caption || '');
    const chatId = message.chat && message.chat.id;
    if (!url) {
      if (chatId) await sendTelegramPoolReply(chatId, "Didn't find an Instagram Reel link in that message.");
      return;
    }
    const entry = await addPoolEntry(url);
    if (entry.status === 'new') resolvePoolThumbnail(entry.id, entry.url).catch(() => {});
    if (chatId) await sendTelegramPoolReply(chatId, entry.status === 'duplicate' ? 'Already in the pool.' : 'Added to the pool.');
  } catch (err) {
    console.error('Telegram pool webhook processing failed:', err.message);
  }
});

// --- Admin API: accounts ----------------------------------------------------
app.get('/api/accounts', requireAdmin, async (req, res) => {
  try {
    res.json(await readAccounts());
  } catch {
    res.status(500).json({ error: 'Failed to load accounts.' });
  }
});

app.post('/api/accounts', requireAdmin, async (req, res) => {
  const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
  if (!label) return res.status(400).json({ error: 'label is required.' });
  const account = { id: makeAccountId(), label, createdAt: Date.now(), backgroundKey: null, backgroundUrl: null };
  await withWriteLock(async () => {
    const accounts = await readAccounts();
    accounts.push(account);
    await writeAccounts(accounts);
  });
  res.status(201).json(account);
});

app.delete('/api/accounts/:id', requireAdmin, async (req, res) => {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.id === req.params.id);
  if (account && account.backgroundKey) await deleteObject(account.backgroundKey).catch(() => {});
  await withWriteLock(async () => {
    const fresh = await readAccounts();
    await writeAccounts(fresh.filter((a) => a.id !== req.params.id));
  });
  res.json({ ok: true });
});

const MAGIC_BYTES = [
  { ext: '.png', type: 'image/png', sig: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { ext: '.jpg', type: 'image/jpeg', sig: Buffer.from([0xff, 0xd8, 0xff]) },
  { ext: '.gif', type: 'image/gif', sig: Buffer.from('GIF8', 'ascii') },
];
function sniffImageType(buf) {
  for (const candidate of MAGIC_BYTES) {
    if (buf.length >= candidate.sig.length && buf.subarray(0, candidate.sig.length).equals(candidate.sig)) {
      return candidate;
    }
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: '.webp', type: 'image/webp' };
  }
  return null;
}

const uploadDiskStorage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.tmp`),
});
const upload = multer({ storage: uploadDiskStorage, limits: { fileSize: 25 * 1024 * 1024 } });

// One background texture per account, stored under a FIXED key so
// re-uploading always replaces it in place instead of accumulating
// orphaned files. Always re-encoded to PNG so composeProceduralHeader
// never has to handle multiple source formats. Never trusts the client's
// claimed content-type -- sniffs the actual bytes on disk instead.
app.post('/api/accounts/:id/background', requireAdmin, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Background must be under 25MB.' : 'Upload failed.' });
    }
    if (err) return res.status(500).json({ error: 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const tmpPath = req.file.path;
    try {
      const buffer = await fs.readFile(tmpPath);
      const sniffed = sniffImageType(buffer.subarray(0, 16));
      if (!sniffed || !['.png', '.jpg', '.jpeg', '.webp'].includes(sniffed.ext)) {
        return res.status(400).json({ error: 'Background must be a PNG, JPG, or WEBP image.' });
      }
      const img = await loadImage(buffer);
      const canvas = createCanvas(img.width, img.height);
      canvas.getContext('2d').drawImage(img, 0, 0);
      const pngBuffer = canvas.toBuffer('image/png');

      const accounts = await readAccounts();
      const account = accounts.find((a) => a.id === req.params.id);
      if (!account) return res.status(404).json({ error: 'Unknown account.' });

      const key = `backgrounds/${req.params.id}/background.png`;
      const url = await uploadObject(key, pngBuffer, 'image/png');

      await withWriteLock(async () => {
        const fresh = await readAccounts();
        const freshAccount = fresh.find((a) => a.id === req.params.id);
        if (freshAccount) { freshAccount.backgroundKey = key; freshAccount.backgroundUrl = url; }
        await writeAccounts(fresh);
      });

      res.status(201).json({ backgroundKey: key, backgroundUrl: url });
    } catch {
      res.status(500).json({ error: 'Upload failed.' });
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });
});

// --- Admin API: pool ---------------------------------------------------------
app.get('/api/pool', requireAdmin, async (req, res) => {
  try {
    const pool = await readPool();
    res.json(pool.slice().sort((a, b) => b.receivedAt - a.receivedAt));
  } catch {
    res.status(500).json({ error: 'Failed to load pool.' });
  }
});

app.delete('/api/pool/:id', requireAdmin, async (req, res) => {
  await deleteObject(`pool/${req.params.id}.jpg`).catch(() => {});
  await withWriteLock(async () => {
    const pool = await readPool();
    await writePool(pool.filter((e) => e.id !== req.params.id));
  });
  res.json({ ok: true });
});

// One-time-per-backlog (and ongoing retry) trigger for entries whose
// thumbnail never resolved (e.g. a transient yt-dlp failure). Acks
// immediately and resolves in the background with a small worker-pool
// concurrency, same reasoning as runBatch.
app.post('/api/pool/backfill-thumbnails', requireAdmin, async (req, res) => {
  const pool = await readPool();
  const missing = pool.filter((e) => !e.thumbnailUrl);
  res.json({ resolving: missing.length });
  let next = 0;
  async function worker() {
    while (next < missing.length) {
      const entry = missing[next++];
      await resolvePoolThumbnail(entry.id, entry.url).catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
});

// --- Admin API: batches -------------------------------------------------------
app.post('/api/batches', requireAdmin, async (req, res) => {
  const { accountId, mode, mirror } = req.body;
  const urls = Array.isArray(req.body.urls) ? req.body.urls.map((u) => String(u).trim()).filter(Boolean) : [];

  if (urls.length === 0) return res.status(400).json({ error: 'At least one link is required.' });
  if (mode !== 'template' && mode !== 'raw') return res.status(400).json({ error: 'mode must be "template" or "raw".' });

  // "raw" mode skips the background/header entirely -- the fetched source
  // is uploaded untouched. "template" mode uses the account's single
  // background texture, with every job's header generated and randomized
  // independently at render time.
  let pairs;
  let resolvedAccountId = null;
  if (mode === 'raw') {
    pairs = urls.map((url) => ({ url, backgroundKey: null }));
  } else {
    const accounts = await readAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return res.status(400).json({ error: 'Unknown account.' });
    if (!account.backgroundKey) return res.status(400).json({ error: 'This account has no background uploaded yet.' });
    resolvedAccountId = accountId;
    pairs = urls.map((url) => ({ url, backgroundKey: account.backgroundKey }));
  }

  const batchId = makeBatchId();
  const now = Date.now();
  const jobs = pairs.map(({ url, backgroundKey }) => ({
    id: makeJobId(),
    batchId,
    accountId: resolvedAccountId,
    backgroundKey,
    backgroundUrl: backgroundKey ? `${process.env.R2_PUBLIC_BASE_URL}/${backgroundKey}` : null,
    sourceUrl: url,
    mirror: !!mirror,
    status: 'queued',
    renderedKey: null,
    renderedUrl: null,
    error: null,
    createdAt: now,
    renderedAt: null,
    expiresAt: now + JOB_TTL_MS,
  }));

  await withWriteLock(async () => {
    const existing = await readJobs();
    await writeJobs([...existing, ...jobs]);
  });

  res.status(202).json({ batchId, jobCount: jobs.length });
  runBatch(batchId);
});

app.get('/api/batches/:batchId', requireAdmin, async (req, res) => {
  const jobs = (await readJobs()).filter((j) => j.batchId === req.params.batchId);
  res.json(jobs);
});

app.get('/api/batches/:batchId/download-all', requireAdmin, async (req, res) => {
  const jobs = (await readJobs()).filter((j) => j.batchId === req.params.batchId);
  try {
    await streamBatchZip(res, jobs);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Failed to build zip.' });
  }
});

// A plain `<a href download>` silently degrades to "just navigate there"
// for a cross-origin URL (no CORS policy on the bucket), which is exactly
// the "opens a new tab instead of downloading" bug this fixes. Proxying
// the bytes through this same-origin route sidesteps the CORS problem
// entirely. Restricted to this app's own bucket, not an arbitrary URL --
// this route would otherwise be an open proxy an authenticated session
// could use to reach internal network addresses.
app.get('/api/download-proxy', requireAdmin, async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url || !process.env.R2_PUBLIC_BASE_URL || !url.startsWith(`${process.env.R2_PUBLIC_BASE_URL}/`)) {
    return res.status(400).json({ error: 'Invalid download URL.' });
  }
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).json({ error: `Upstream fetch failed: ${upstream.status}` });
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to fetch file.' });
  }
});

// --- Static + boot -----------------------------------------------------------
app.use(express.static(PUBLIC_DIR));

const ready = Promise.all([
  ensureAccountsStore(),
  ensureJobsStore(),
  ensurePoolStore(),
  fs.mkdir(UPLOADS_DIR, { recursive: true }),
]).then(() => {
  sweepExpiredJobs().catch(() => {});
  setInterval(() => sweepExpiredJobs().catch(() => {}), 60 * 60 * 1000).unref();

  if (process.env.INSTAGRAM_COOKIES_B64) {
    const cookiesPath = path.join(DATA_DIR, 'instagram-cookies.txt');
    return fs.writeFile(cookiesPath, Buffer.from(process.env.INSTAGRAM_COOKIES_B64, 'base64')).then(() => {
      process.env.INSTAGRAM_COOKIES_PATH = cookiesPath;
    });
  }
});

let server;
ready.then(() => {
  server = app.listen(PORT, () => console.log(`+18 Video Pool listening on :${PORT}`));
});

module.exports = {
  app, ready, get server() { return server; },
  readAccounts, writeAccounts, ensureAccountsStore, makeAccountId,
  readJobs, writeJobs, ensureJobsStore, makeJobId, makeBatchId, updateJob, runBatch, sweepExpiredJobs,
  readPool, writePool, ensurePoolStore, makePoolId, extractShortcode, extractUrlFromText,
  addPoolEntry, updatePoolEntry, resolvePoolThumbnail, sendTelegramPoolReply,
};
