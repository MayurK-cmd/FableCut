/* frame-cache.js — the /api/frame render cache stays bounded.

   Every distinct argument set mints its own JPEG, so without a cap the cache
   is a disk-fill primitive. These tests use fake files (no ffmpeg) and small
   limits, so they run everywhere including CI. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pruneCache, DEFAULT_MAX_FILES, DEFAULT_MAX_BYTES } = require("../frame-cache");

/* A fake cache entry: a .jpg with a .json sidecar, mtime pinned so "oldest"
   is deterministic regardless of how fast the test runs. */
function entry(dir, name, bytes, ageMs) {
  fs.writeFileSync(path.join(dir, name + ".jpg"), Buffer.alloc(bytes, 1));
  fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify({ times: [0] }));
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(path.join(dir, name + ".jpg"), when, when);
  fs.utimesSync(path.join(dir, name + ".json"), when, when);
}

test("pruning removes the oldest entries first, sidecars included", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  entry(dir, "a", 100, 5000);
  entry(dir, "b", 100, 4000);
  entry(dir, "c", 100, 3000);
  entry(dir, "d", 100, 2000);
  entry(dir, "e", 100, 1000);

  const r = pruneCache(dir, { maxFiles: 3, maxBytes: 1 << 30 });
  assert.equal(r.pruned, 2);
  assert.equal(r.files, 3);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort(),
    ["c.jpg", "d.jpg", "e.jpg"], "the two oldest entries must go");
  assert.ok(!fs.existsSync(path.join(dir, "a.json")) && !fs.existsSync(path.join(dir, "b.json")),
    "a pruned entry's sidecar must go with it");
  assert.ok(fs.existsSync(path.join(dir, "e.json")), "survivors keep their sidecars");
});

test("the byte cap bites even when the file count does not", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  entry(dir, "big-old", 900, 5000);
  entry(dir, "small-new", 100, 1000);

  const r = pruneCache(dir, { maxFiles: 100, maxBytes: 500 });
  assert.equal(r.pruned, 1);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")), ["small-new.jpg"]);
  assert.equal(r.bytes, 100);
});

test("a cache already under the limits is left alone", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  entry(dir, "only", 100, 1000);

  const r = pruneCache(dir, { maxFiles: 500, maxBytes: 1 << 30 });
  assert.deepEqual(r, { files: 1, bytes: 100, pruned: 0 });
});

test("a missing directory prunes to nothing instead of throwing", () => {
  assert.deepEqual(pruneCache(path.join(os.tmpdir(), "fc-cache-nope-xyz"), {}),
    { files: 0, bytes: 0, pruned: 0 });
});

test("production defaults are generous but finite", () => {
  assert.ok(DEFAULT_MAX_FILES > 100 && DEFAULT_MAX_FILES <= 5000, `max files: ${DEFAULT_MAX_FILES}`);
  assert.ok(DEFAULT_MAX_BYTES >= 32 * 1024 * 1024 && DEFAULT_MAX_BYTES <= 1024 * 1024 * 1024,
    `max bytes: ${DEFAULT_MAX_BYTES}`);
});
