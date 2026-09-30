'use strict';

const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

function getClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// CacheControl: no-store -- every caller re-renders onto the SAME key in
// place (rendered.mp4/png, source media, etc never get a versioned
// filename), so a CDN sitting in front of R2_PUBLIC_BASE_URL (Cloudflare's
// default for both r2.dev and custom domains) can keep serving a previous
// render's bytes at the edge indefinitely -- the frontend's own `?v=`
// cache-busting query param only defeats the BROWSER's cache, not an edge
// cache that keys purely on the path. Without this header, "edited and
// re-rendered but the old version is still showing" can recur even after a
// hard refresh, since the edge (not the browser) is the one serving stale.
async function uploadObject(key, buffer, contentType, { client } = {}) {
  const s3 = client || getClient();
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: buffer, ContentType: contentType, CacheControl: 'no-store, must-revalidate' }));
  return `${process.env.R2_PUBLIC_BASE_URL}/${key}`;
}

async function listObjects(prefix, { client } = {}) {
  const s3 = client || getClient();
  const result = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: prefix }));
  return (result.Contents || []).map((obj) => ({ key: obj.Key, uploadedAt: obj.LastModified.getTime() }));
}

async function deleteObject(key, { client } = {}) {
  const s3 = client || getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
}

// Pure — no I/O. Given items sorted by uploadedAt (any order, this sorts
// internally) and a cap, returns the oldest items beyond the cap, oldest
// first. Caller is responsible for actually deleting them.
function pickEvictions(items, cap) {
  const sorted = [...items].sort((a, b) => a.uploadedAt - b.uploadedAt);
  const overflow = sorted.length - cap;
  return overflow > 0 ? sorted.slice(0, overflow) : [];
}

module.exports = { uploadObject, listObjects, deleteObject, pickEvictions };
