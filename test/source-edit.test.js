/* Unit tests for the 3-point-editing core in app.js: range punching
   (punchTrackRange), target-lane resolution (sourceEditTracks /
   placeSourceWindowClips), sync-locked ripple delete (rippleDeleteSelected)
   and the disabled-track guard on Replace.

   app.js is a browser script with no exports, so — like keyframes.test.js —
   the real functions are sliced out of the source by name markers and run
   against a small stubbed world (project, TRACKS, disabled tracks). */
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

const MIN_DUR = +/const MIN_DUR = ([\d.]+);/.exec(SRC)[1];

const CODE = [
  slice("function audioTrackIds(", "function nextTrackId("),
  slice("function defaultTrackFor(", "function syncLinkedTiming("),
  slice("function sourceEditTracks(", "/** Place Source window clips"),
  slice("function placeSourceWindowClips(", "/** Open a hole on one track"),
  slice("function punchTrackRange(", "/** Premiere-style Insert"),
  slice("function replaceSourceAtPlayhead(", "/** Apply Source In→Out to a timeline clip"),
  slice("function rippleDeleteSelected(", "/* Gap under playhead"),
  slice("function splitClipAt(", "/* After splitting a set of clips"),
  slice("function shiftKF(", "/* ═════════════════ SVG CLIPS"),
].join("\n");

const DEFAULT_TRACKS = ["V3", "V2", "V1", "A1", "A2", "A3"];

/* A fresh world per test. `trackIds` lists the live lanes; `disabled` the
   switched-off ones. Clips are plain objects, as in project.json. */
function world({ trackIds = DEFAULT_TRACKS, disabled = [], clips = [], selected = [] } = {}) {
  const project = { clips };
  const TRACKS = trackIds.map((id) => ({ id, kind: id[0] === "A" ? "audio" : "video" }));
  const state = {
    disabledTracks: new Set(disabled), time: 0, playing: false, dirtyTimeline: false,
    source: { mediaId: null, fromClipId: null, playing: false },
  };
  const calls = { toast: [], applyWindow: 0, undo: 0 };
  let n = 0;
  const env = {
    project, TRACKS, state, MIN_DUR,
    DEFAULT_PROPS: { volume: 1 },
    uid: () => "u" + (++n),
    clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    clipEnd: (c) => c.start + c.duration,
    // No speed ramps in these fixtures: linear media time.
    mediaTimeAt: (c, t) => c.in + Math.min(c.duration, Math.max(0, t - c.start)) * (c.props?.speed || 1),
    getClip: (id) => project.clips.find((c) => c.id === id) || null,
    isTrackEnabled: (id) => !state.disabledTracks.has(id),
    selectedClips: () => project.clips.filter((c) => selected.includes(c.id)),
    releaseClipEl() {}, scheduleSave() {}, renderInspector() {}, setSelection() {},
    ensureWave() {}, reconcileAudioChannels() {}, pause() {}, pauseSource() {},
    relinkClips() {}, pruneSelection() {}, selectClip() {}, ensurePlayheadVisible() {},
    toastSourceWindowMissing() {},
    defaultPanForChannel: (ch) => (ch === 0 ? -1 : ch === 1 ? 1 : 0),
    pushUndo: () => { calls.undo++; },
    toast: (msg) => { calls.toast.push(msg); },
    applySourceWindowToClip: () => { calls.applyWindow++; },
    sourceInsertWindow: () => null, // overridden per test
  };
  const names = Object.keys(env);
  const fns = new Function(...names, `${CODE}\nreturn {
    sourceEditTracks, placeSourceWindowClips, punchTrackRange,
    replaceSourceAtPlayhead, rippleDeleteSelected,
    setWindow: (fn) => { sourceInsertWindow = fn; },
  };`)(...names.map((k) => env[k]));
  return { ...fns, project, state, calls };
}

const clip = (id, track, start, duration, extra = {}) => ({
  id, track, start, duration, in: 0, kind: track[0] === "A" ? "audio" : "video",
  mediaId: "m1", props: {}, ...extra,
});

/* ── Keyframe rebase on Insert / Replace ─────────────────────────────────── */

test("punching a tail overhang rebases keyframes onto the new clip start", () => {
  // Clip [2,6) with an opacity key at local 3 (timeline 5). Punch [1,4):
  // the clip now starts at 4, so that key must land at local 1.
  const c = clip("c1", "V1", 2, 4, { keyframes: { opacity: [{ t: 0, v: 0 }, { t: 3, v: 1 }] } });
  const w = world({ clips: [c] });
  w.punchTrackRange("V1", 1, 4);
  assert.equal(c.start, 4);
  assert.equal(c.duration, 2);
  assert.equal(c.in, 2, "media In advances by the trimmed head");
  assert.deepEqual(c.keyframes, { opacity: [{ t: 1, v: 1 }] },
    "the key at timeline 5 stays at timeline 5; the one before the cut is dropped");
});

test("a refused split that keeps the tail rebases keyframes too", () => {
  // Punch [0.03, 3) over [0, 6): the split at 0.03 is inside MIN_DUR, so
  // punchTrackRange keeps the tail and moves its start to 3.
  const c = clip("c1", "V1", 0, 6, { keyframes: { scale: [{ t: 4, v: 2 }] } });
  const w = world({ clips: [c] });
  w.punchTrackRange("V1", 0.03, 3);
  assert.equal(c.start, 3);
  assert.equal(c.duration, 3);
  assert.deepEqual(c.keyframes, { scale: [{ t: 1, v: 2 }] }, "timeline 4 → local 1");
});

test("punching the middle of a clip keeps head and tail keyframes in place", () => {
  const c = clip("c1", "V1", 0, 10, { keyframes: { opacity: [{ t: 1, v: 0.5 }, { t: 8, v: 1 }] } });
  const w = world({ clips: [c] });
  w.punchTrackRange("V1", 3, 5);
  const pieces = w.project.clips.sort((a, b) => a.start - b.start);
  assert.equal(pieces.length, 2);
  assert.deepEqual([pieces[0].start, pieces[0].duration], [0, 3]);
  assert.deepEqual([pieces[1].start, pieces[1].duration], [5, 5]);
  assert.deepEqual(pieces[0].keyframes, { opacity: [{ t: 1, v: 0.5 }] });
  assert.deepEqual(pieces[1].keyframes, { opacity: [{ t: 3, v: 1 }] }, "timeline 8 → local 3");
});

test("punching also trims linked partners on a disabled track (sync lock)", () => {
  const v = clip("v", "V1", 2, 4, { linkGroup: "g" });
  const a = clip("a", "A2", 2, 4, { linkGroup: "g" });
  const w = world({ clips: [v, a], disabled: ["A2"] });
  w.punchTrackRange("V1", 1, 4);
  assert.deepEqual([v.start, v.duration], [4, 2]);
  assert.deepEqual([a.start, a.duration], [4, 2], "the stem must stay in sync with its picture");
});

/* ── Target lanes that don't exist ───────────────────────────────────────── */

test("sourceEditTracks uses the default lanes when they exist", () => {
  const w = world();
  assert.deepEqual(w.sourceEditTracks({ kind: "video" }), ["V1", "A1", "A2"]);
  assert.deepEqual(w.sourceEditTracks({ kind: "audio" }), ["A1"]);
  assert.deepEqual(w.sourceEditTracks({ kind: "svg" }), ["V3"]);
});

test("sourceEditTracks falls back to live lanes when V1 / A1 were removed", () => {
  const w = world({ trackIds: ["V3", "V2", "A2", "A3"] });
  assert.deepEqual(w.sourceEditTracks({ kind: "video" }), ["V2", "A2", "A3"]);
  assert.deepEqual(w.sourceEditTracks({ kind: "audio" }), ["A2"]);
  assert.deepEqual(w.sourceEditTracks({ kind: "image" }), ["V2"]);
});

test("sourceEditTracks lands an SVG on the lowest video lane when V3 is gone", () => {
  const w = world({ trackIds: ["V2", "V1", "A1"] });
  assert.deepEqual(w.sourceEditTracks({ kind: "svg" }), ["V1"]);
});

test("sourceEditTracks returns only the stems that exist", () => {
  const w = world({ trackIds: ["V1", "A3"] });
  assert.deepEqual(w.sourceEditTracks({ kind: "video" }), ["V1", "A3"]);
});

test("sourceEditTracks returns an empty list when no compatible lane exists", () => {
  const w = world({ trackIds: ["V1"] });
  assert.deepEqual(w.sourceEditTracks({ kind: "audio" }), []);
});

test("placed Source clips never land on a lane that doesn't exist", () => {
  const w = world({ trackIds: ["V2", "A2", "A3"] });
  w.placeSourceWindowClips({ id: "m1", kind: "video", name: "shot.mp4" }, 1, 2, 5);
  const lanes = w.project.clips.map((c) => c.track).sort();
  assert.deepEqual(lanes, ["A2", "A3", "V2"]);
  const groups = new Set(w.project.clips.map((c) => c.linkGroup));
  assert.equal(groups.size, 1, "picture and stems share one link group");
  for (const c of w.project.clips) assert.deepEqual([c.start, c.in, c.duration], [5, 1, 2]);
});

/* ── Ripple delete ───────────────────────────────────────────────────────── */

test("ripple delete shifts a linked A/V group once, partners on a disabled track included", () => {
  // G1 = [3,5) on V1/A1/A2, G2 = [5,9) on the same lanes. A2 is disabled.
  // Deleting G1 must pull every G2 member back by exactly 2 (a per-track
  // pass would shift it twice, to 1).
  const clips = [
    clip("v1", "V1", 3, 2, { linkGroup: "g1" }),
    clip("a1", "A1", 3, 2, { linkGroup: "g1" }),
    clip("a2", "A2", 3, 2, { linkGroup: "g1" }),
    clip("v2", "V1", 5, 4, { linkGroup: "g2" }),
    clip("b1", "A1", 5, 4, { linkGroup: "g2" }),
    clip("b2", "A2", 5, 4, { linkGroup: "g2" }),
  ];
  const w = world({ clips, disabled: ["A2"], selected: ["v1"] });
  w.rippleDeleteSelected();
  assert.deepEqual(w.project.clips.map((c) => c.id).sort(), ["b1", "b2", "v2"]);
  for (const c of w.project.clips) assert.equal(c.start, 3, `${c.id} should start at 3`);
});

test("ripple delete leaves unlinked clips on a disabled track where they are", () => {
  const clips = [
    clip("v1", "V1", 0, 2),
    clip("v2", "V1", 2, 2),
    clip("music", "A2", 4, 3),
  ];
  const w = world({ clips, disabled: ["A2"], selected: ["v1"] });
  w.rippleDeleteSelected();
  const byId = Object.fromEntries(w.project.clips.map((c) => [c.id, c]));
  assert.equal(byId.v2.start, 0, "same-track clip closes the gap");
  assert.equal(byId.music.start, 4, "a disabled lane is not rippled");
});

/* ── Replace guard ───────────────────────────────────────────────────────── */

test("Replace refuses to retarget a timeline clip on a disabled track", () => {
  const c = clip("c1", "V1", 0, 4);
  const w = world({ clips: [c], disabled: ["V1"] });
  w.state.source.mediaId = "m1";
  w.state.source.fromClipId = "c1";
  w.setWindow(() => ({ m: { id: "m1", kind: "video" }, inn: 0, duration: 2 }));
  w.replaceSourceAtPlayhead();
  assert.equal(w.calls.applyWindow, 0, "the clip must not be edited");
  assert.equal(w.calls.undo, 0, "no undo step for a refused edit");
  assert.match(w.calls.toast[0] || "", /disabled track/);
});

test("Replace retargets the loaded timeline clip when its track is enabled", () => {
  const c = clip("c1", "V1", 0, 4);
  const w = world({ clips: [c] });
  w.state.source.mediaId = "m1";
  w.state.source.fromClipId = "c1";
  w.setWindow(() => ({ m: { id: "m1", kind: "video" }, inn: 0, duration: 2 }));
  w.replaceSourceAtPlayhead();
  assert.equal(w.calls.applyWindow, 1);
});
