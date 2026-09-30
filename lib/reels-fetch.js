'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const execFileAsync = promisify(execFile);

// Distinguishes Instagram's "sensitive content" audience gate from every
// other download failure -- yt-dlp's own error is "This content isn't
// available to everyone: It can't be seen by certain audiences," which is
// Instagram refusing an ANONYMOUS (not logged-in) request for a post it's
// flagged as sensitive/adult -- routine for +18 content, not a sign the
// link is broken. A generic "check it's a public Instagram Reel" message
// would be actively misleading here (reads as "your link is wrong" when
// the link is fine), so this gives a message that tells the truth about
// the cause and points at the actual fix (INSTAGRAM_COOKIES_PATH below).
function describeYtDlpFailure(stderr) {
  // yt-dlp's exact wording for "needs a login" varies by case -- "isn't
  // available to everyone" for the explicit sensitive-content gate, but
  // "Instagram sent an empty media response" for other posts anonymous
  // access gets blocked on (same underlying cause, different message).
  if (/isn'?t available to everyone|can'?t be seen by certain audiences|age.restricted|empty media response|failed to parse json/i.test(stderr)) {
    // With INSTAGRAM_COOKIES_PATH set to a valid, unexpired session, this
    // SAME failure can still happen -- cookies change yt-dlp's error
    // (anonymous gives the plain "certain audiences"/"empty media
    // response" text; logged-in gives an empty/non-JSON response instead,
    // "failed to parse json"), so the account IS authenticating, but
    // Instagram still isn't serving the content. That specific combination
    // is the signature of the logged-in account's OWN "Sensitive Content
    // Control" setting being on the default "Limit" instead of "Allow" --
    // a per-account content preference, separate from being logged in at all.
    if (process.env.INSTAGRAM_COOKIES_PATH) {
      return "Instagram is logged in but still won't serve this (sensitive-content gate). This usually means the logged-in account's own Sensitive Content Control is set to \"Limit\" instead of \"Allow\" -- on that Instagram account: Settings -> Account (or Privacy) -> Sensitive content control -> set to \"Allow\". If it's already set to Allow, the session may just need refreshing (re-export cookies.txt and update INSTAGRAM_COOKIES_B64).";
    }
    return "Instagram is hiding this behind its sensitive-content login wall (this is not a broken link -- it's normal for +18 content viewed anonymously). Set up INSTAGRAM_COOKIES_PATH so downloads use a logged-in session.";
  }
  return "Couldn't download this link -- check it's a public Instagram Reel.";
}

// A dead/revoked Instagram session (not just "no cookies configured")
// surfaces as an HTTP 4xx during yt-dlp's own info-extraction step, or as
// "failed to parse json" (Instagram returning an empty/non-JSON body to an
// authenticated request). The batch runner below uses this to alert once
// instead of failing every job in the batch silently one by one, which is
// how a dead session can go unnoticed for a long time otherwise.
function looksLikeDeadCookieSession(stderr) {
  return Boolean(process.env.INSTAGRAM_COOKIES_PATH) && /http error 4\d\d|failed to parse json/i.test(stderr);
}

// Downloads a Reel with BOTH video and audio, merged locally via yt-dlp's
// own ffmpeg-backed merge. Instagram serves Reels as separate DASH
// video-only and audio-only streams, so grabbing one direct format URL
// only ever gets picture with no sound -- yt-dlp's own `-f bv*+ba` + merge
// is the only reliable way to get both without hand-rolling DASH-manifest/
// two-stream-then-mux logic.
//
// INSTAGRAM_COOKIES_PATH (optional): path to a Netscape-format cookies.txt
// exported from a real, logged-in Instagram account. When set and the file
// exists, yt-dlp authenticates as that account, which is what actually
// lets it past the sensitive-content gate above -- without it, yt-dlp
// always requests anonymously and +18-flagged posts will keep failing
// regardless of how valid the link is. Throws (rather than returning null)
// on failure so the caller's error message reflects the real cause.
//
// Format selector prefers an avc1 (H.264) video stream over the old
// codec-agnostic "bv*+ba/best": a raw-mode download (no template, so this
// buffer goes straight to storage/the user untouched) can otherwise pick
// an HEVC/AV1/VP9-only stream that many players (QuickTime, iOS Files)
// refuse to play even though it's a technically valid .mp4. Falls back to
// the old codec-agnostic selector when no avc1 stream exists at all.
const RAW_DOWNLOAD_FORMAT = 'bv*[vcodec^=avc1]+ba/b[vcodec^=avc1]/bv*+ba/best';

// The avc1-preferring selector above only helps when Instagram actually
// OFFERS an H.264 stream for a given Reel; for ones where it doesn't, the
// final fallback still ships whatever codec Instagram has (confirmed: VP9
// and HEVC-only streams both occur in practice), same unplayable result.
// Rather than keep hoping the format list contains avc1, this probes what
// actually got downloaded and transcodes only if it isn't already H.264 --
// guarantees a playable file regardless of source codec, at the cost of a
// transcode for the fraction of Reels that need it (the common
// already-avc1 case pays only the cheap ffprobe check).
async function ensureH264(inputPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', inputPath,
  ], { timeout: 15000 });
  if (stdout.trim() === 'h264') return inputPath;
  const transcodedPath = inputPath.replace(/\.mp4$/, '-h264.mp4');
  await execFileAsync('ffmpeg', [
    '-y', '-i', inputPath,
    '-c:v', 'libx264', '-preset', 'superfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    transcodedPath,
  ], { timeout: 120000, maxBuffer: 50 * 1024 * 1024 });
  return transcodedPath;
}

async function fetchReelVideoBuffer(reelUrl) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plus18-reel-dl-'));
  const outPath = path.join(workDir, 'reel.mp4');
  try {
    const args = ['-f', RAW_DOWNLOAD_FORMAT, '--merge-output-format', 'mp4', '-o', outPath];
    if (process.env.INSTAGRAM_COOKIES_PATH) {
      args.push('--cookies', process.env.INSTAGRAM_COOKIES_PATH);
    }
    args.push(reelUrl);
    await execFileAsync('yt-dlp', args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    const finalPath = await ensureH264(outPath);
    return await fs.readFile(finalPath);
  } catch (err) {
    const stderr = String(err.stderr || err.message || err);
    console.error('[reels-fetch] yt-dlp download failed:', stderr);
    const wrapped = new Error(describeYtDlpFailure(stderr));
    wrapped.cookiesLikelyDown = looksLikeDeadCookieSession(stderr);
    throw wrapped;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// Extracts the actual first VIDEO frame for the pool's grid thumbnails --
// NOT yt-dlp's `thumbnail` metadata field, which is Instagram's creator-set
// post COVER image and is routinely a completely different picture from
// the clip itself. Self-contained (own --dump-json call, own cookies
// handling) rather than a shared metadata-lookup helper, since pool
// content is routinely sensitive-content-gated and needs
// INSTAGRAM_COOKIES_PATH almost every time. ffmpeg only needs to decode
// the first GOP to produce frame 0, not the whole video, so this stays
// fast despite hitting the real stream instead of a static cover-image
// URL. Returns null (not throw) on any failure -- a missing thumbnail
// shouldn't break the pool insert that already happened.
async function fetchReelFirstFrameBuffer(reelUrl) {
  let videoUrl;
  try {
    const args = ['--dump-json', '--skip-download'];
    if (process.env.INSTAGRAM_COOKIES_PATH) args.push('--cookies', process.env.INSTAGRAM_COOKIES_PATH);
    args.push(reelUrl);
    const { stdout } = await execFileAsync('yt-dlp', args, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 });
    const data = JSON.parse(stdout);
    const formats = Array.isArray(data.formats) ? data.formats : [];
    const candidates = formats.filter((f) => f.url && f.ext === 'mp4' && f.width && f.height && (f.protocol === 'https' || f.protocol === 'http'));
    const best = candidates.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
    videoUrl = best && best.url;
  } catch (err) {
    console.error('[reels-fetch] first-frame metadata lookup failed:', err.stderr || err.message || err);
    return null;
  }
  if (!videoUrl) return null;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plus18-reel-frame-'));
  const outPath = path.join(workDir, 'frame.jpg');
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', videoUrl, '-vframes', '1', '-q:v', '3', outPath], { timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
    return await fs.readFile(outPath);
  } catch (err) {
    console.error('[reels-fetch] first-frame extraction failed:', err.stderr || err.message || err);
    return null;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

module.exports = { fetchReelVideoBuffer, fetchReelFirstFrameBuffer };
