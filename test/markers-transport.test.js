/* Round-3 helpers from app.js: typed timecode parsing, marker normalization
   and navigation, the JKL shuttle rate ladder, and snap targets. Sliced out
   of the browser script by name like timeline-sandbox.js does. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const { ROOT } = require("./helpers");

const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker, a);
  assert.ok(a >= 0, `start marker not found: ${startMarker}`);
  assert.ok(b > a, `end marker not found after it: ${endMarker}`);
  return SRC.slice(a, b);
}

const PREVIEW_RATES = eval(/const PREVIEW_RATES = (\[[^\]]*\]);/.exec(SRC)[1]);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const lib = new Function("clamp", "PREVIEW_RATES", [
  slice("function parseTimecode(", "const getMedia = "),
  slice("function shuttleRate(", "const INCH_RATE"),
  "return { parseTimecode, normalizeMarker, normalizeMarkers, markerColor, adjacentMarker, shuttleRate, MARKER_COLORS };",
].join("\n"))(clamp, PREVIEW_RATES);

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: expected ${b}, got ${a}`);

/* ── Timecode ─────────────────────────────────────────────────────────── */

test("colon timecode reads right to left as frames, seconds, minutes, hours", () => {
  const p = (s) => lib.parseTimecode(s, 30);
  near(p("00:01:15"), 1.5, "mm:ss:ff");
  near(p("01:02:03"), 62.1, "mm:ss:ff");
  near(p("1:00:00:00"), 3600, "hh:mm:ss:ff");
  near(p("2:15"), 2.5, "ss:ff");
  near(p("0:45"), 1.5, "frames may overflow");
  near(p("01;02;03"), 62.1, "semicolons (drop-frame notation) read like colons");
});

test("bare digits pack Premiere-style from the right", () => {
  const p = (s) => lib.parseTimecode(s, 25);
  near(p("5"), 5 / 25, "one number = frames");
  near(p("1500"), 15, "1500 = 15 s 00 f");
  near(p("12345"), 83 + 45 / 25, "1 m 23 s 45 f");
  near(p("1000000"), 3600, "1 h");
});

test("a decimal point or trailing s means seconds", () => {
  near(lib.parseTimecode("12.5", 30), 12.5, "12.5");
  near(lib.parseTimecode("90s", 30), 90, "90s");
  near(lib.parseTimecode(".5s", 30), 0.5, ".5s");
});

test("+ and - offset from the base time and never go below zero", () => {
  near(lib.parseTimecode("+30", 30, 10), 11, "+30 frames");
  near(lib.parseTimecode("-1:00", 30, 10), 9, "-1 s");
  near(lib.parseTimecode("+2.5", 30, 1), 3.5, "+2.5 s");
  near(lib.parseTimecode("-100", 30, 0.5), 0, "clamped at 0");
});

test("junk is refused", () => {
  for (const s of ["", "  ", "abc", "1:2:3:4:5", "+", "1..2", "12x"])
    assert.equal(lib.parseTimecode(s, 30), null, JSON.stringify(s));
});

/* ── Markers ──────────────────────────────────────────────────────────── */

test("markers normalize to {t, label?, color?}, sorted, junk dropped", () => {
  const out = lib.normalizeMarkers([
    { t: 5.12345, label: "  drop  ", color: "red" },
    { t: 2, color: "gold" },
    { t: 3, color: "chartreuse", label: "" },
    { t: -1 }, null, { t: "x" }, { label: "no time" },
  ]);
  assert.deepEqual(out, [{ t: 2 }, { t: 3 }, { t: 5.123, label: "drop", color: "red" }]);
  assert.deepEqual(lib.normalizeMarkers(undefined), []);
  assert.equal(lib.normalizeMarker({ t: 1, label: "x".repeat(200) }).label.length, 80);
});

test("marker colour falls back to gold", () => {
  assert.equal(lib.markerColor({ t: 0 }), lib.MARKER_COLORS.gold);
  assert.equal(lib.markerColor({ t: 0, color: "blue" }), lib.MARKER_COLORS.blue);
});

test("next / previous marker skips the one under the playhead", () => {
  const mk = [{ t: 1 }, { t: 2 }, { t: 4 }];
  assert.equal(lib.adjacentMarker(mk, 2, 1).t, 4);
  assert.equal(lib.adjacentMarker(mk, 2, -1).t, 1);
  assert.equal(lib.adjacentMarker(mk, 1.5, 1).t, 2);
  assert.equal(lib.adjacentMarker(mk, 4, 1), null);
  assert.equal(lib.adjacentMarker(mk, 1, -1), null);
  assert.equal(lib.adjacentMarker([], 0, 1), null);
});

/* ── JKL shuttle ──────────────────────────────────────────────────────── */

test("L / J from a stop play at 1× in their direction", () => {
  assert.equal(lib.shuttleRate(1, 1, false), 1);
  assert.equal(lib.shuttleRate(2, -1, false), -1);
});

test("repeat taps climb the ladder and stop at the top", () => {
  let r = 1;
  const seen = [];
  for (let i = 0; i < 5; i++) { r = lib.shuttleRate(r, 1, true); seen.push(r); }
  assert.deepEqual(seen, [1.5, 2, 4, 4, 4]);
  r = -1;
  r = lib.shuttleRate(r, -1, true);
  assert.equal(r, -1.5, "reverse climbs too");
});

test("the opposite key turns around at 1×; a crawl rate restarts at 1×", () => {
  assert.equal(lib.shuttleRate(4, -1, true), -1);
  assert.equal(lib.shuttleRate(-2, 1, true), 1);
  assert.equal(lib.shuttleRate(0.25, 1, true), 1);
});

/* ── Snap targets ─────────────────────────────────────────────────────── */

function snapWorld(targets, { markers = [], clips = [], time = 0, fps = 30 } = {}) {
  const project = { markers, clips, inPoint: null, outPoint: null };
  const state = { snap: true, pps: 100, time };
  const env = {
    project, state, SNAP_PX: 8,
    getSetting: () => targets,
    DEFAULT_SETTINGS: { snapTargets: targets },
    projectFps: () => fps,
    clipEnd: (c) => c.start + c.duration,
    clipKeyframeLocalTimes: (c) => (c.kf || []),
    noteSnap: () => {},
  };
  const code = slice("function snapTargets(", "/* Vertical guide at the time a drag snapped to.");
  return new Function(...Object.keys(env), code + "\nreturn { snapInfo, snapTime };")(...Object.values(env));
}
const ALL_OFF = { clips: false, playhead: false, markers: false, inout: false, keyframes: false, frames: false };

test("only the enabled targets pull", () => {
  const opts = { markers: [{ t: 2 }], clips: [{ id: "a", start: 3, duration: 1 }], time: 5 };
  const off = snapWorld(ALL_OFF, opts);
  near(off.snapTime(2.03), 2.03, "nothing enabled");
  near(snapWorld({ ...ALL_OFF, markers: true }, opts).snapTime(2.03), 2, "marker");
  near(snapWorld({ ...ALL_OFF, clips: true }, opts).snapTime(2.97), 3, "clip edge");
  near(snapWorld({ ...ALL_OFF, playhead: true }, opts).snapTime(5.05), 5, "playhead");
  near(snapWorld({ ...ALL_OFF, markers: true }, opts).snapTime(2.03, null, { skipMarker: opts.markers[0] }), 2.03,
    "a dragged marker doesn't snap to itself");
});

test("keyframes snap at clip start + local time, but not the clip being dragged", () => {
  const clips = [{ id: "a", start: 1, duration: 3, kf: [0.5] }];
  const w = snapWorld({ ...ALL_OFF, keyframes: true }, { clips });
  near(w.snapTime(1.52), 1.5, "keyframe");
  near(w.snapTime(1.52, "a"), 1.52, "own keyframes ignored");
});

test("frame grid rounds only when no target is in reach, and doesn't count as a hit", () => {
  const w = snapWorld({ ...ALL_OFF, markers: true, frames: true }, { markers: [{ t: 2.01 }] });
  const miss = w.snapInfo(1.012);
  near(miss.t, 1, "rounded to 1 s (frame 30)");
  assert.equal(miss.hit, false);
  const hit = w.snapInfo(2.03);
  near(hit.t, 2.01, "marker beats the grid");
  assert.equal(hit.hit, true);
});

/* ── Marker navigation vs. the end of the timeline ────────────────────── */

function navWorld(markers, time, dur) {
  const state = { time };
  const toasts = [];
  const env = {
    project: { markers }, state, adjacentMarker: lib.adjacentMarker,
    projDur: () => dur, toast: (m) => toasts.push(m),
    isSourceMode: () => false, setMonitorMode: () => {},
    setTime: (t) => { state.time = Math.min(Math.max(t, 0), dur); },
    revealTime: () => {},
  };
  const code = slice("function goToMarker(", "/* Scroll the timeline so time t is on screen");
  const api = new Function(...Object.keys(env), code + "\nreturn { goToMarker, seekToMarker };")(...Object.values(env));
  return { ...api, state, toasts };
}

test("next marker skips markers past the last clip instead of sticking at the end", () => {
  const w = navWorld([{ t: 4 }, { t: 20 }], 4, 10);
  w.goToMarker(1);
  assert.equal(w.state.time, 4, "playhead stays put");
  assert.deepEqual(w.toasts, ["No marker after the playhead"]);
});

test("a marker past the end can't be jumped to, and says so", () => {
  const w = navWorld([{ t: 20 }], 3, 10);
  w.seekToMarker({ t: 20 });
  assert.equal(w.state.time, 3);
  assert.equal(w.toasts.length, 1);
  w.seekToMarker({ t: 7 });
  assert.equal(w.state.time, 7);
});
