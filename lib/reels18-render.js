'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const execFileAsync = promisify(execFile);
const { loadImage } = require('@napi-rs/canvas');
const { detectMotionBox, ffprobeVideoInfo } = require('./reels18-motion-crop');

function randRange(min, max) {
  return min + Math.random() * (max - min);
}
function randInt(min, max) {
  return Math.floor(randRange(min, max + 1));
}

// Fixed gap between the drawn header's bottom edge and where the clip
// starts -- unrelated to WHERE the header bottom itself is, which the
// caller provides exactly (see composeReel18's headerBottomPx param).
const CLIP_GAP_PX = 60;
// Reusing the same template PNG across a batch is otherwise pixel-for-
// pixel identical every render. Zooming it in slightly (centered) before
// cropping back down to its native canvas size changes its framing just
// enough to break that, without needing per-pixel content detection to
// re-locate anything.
const TEMPLATE_SCALE_MIN = 1.0;
const TEMPLATE_SCALE_MAX = 1.05;
// Subtle film-grain-style noise on the final composited frame -- alls is
// ffmpeg's noise filter strength on a 0-100 scale; this range is well
// below where it reads as visible grain to a viewer, but it still means
// no two renders share the exact same pixel values frame-to-frame.
const NOISE_STRENGTH_MIN = 2;
const NOISE_STRENGTH_MAX = 6;

// Single ffmpeg invocation: crop the source video to its detected motion
// box -> optional hflip -> scale to the template's canvas width (never
// upscaled past native size) -> overlay onto the template image at
// headerBottomPx + CLIP_GAP_PX, preserving the clip's full native
// duration. templateBuffer is expected to be a fully-drawn header image
// (background + text + emoji, see lib/reels18-header.js's
// composeProceduralHeader) and headerBottomPx its exact drawn
// header-bottom Y -- this function doesn't try to detect or guess that
// position itself.
async function composeReel18({ videoBuffer, templateBuffer, headerBottomPx, mirror = false }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plus18-render-'));
  const videoPath = path.join(workDir, 'input.mp4');
  const templatePath = path.join(workDir, 'template.png');
  const outputPath = path.join(workDir, 'output.mp4');
  try {
    await fs.writeFile(videoPath, videoBuffer);
    await fs.writeFile(templatePath, templateBuffer);

    const motionBox = await detectMotionBox(videoPath);
    const { duration, fps, width: videoWidth, height: videoHeight } = await ffprobeVideoInfo(videoPath);
    const templateImg = await loadImage(templateBuffer);
    const canvasWidth = templateImg.width;
    const canvasHeight = templateImg.height;
    if (!Number.isFinite(headerBottomPx)) {
      throw new Error('composeReel18 requires headerBottomPx (the drawn header\'s bottom edge, in px).');
    }
    const clipY = Math.round(headerBottomPx) + CLIP_GAP_PX;

    const templateScale = randRange(TEMPLATE_SCALE_MIN, TEMPLATE_SCALE_MAX);
    const scaledTemplateWidth = Math.round(canvasWidth * templateScale);

    // detectMotionBox can legitimately find only a truly degenerate moving
    // region (a handful of px, effectively noise) -- scaling that up to
    // the full canvas width stretches it into an unusable sliver. Falls
    // back to the clip's full native frame only in that narrow case.
    //
    // A low threshold here (not a "small box means detection failed"
    // assumption) matters because source videos in this niche are
    // frequently ALREADY a fully composited meme (background + caption
    // header + a small inset clip) rather than raw footage -- the detected
    // motion box correctly finds just that small inset clip, and treating
    // it as "too small" would fall back to the FULL downloaded frame,
    // which re-introduces the source video's own baked-in header right
    // below this pipeline's own one.
    const availableHeight = canvasHeight - clipY;
    const motionBoxScaledHeight = motionBox.h * (canvasWidth / motionBox.w);
    const useFullFrame = motionBoxScaledHeight < availableHeight * 0.15;
    const effectiveBox = useFullFrame ? { x: 0, y: 0, w: videoWidth, h: videoHeight } : motionBox;

    // A batch made from the same fixed crop/scale/header-position math on
    // every single video, every time, is itself a fingerprint -- a manual
    // editor never frames, trims, or grades two clips identically.
    // Everything below is a small, per-render random nudge (never enough
    // to be visible to a viewer) meant to break that exact-repeat pattern
    // across a batch: a few frames trimmed off each end, a hair of
    // rotation, a touch of contrast/brightness drift.
    const frameDur = 1 / fps;
    const trimStartSec = randInt(0, 5) * frameDur;
    const trimEndSec = randInt(0, 5) * frameDur;
    const trimmedDuration = Math.max(duration - trimStartSec - trimEndSec, 0.5);

    // Stays "horizontal" (no visible tilt) at +-1 deg -- overscaling the
    // clip by a few percent before rotating and cropping back down to the
    // target size is what keeps the corners from showing black slivers
    // after the rotation (rotating a rectangle in place always exposes
    // its corners unless the source is a bit bigger than the frame).
    const rotationRad = randRange(-1, 1) * (Math.PI / 180);
    const OVERSCALE = 1.03;
    const overscaledWidth = Math.round(canvasWidth * OVERSCALE);

    const contrast = randRange(0.92, 1.08);
    const brightness = randRange(-0.08, 0.08);
    // Same template file rendered twice is otherwise near pixel-for-pixel
    // identical -- an independent contrast/brightness drift on top of its
    // own scale jitter above changes its pixel hash further still.
    const templateContrast = randRange(0.9, 1.1);
    const templateBrightness = randRange(-0.08, 0.08);
    const noiseStrength = randRange(NOISE_STRENGTH_MIN, NOISE_STRENGTH_MAX);

    const cropFilter = `crop=${effectiveBox.w}:${effectiveBox.h}:${effectiveBox.x}:${effectiveBox.y}`;
    const flipFilter = mirror ? ',hflip' : '';
    // -ss seeks the video's start, but the resulting stream keeps its
    // ORIGINAL timestamps rather than resetting to 0. The template's own
    // stream (from -loop 1) starts its timeline at 0, so the overlay
    // filter would otherwise wait for the video's PTS to catch up to
    // where it "really" was before showing any of it -- exactly as many
    // frames of template-only output as were trimmed off the start.
    // setpts=PTS-STARTPTS resets the trimmed video's timeline to start at
    // 0 so it lines up with the template from the first frame.
    const filterComplex = `[0:v]setpts=PTS-STARTPTS,${cropFilter}${flipFilter},scale=${overscaledWidth}:-2,rotate=${rotationRad.toFixed(5)}:ow=iw:oh=ih,crop=trunc(iw/${OVERSCALE}/2)*2:trunc(ih/${OVERSCALE}/2)*2,eq=contrast=${contrast.toFixed(3)}:brightness=${brightness.toFixed(3)}[vid];[1:v]scale=${scaledTemplateWidth}:-2,crop=${canvasWidth}:${canvasHeight},eq=contrast=${templateContrast.toFixed(3)}:brightness=${templateBrightness.toFixed(3)}[tpl];[tpl][vid]overlay=0:${clipY}:shortest=1,noise=alls=${noiseStrength.toFixed(2)}:allf=t+u[out]`;

    await execFileAsync('ffmpeg', [
      '-y',
      // Both -ss and -t are INPUT options and must precede the -i they're
      // meant to apply to -- placed after "-i videoPath" but before the
      // template's own "-i", ffmpeg would attach them to the TEMPLATE
      // input instead of the video.
      '-ss', trimStartSec.toFixed(4),
      '-t', trimmedDuration.toFixed(4),
      '-i', videoPath,
      '-loop', '1',
      '-i', templatePath,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      // 'superfast' preset -- measured meaningfully faster encode for this
      // filter chain (rotate+eq+overlay+noise are themselves
      // preset-independent CPU cost; only the x264 motion-estimation/
      // mode-decision work this setting controls gets cheaper). Bitrate
      // creeps up slightly to hold quality, which doesn't matter here --
      // Instagram re-encodes every upload anyway, so the intermediate
      // file's exact size is irrelevant, only wall-clock render time is.
      '-preset', 'superfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      outputPath,
    ], { timeout: 120000, maxBuffer: 50 * 1024 * 1024 });

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

module.exports = { composeReel18 };
