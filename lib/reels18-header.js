// lib/reels18-header.js
'use strict';

const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const ASSETS_DIR = path.join(__dirname, '..', 'public', 'assets');
const EMOJI_DIR = path.join(ASSETS_DIR, 'reels18-emoji');
const EMOJI_COUNT = 12;

// Four weights of the same family (not four different fonts) -- keeps a
// consistent look across a batch instead of a grab-bag of unrelated
// typefaces.
// strokeWidthPx is per-font, not global -- a heavier weight's letterforms
// are already thicker, so the same stroke width reads disproportionately
// thin/thick across weights. Tuned per-weight against the white+stroke
// color variant (the only variant that draws a stroke at all).
const FONT_VARIANTS = [
  { family: 'Reels18Montserrat-Bold', file: 'Montserrat-Bold.ttf', strokeWidthPx: 14 },
  { family: 'Reels18Montserrat-ExtraBold', file: 'Montserrat-ExtraBold.ttf', strokeWidthPx: 16 },
  { family: 'Reels18Montserrat-Black', file: 'Montserrat-Black.ttf', strokeWidthPx: 18 },
];
// Registered once at module load -- registerFromPath is cheap and idempotent per family name.
for (const variant of FONT_VARIANTS) {
  GlobalFonts.registerFromPath(path.join(ASSETS_DIR, variant.file), variant.family);
}

// black / dark gray / white-with-stroke. White needs a stroke to stay
// legible on a light background texture; black/gray don't.
const COLOR_VARIANTS = [
  { fill: '#000000', stroke: null },
  { fill: '#333333', stroke: null },
  { fill: '#ffffff', stroke: '#000000' },
];

// Fixed wording -- only the style (font/color/position/size) and the emoji
// randomize, never the words themselves. Change SENTENCE_LINES if you want
// different caption text; the rest of this file is agnostic to what the
// two lines actually say.
const SENTENCE_LINES = ['Nothing is perfect:', 'Me:'];

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;

// These layout constants were tuned by eye against a hand-made reference
// template -- adjust if you want a different look, but they're a matched
// starting point, not arbitrary defaults.
const BASE_FONT_PX = 76;
const LINE_GAP_MULT = 1.25; // 2nd line's baseline offset from the 1st, in units of the chosen font size
const TEXT_TOP_BASE_Y = 270; // 1st line's baseline
const EMOJI_BASE_SIZE = 410;
const EMOJI_GAP_BASE_PX = 20; // gap between the 2nd text line's baseline and the emoji's top edge

// Randomization: text and emoji each roll their OWN independent +-2% size
// jitter, but position only rolls ONE shared +-2%-of-canvas-height
// vertical offset for the whole block -- the text and emoji move together,
// never separated. Achieved by only ever shifting line1Y (the text
// baseline) by this offset; line2Y and the emoji's Y are both computed
// relative to line1Y/line2Y already, so they inherit the same shift
// automatically instead of rolling their own. No horizontal jitter, no
// per-line-vs-emoji independent vertical jitter.
const SIZE_JITTER_MIN = 0.98;
const SIZE_JITTER_MAX = 1.02;
const POSITION_JITTER_FRAC = 0.02;

function randRange(min, max) {
  return min + Math.random() * (max - min);
}
function pickRandomIndex(count) {
  return Math.floor(Math.random() * count);
}

// Loaded once (12 small 512x512 PNGs) and cached as decoded Image objects --
// re-decoding them from disk on every single render would be wasted work
// across a batch of dozens of videos sharing the same 12-emoji pool.
let emojiImagesPromise = null;
function loadEmojiImages() {
  if (!emojiImagesPromise) {
    emojiImagesPromise = Promise.all(
      Array.from({ length: EMOJI_COUNT }, (_, i) => {
        const n = String(i + 1).padStart(2, '0');
        return loadImage(path.join(EMOJI_DIR, `emoji-${n}.png`));
      })
    );
  }
  return emojiImagesPromise;
}

// Scales `img` to fully cover a w x h box (CSS background-size:cover),
// centered, cropping whatever overflows -- so any background texture
// (portrait, landscape, square, any resolution) always fills the canvas
// with no letterboxing, regardless of what's uploaded per account.
function drawCover(ctx, img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const dx = (w - drawW) / 2;
  const dy = (h - drawH) / 2;
  ctx.drawImage(img, dx, dy, drawW, drawH);
}

// Draws the fixed two-line sentence plus a randomly-picked emoji onto a
// fresh 1080x1920 canvas over the given background, with font weight,
// color, position, and size all randomized on every single call -- the
// point being that no two renders, even from the identical background
// texture, share the same header pixels (this is the actual anti-duplicate-
// detection lever; the clip-side jitter in composeReel18 already exists on
// top of this). Returns the composited canvas as a PNG buffer plus
// headerBottomPx: the exact Y where the emoji's bottom edge landed, so the
// caller can place the clip right below it with no pixel-analysis guessing
// (see composeReel18's headerBottomPx parameter).
async function composeProceduralHeader(backgroundBuffer) {
  const [backgroundImg, emojiImages] = await Promise.all([
    loadImage(backgroundBuffer),
    loadEmojiImages(),
  ]);

  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');
  drawCover(ctx, backgroundImg, CANVAS_WIDTH, CANVAS_HEIGHT);

  const fontVariant = FONT_VARIANTS[pickRandomIndex(FONT_VARIANTS.length)];
  const colorVariant = COLOR_VARIANTS[pickRandomIndex(COLOR_VARIANTS.length)];
  const fontPx = Math.round(BASE_FONT_PX * randRange(SIZE_JITTER_MIN, SIZE_JITTER_MAX));
  const centerX = CANVAS_WIDTH / 2;
  // Shared by both the text and the emoji (see the constant's own comment)
  // -- the whole header block moves up/down together as one unit.
  const sharedVerticalOffset = randRange(-CANVAS_HEIGHT * POSITION_JITTER_FRAC, CANVAS_HEIGHT * POSITION_JITTER_FRAC);
  const line1Y = TEXT_TOP_BASE_Y + sharedVerticalOffset;
  const line2Y = line1Y + fontPx * LINE_GAP_MULT;

  ctx.font = `${fontPx}px "${fontVariant.family}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = fontVariant.strokeWidthPx;
  // Default miter joins give the stroke sharp, pointy corners at every
  // letter's inside/outside angles -- round joins/caps soften those into
  // a smoother outline instead.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [line, y] of [[SENTENCE_LINES[0], line1Y], [SENTENCE_LINES[1], line2Y]]) {
    if (colorVariant.stroke) {
      ctx.strokeStyle = colorVariant.stroke;
      ctx.strokeText(line, centerX, y);
    }
    ctx.fillStyle = colorVariant.fill;
    ctx.fillText(line, centerX, y);
  }

  const emojiImg = emojiImages[pickRandomIndex(emojiImages.length)];
  const emojiSize = Math.round(EMOJI_BASE_SIZE * randRange(SIZE_JITTER_MIN, SIZE_JITTER_MAX));
  const emojiX = CANVAS_WIDTH / 2 - emojiSize / 2;
  // No independent offset here -- emojiTopY is relative to line2Y, which
  // already carries the shared vertical offset, so the emoji moves with
  // the text automatically.
  const emojiTopY = line2Y + EMOJI_GAP_BASE_PX;
  ctx.drawImage(emojiImg, emojiX, emojiTopY, emojiSize, emojiSize);

  const buffer = await canvas.encode('png');
  return { buffer, headerBottomPx: Math.round(emojiTopY + emojiSize) };
}

module.exports = { composeProceduralHeader, CANVAS_WIDTH, CANVAS_HEIGHT };
