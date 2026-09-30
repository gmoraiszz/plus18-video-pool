'use strict';

const archiver = require('archiver');

// Streams a zip of the given batch's rendered videos straight to the HTTP
// response -- nothing written to disk, nothing pre-built and cached. Each
// job's rendered video is fetched from its storage public URL server-side
// (archiver needs the actual bytes, so this fetches rather than proxying
// per-file).
async function streamBatchZip(res, jobs, { fetchImpl = fetch } = {}) {
  const renderedJobs = jobs.filter((j) => j.status === 'rendered' && j.renderedUrl);
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="reels-batch.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    // Headers are likely already sent by the time archiver can fail
    // mid-stream (it fails while writing entries, not up front) -- ending
    // the response is the best available error signal at that point.
    res.end();
    console.error('[reels18-zip] archive error:', err.message || err);
  });
  archive.pipe(res);

  const usedNames = new Set();
  for (let i = 0; i < renderedJobs.length; i++) {
    const job = renderedJobs[i];
    try {
      const upstream = await fetchImpl(job.renderedUrl);
      if (!upstream.ok) continue;
      const buffer = Buffer.from(await upstream.arrayBuffer());
      let name = `reel-${i + 1}.mp4`;
      let n = 2;
      while (usedNames.has(name)) {
        name = `reel-${i + 1}-${n}.mp4`;
        n++;
      }
      usedNames.add(name);
      archive.append(buffer, { name });
    } catch (err) {
      console.error(`[reels18-zip] skipping job ${job.id}:`, err.message || err);
    }
  }

  await archive.finalize();
}

module.exports = { streamBatchZip };
