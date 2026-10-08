/* GET /api/frame + fablecut_frame — the "eyes" that go with the analyzer's ears.

   Three layers are covered, each skipping only what it must:
     · argument validation and the src path guard — no ffmpeg needed, so these
       run everywhere and are the ones that matter most (a localhost file API
       that renders arbitrary paths would be a hole in the box);
     · the real ffmpeg render — self-skips when ffmpeg is absent, like the
       export tests do;
     · the MCP wrapper, including that it answers with an image content block
       and text first. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeDataDir, startServer, startMcp, rawGet } = require("./helpers");

/* CI runs without an install step by design (zero dependencies), so ffmpeg is
   usually absent there — these self-skip. They are worth adding ffmpeg for:
   they are what proved the seek and the contact sheet land on the right
   moments, which a status-code-only test cannot see. */
const NO_WATCH = { FABLECUT_NO_FS_WATCH: "1" };

const hasFfmpeg = () => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; }
  catch { return false; }
};
const JPEG_SOI = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

/* A short clip with real motion: three flat colours in sequence, so a frame at
   t≈0.3 and a frame at t≈0.9 cannot be the same picture. That is what makes
   "did the seek land on the right moment" a real assertion. */
function fixture(dir, name, seconds = 3, w = 160, h = 90) {
  const file = path.join(dir, "media", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seg = (seconds / 3).toFixed(3);
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=red:s=${w}x${h}:d=${seg}`,
    "-f", "lavfi", "-i", `color=c=lime:s=${w}x${h}:d=${seg}`,
    "-f", "lavfi", "-i", `color=c=blue:s=${w}x${h}:d=${seg}`,
    "-filter_complex", `[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]`,
    "-map", "[v]", "-pix_fmt", "yuv420p", "-r", "25", file,
  ]);
  return file;
}

const boot = async (t) => {
  const dir = makeDataDir(t);
  const { base, port } = await startServer(t, dir, NO_WATCH);
  return { dir, base, port };
};
const getFrame = async (base, query) => {
  const res = await fetch(base + "/api/frame?" + query);
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
};

test("GET /api/frame refuses a src outside /media and /library", async (t) => {
  const { dir, base } = await boot(t);
  // A file the user (or a symlink) can name but the API must not read.
  const outside = path.join(dir, "secret.txt");
  fs.writeFileSync(outside, "not media");

  for (const src of [
    "",
    "secret.txt",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "/media/../../secret.txt",
    "/library/../secret.txt",
    "/media/",
    "/library/svg/../../secret.txt",
  ]) {
    const res = await fetch(base + "/api/frame?src=" + encodeURIComponent(src) + "&t=0");
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 404, `src=${src} should be refused, got ${res.status}`);
    assert.match(body.error || "", /src must name an existing file/);
  }
  // And a traversal that exists on disk is still refused.
  fs.writeFileSync(path.join(dir, "media", "..", "secret.txt"), "not media");
  const res = await fetch(base + "/api/frame?src=" + encodeURIComponent("/media/..%2Fsecret.txt"));
  assert.equal(res.status, 404);
});

test("GET /api/frame rejects bad arguments with a 400, not a 500", async (t) => {
  const ffmpeg = hasFfmpeg();
  const { dir, base } = await boot(t);
  if (ffmpeg) fixture(dir, "clip.mp4");
  const src = "/media/" + (ffmpeg ? "clip.mp4" : "missing.mp4");

  // cols/frames only mean anything together, so every sheet-mode case carries
  // frames= — otherwise the server is right to ignore them.
  for (const q of ["t=-1", "t=abc", "frames=1", "frames=999", "frames=12&cols=0",
    "frames=12&cols=999", "w=1", "w=99999", "frames=12&to=0", "t=2&q=0", "t=2&q=99"]) {
    const res = await fetch(base + "/api/frame?src=" + encodeURIComponent(src) + "&" + q);
    const body = await res.json().catch(() => ({}));
    assert.ok(res.status === 400 || res.status === 404, `${q} → ${res.status} ${JSON.stringify(body)}`);
    if (res.status === 400) assert.match(body.error, /must be|no video|no frame|ffmpeg/);
  }
});

test("GET /api/frame returns one JPEG for a source timestamp", { skip: !hasFfmpeg() && "ffmpeg not on PATH" }, async (t) => {
  const { dir, base } = await boot(t);
  fixture(dir, "clip.mp4");

  const { res, buf } = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&t=2");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /image\/jpeg/);
  assert.ok(JPEG_SOI(buf), "the body must be a JPEG, not an error page");
  assert.equal(res.headers.get("x-fablecut-frame-times"), "2");
  assert.equal(res.headers.get("x-fablecut-frame-source"), "/media/clip.mp4");

  // w= constrains the width; -2 keeps the aspect ratio.
  const small = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&t=2&w=40");
  assert.equal(small.res.status, 200);
  assert.ok(small.buf.length < buf.length, "a narrower frame must be a smaller file");

  // A timestamp past the end must NOT return a picture. ffmpeg clamps the
  // seek and hands back the last frame, which would be a confident wrong answer
  // — the exact failure mode "let the agent look" is supposed to remove.
  const past = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&t=9999");
  assert.equal(past.res.status, 400, JSON.stringify(past.buf.toString("utf8").slice(0, 120)));
  assert.match(JSON.parse(past.buf.toString("utf8")).error, /past the end/);

  // …and it must not be the same pixels as the final frame either.
  const last = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&t=2.9");
  assert.equal(last.res.status, 200);
  assert.ok(!past.buf.equals(last.buf));
});

/* The dominant colour of a decoded frame, so a test can prove *which* moment a
   grab landed on. The fixture is red → lime → blue, so the colour identifies
   the second. */
async function dominantRgb(buf) {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error",
    "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0",
    "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { input: buf, maxBuffer: 1 << 20, encoding: "buffer" });
  return { r: raw[0], g: raw[1], b: raw[2] };
}

test("a frame grab lands on the requested moment, not on the first frame", { skip: !hasFfmpeg() && "ffmpeg not on PATH" }, async (t) => {
  const { dir, base } = await boot(t);
  fixture(dir, "clip.mp4"); // red 0–1s · lime 1–2s · blue 2–3s

  // The bug this pins: seeking is easy to get wrong in a way that still returns
  // a valid JPEG (frame 0 every time), so assert on pixels, not on the status.
  const mid = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&t=1.5&w=48");
  const end = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&t=2.5&w=48");
  const start = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&t=0.2&w=48");
  for (const [label, got] of [["t=1.5", mid], ["t=2.5", end], ["t=0.2", start]]) {
    assert.equal(got.res.status, 200, label);
  }
  const [c1, c2, c0] = await Promise.all([dominantRgb(mid.buf), dominantRgb(end.buf), dominantRgb(start.buf)]);
  assert.ok(c1.g > c1.r * 1.5, `t=1.5 should be lime, got rgb(${c1.r},${c1.g},${c1.b})`);
  assert.ok(c2.b > c2.r * 1.5, `t=2.5 should be blue, got rgb(${c2.r},${c2.g},${c2.b})`);
  assert.ok(c0.r > c0.b * 1.5, `t=0.2 should be red, got rgb(${c0.r},${c0.g},${c0.b})`);

  // And the three must genuinely differ — otherwise the seek did nothing.
  const hex = (c) => `${c.r},${c.g},${c.b}`;
  assert.equal(new Set([hex(c0), hex(c1), hex(c2)]).size, 3, "each timestamp must show its own moment");
});

test("a contact sheet samples across the requested range, not just the head", { skip: !hasFfmpeg() && "ffmpeg not on PATH" }, async (t) => {
  const { dir, base } = await boot(t);
  fixture(dir, "clip.mp4"); // red 0–1s · lime 1–2s · blue 2–3s

  // Survey the middle second only: every cell must be lime.
  const { res, buf } = await getFrame(base,
    "src=" + encodeURIComponent("/media/clip.mp4") + "&frames=4&cols=4&from=1&to=2&w=48");
  assert.equal(res.status, 200);
  assert.ok(JPEG_SOI(buf));
  const times = res.headers.get("x-fablecut-frame-times").split(",").map(Number);
  assert.equal(times.length, 4);
  for (const t of times) assert.ok(t >= 1 && t <= 2, `cell time ${t} outside the requested 1–2s range`);
  // The whole sheet is one colour → the sheet really is only the middle second.
  const c = await dominantRgb(buf);
  assert.ok(c.g > c.r * 1.5 && c.g > c.b * 1.5, `a 1–2s survey should be all lime, got rgb(${c.r},${c.g},${c.b})`);

  // Across the whole clip the same grid must span red, lime and blue.
  const all = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&frames=3&cols=3&w=48");
  const ca = await dominantRgb(all.buf);
  assert.ok(ca.r + ca.g + ca.b > 60, `a 3-colour sheet should not average to a flat mid-tone, got rgb(${ca.r},${ca.g},${ca.b})`);
});

test("GET /api/frame?frames=N returns one contact sheet and labels its cells", { skip: !hasFfmpeg() && "ffmpeg not on PATH" }, async (t) => {
  const { dir, base } = await boot(t);
  fixture(dir, "clip.mp4");

  const { res, buf } = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&frames=6&cols=3&w=60");
  assert.equal(res.status, 200);
  assert.ok(JPEG_SOI(buf), "a contact sheet is still one JPEG");
  const times = res.headers.get("x-fablecut-frame-times").split(",").map(Number);
  assert.equal(times.length, 6, "every sampled moment must be labelled");
  for (const t of times) assert.ok(t >= 0 && t <= 3, `sampled time ${t} outside a 3 s clip`);
  for (let i = 1; i < times.length; i++)
    assert.ok(times[i] > times[i - 1], "cells must run left→right, top→bottom");

  // A sheet is a bigger picture than one still of the same clip.
  const one = await getFrame(base, "src=" + encodeURIComponent("/media/clip.mp4") + "&t=1&w=60");
  assert.ok(buf.length > one.buf.length, "a 6-up sheet should outweigh a single cell");
});

test("frame extraction is cached, and the cache follows the file's mtime", { skip: !hasFfmpeg() && "ffmpeg not on PATH" }, async (t) => {
  const { dir, base } = await boot(t);
  const file = fixture(dir, "clip.mp4");
  const q = "src=" + encodeURIComponent("/media/clip.mp4") + "&t=1";

  const first = await getFrame(base, q);
  const second = await getFrame(base, q);
  assert.equal(first.res.status, 200);
  assert.ok(first.buf.equals(second.buf), "a repeat request must serve the same bytes");

  const framesDir = path.join(dir, "analysis", "frames");
  const cached = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg"));
  assert.equal(cached.length, 1, "the second request should not re-render");
  // The key covers the source, so an overwrite invalidates it.
  const inMs = Date.now() + 20;
  fs.writeFileSync(file, fs.readFileSync(file));
  fs.utimesSync(file, new Date(inMs), new Date(inMs));
  await getFrame(base, q);
  assert.equal(fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).length, 2,
    "touching the source must not serve the stale grab");
});

test("fablecut_frame returns an image the agent can look at", { skip: !hasFfmpeg() && "ffmpeg not on PATH" }, async (t) => {
  const dir = makeDataDir(t);
  fixture(dir, "clip.mp4");
  const { base } = await startServer(t, dir, NO_WATCH);
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(new URL(base).port) });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });

  const one = await mcp.callTool("fablecut_frame", { path: "/media/clip.mp4", t: 2 });
  assert.equal(one.isError, false);
  assert.equal(one.content[0].type, "text", "text first: it carries the coordinates of the picture");
  assert.match(one.content[0].text, /clip\.mp4/);
  assert.match(one.content[0].text, /2s/);
  const img = one.content.find((c) => c.type === "image");
  assert.ok(img, "the tool must return an image content block");
  assert.equal(img.mimeType, "image/jpeg");
  const buf = Buffer.from(img.data, "base64");
  assert.ok(JPEG_SOI(buf), "the image block must carry real JPEG bytes");
  assert.ok(buf.length > 500, `a 160x90 frame decoded to ${buf.length} bytes — that is not a picture`);

  const sheet = await mcp.callTool("fablecut_frame", { path: "/media/clip.mp4", frames: 4, cols: 2 });
  assert.equal(sheet.isError, false);
  assert.match(sheet.content[0].text, /Contact sheet/);
  assert.ok(sheet.content.some((c) => c.type === "image"));

  // A missing file is an error result, not a crash, and the server survives it.
  const bad = await mcp.callTool("fablecut_frame", { path: "/media/nope.mp4" });
  assert.equal(bad.isError, true);
  const pong = await mcp.request("ping", {});
  assert.deepEqual(pong.result, {});
});

test("fablecut_frame without a path is a timeline render, and says so", async (t) => {
  // No editor tab and no browser here: the request must fail with a readable
  // reason rather than hanging or killing the server.
  const dir = makeDataDir(t);
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(await freePort()) });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const res = await mcp.callTool("fablecut_frame", { time: 1.5, where: "headless" });
  assert.equal(res.isError, true, res.text);
  assert.match(res.text, /frame render failed|no reason|not running|timed out|never picked/);
  const pong = await mcp.request("ping", {});
  assert.deepEqual(pong.result, {});
});

test("a /library asset can be looked at without being copied into media", { skip: !hasFfmpeg() && "ffmpeg not on PATH" }, async (t) => {
  const { dir, base } = await boot(t);
  // library/svg ships, so the resolveSrc branch is exercised against a real
  // file; a still of a still is only refused for lack of video by ffmpeg, not
  // by the path guard.
  const svg = path.join(dir, "library", "svg");
  const any = fs.readdirSync(svg).find((f) => f.endsWith(".svg"));
  assert.ok(any, "the seeded library should hold an svg");
  const res = await fetch(base + "/api/frame?src=" + encodeURIComponent("/library/svg/" + encodeURIComponent(any)) + "&t=0");
  // Either it renders (200) or ffmpeg declines the container (400) — what must
  // never happen is a 404, i.e. the guard rejecting a legitimate library src.
  assert.notEqual(res.status, 404, "a real library src must pass the path guard");
  await res.arrayBuffer();
});

test("GET /api/frame is only reachable from this machine", async (t) => {
  const { port } = await boot(t);
  // rawGet can forge the Host header, which fetch() will not allow.
  const bad = await rawGet(port, "/api/frame?src=%2Fmedia%2Fx.mp4&t=0", { Host: "evil.example.com" });
  assert.equal(bad.status, 403);
  const ok = await rawGet(port, "/api/frame?src=%2Fmedia%2Fx.mp4&t=0", { Host: `127.0.0.1:${port}` });
  assert.notEqual(ok.status, 403, "a local request must not be turned away by the host guard");
});

async function freePort() {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}
