'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { loadImage, createCanvas } = require('@napi-rs/canvas');
const execFileAsync = promisify(execFile);

// Motion-detection crop: finds the region of a source video that's
// actually moving (as opposed to static background/letterboxing) so the
// render pipeline can crop tightly to just the real clip content. Plain
// JS + ffmpeg + @napi-rs/canvas, no external runtime/scripting language
// dependency.

// Finds the longest contiguous run of indices whose count clears
// frac * size, so a handful of stray noise pixels along one row/column
// (e.g. compression artifacts on a static border) can't drag a boundary
// outward the way a raw min/max over the mask would. Pure function, no I/O.
function largestDenseRun(counts, frac, size) {
  const threshold = frac * size;
  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i < counts.length; i++) {
    const valid = counts[i] > threshold;
    if (valid && start === -1) {
      start = i;
    } else if (!valid && start !== -1) {
      if (i - start > bestLen) {
        bestLen = i - start;
        bestStart = start;
        bestEnd = i - 1;
      }
      start = -1;
    }
  }
  if (start !== -1 && counts.length - start > bestLen) {
    bestStart = start;
    bestEnd = counts.length - 1;
  }
  return bestStart === -1 ? null : { start: bestStart, end: bestEnd };
}

// Given N grayscale frames (Float32Array of length w*h each, same w/h),
// returns the detected motion box in source pixels: {x, y, w, h}.
// Pure function, no I/O -- the thing under test.
function detectMotionBoxFromFrames(grayFrames, w, h, { threshold = 12, densityFrac = 0.05, minFrac = 0.06, edgeTrimPx = 5 } = {}) {
  if (grayFrames.length < 2) throw new Error('Need at least 2 frames to detect motion.');

  const n = grayFrames.length;
  const pixelCount = w * h;
  const std = new Float32Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) {
    let sum = 0;
    for (let f = 0; f < n; f++) sum += grayFrames[f][p];
    const mean = sum / n;
    let variance = 0;
    for (let f = 0; f < n; f++) {
      const d = grayFrames[f][p] - mean;
      variance += d * d;
    }
    std[p] = Math.sqrt(variance / n);
  }

  let movingCount = 0;
  const mask = new Uint8Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) {
    if (std[p] > threshold) {
      mask[p] = 1;
      movingCount++;
    }
  }

  if (movingCount < minFrac * pixelCount) {
    throw new Error('No significant motion detected (video may be mostly static, or threshold needs tuning).');
  }

  const rowCounts = new Int32Array(h);
  const colCounts = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[rowBase + x]) {
        rowCounts[y]++;
        colCounts[x]++;
      }
    }
  }

  const rowRun = largestDenseRun(rowCounts, densityFrac, w);
  const colRun = largestDenseRun(colCounts, densityFrac, h);
  if (!rowRun || !colRun) {
    throw new Error('Motion is too sparse/scattered to isolate a clean box.');
  }

  let y0 = rowRun.start + edgeTrimPx;
  let y1 = rowRun.end - edgeTrimPx;
  let x0 = colRun.start + edgeTrimPx;
  let x1 = colRun.end - edgeTrimPx;

  const boxW = Math.floor((x1 - x0 + 1) / 2) * 2;
  const boxH = Math.floor((y1 - y0 + 1) / 2) * 2;
  if (boxW <= 0 || boxH <= 0) {
    throw new Error('Motion box collapsed to nothing after edge trim -- source video may be too small/short.');
  }
  return { x: x0, y: y0, w: boxW, h: boxH };
}

// Decodes a PNG/JPEG buffer to a grayscale Float32Array via @napi-rs/canvas
// (RGBA getImageData -> luminance).
async function imageBufferToGray(buffer) {
  const img = await loadImage(buffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  const gray = new Float32Array(img.width * img.height);
  for (let p = 0, i = 0; i < data.length; i += 4, p++) {
    // Standard luminance weights, matches typical BGR2GRAY coefficients closely enough for this purpose.
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { gray, width: img.width, height: img.height };
}

async function ffprobeVideoInfo(videoPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
    '-of', 'json',
    videoPath,
  ], { timeout: 15000 });
  const data = JSON.parse(stdout);
  const stream = (data.streams || [])[0];
  const duration = parseFloat((data.format || {}).duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not read video dimensions/duration.');
  }
  // r_frame_rate comes back as a fraction string ("30/1", "30000/1001"),
  // not a plain number.
  const [num, den] = String(stream.r_frame_rate || '30/1').split('/').map(Number);
  const fps = den ? num / den : num;
  return { width: stream.width, height: stream.height, duration, fps: fps || 30 };
}

// Pulls ~sampleCount evenly-spaced frames in ONE ffmpeg invocation instead
// of one process per frame -- resamples the whole clip to a low fps
// (fps=1/interval lands on ~sampleCount frames spread evenly across the
// usable middle of the clip) and streams raw rgb24 pixels straight out in
// one pass, no PNG codec involved and only one process to spawn.
async function extractSampleFramesRaw(videoPath, width, height, duration, sampleCount) {
  const margin = duration * 0.02;
  const usable = Math.max(duration - margin * 2, 0.1);
  const interval = Math.max(usable / sampleCount, 0.01);
  const { stdout } = await execFileAsync('ffmpeg', [
    '-ss', String(margin),
    '-i', videoPath,
    '-t', String(usable),
    '-vf', `fps=1/${interval}`,
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    '-',
  ], { timeout: 30000, maxBuffer: 250 * 1024 * 1024, encoding: 'buffer' });

  const frameBytes = width * height * 3;
  const frameCount = Math.floor(stdout.length / frameBytes);
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const rgb = stdout.subarray(i * frameBytes, (i + 1) * frameBytes);
    const gray = new Float32Array(width * height);
    for (let p = 0, o = 0; p < width * height; p++, o += 3) {
      gray[p] = 0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2];
    }
    frames.push(gray);
  }
  return frames;
}

// I/O-performing entry point; detectMotionBoxFromFrames above is the pure
// logic under test.
async function detectMotionBox(videoPath, opts = {}) {
  const sampleCount = opts.sampleCount || 24;
  const { width, height, duration } = await ffprobeVideoInfo(videoPath);
  const grayFrames = await extractSampleFramesRaw(videoPath, width, height, duration, sampleCount);
  return detectMotionBoxFromFrames(grayFrames, width, height, opts);
}

module.exports = {
  largestDenseRun,
  detectMotionBoxFromFrames,
  detectMotionBox,
  imageBufferToGray,
  ffprobeVideoInfo,
};
