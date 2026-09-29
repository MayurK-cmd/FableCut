/* Export colour tags: the scale filter stamps each frame's colour properties,
   and frame properties win over the -color_* output flags. Every tag the
   profile's `color` asks for must therefore ride on the filter chain too, or
   ffprobe reads primaries / transfer as "unknown". */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync, execFileSync } = require("node:child_process");
const { ROOT } = require("./helpers");

const ep = require(path.join(ROOT, "encode-profiles.js"));

const vfOf = (args) => args[args.indexOf("-vf") + 1];
const has = (bin) => spawnSync(bin, ["-version"]).status === 0;

test("the colour filter stamps primaries and transfer from the profile", () => {
  const color = { matrix: "bt709", primaries: "bt2020", trc: "smpte2084", range: "tv" };
  const vf = vfOf(ep.buildExportArgs({ args: [], extension: ".mp4", color }, { fps: 30, outPath: "x.mp4" }));
  assert.match(vf, /setparams=color_primaries=bt2020:color_trc=smpte2084/);
  // scale's own out_primaries / out_transfer need FFmpeg 7.1+ — keep them out
  assert.doesNotMatch(vf, /out_primaries|out_transfer/);
});

test("a profile -vf is chained after the colour conversion", () => {
  const vf = vfOf(ep.buildExportArgs({ args: ["-vf", "hflip"], extension: ".mp4" }, { fps: 30, outPath: "x.mp4" }));
  assert.match(vf, /setparams=[^,]+,hflip$/);
});

test("exported H.264 is tagged BT.709 end to end", (t) => {
  if (!has("ffmpeg") || !has("ffprobe")) { t.skip("ffmpeg / ffprobe not installed"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-color-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // JPEG frames, the way Fast export pipes them in
  const jpeg = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=0.2",
    "-f", "image2pipe", "-c:v", "mjpeg", "-"], { maxBuffer: 1 << 24 });
  const out = path.join(dir, "tags.mp4");
  const profile = {
    extension: ".mp4",
    args: ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
    color: { ...ep.DEFAULT_COLOR },
  };
  const r = spawnSync("ffmpeg", ep.buildExportArgs(profile, { fps: 30, outPath: out }), { input: jpeg });
  assert.equal(r.status, 0, r.stderr.toString().slice(-400));
  const tags = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=color_space,color_primaries,color_transfer,color_range", "-of", "json", out]).toString()).streams[0];
  assert.deepEqual(tags, {
    color_range: ep.DEFAULT_COLOR.range, color_space: ep.DEFAULT_COLOR.matrix,
    color_transfer: ep.DEFAULT_COLOR.trc, color_primaries: ep.DEFAULT_COLOR.primaries,
  });
});
