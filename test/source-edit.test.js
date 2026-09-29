/* Unit tests for the 3-point-editing core in app.js: range punching
   (punchTrackRange), target-lane resolution (sourceEditTracks /
   placeSourceWindowClips), sync-locked ripple delete (rippleDeleteSelected)
   and the lock guard on Replace. The real functions run in the stubbed
   timeline from timeline-sandbox.js. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { world, clip } = require("./timeline-sandbox");

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

test("punching also trims linked partners on an untargeted track (sync lock)", () => {
  const v = clip("v", "V1", 2, 4, { linkGroup: "g" });
  const a = clip("a", "A2", 2, 4, { linkGroup: "g" });
  const w = world({ clips: [v, a], untargeted: ["A2"] });
  w.punchTrackRange("V1", 1, 4);
  assert.deepEqual([v.start, v.duration], [4, 2]);
  assert.deepEqual([a.start, a.duration], [4, 2], "the stem must stay in sync with its picture");
});

test("punching leaves a locked clip whole", () => {
  const c = clip("c1", "V1", 2, 4, { locked: true });
  const w = world({ clips: [c] });
  w.punchTrackRange("V1", 1, 4);
  assert.deepEqual([c.start, c.duration], [2, 4]);
});

/* ── Target lanes ────────────────────────────────────────────────────────── */

test("sourceEditTracks uses the default lanes when they are targeted", () => {
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

test("sourceEditTracks follows targeting and skips locked lanes", () => {
  const w = world({ untargeted: ["V1"], locked: ["A1"] });
  assert.deepEqual(w.sourceEditTracks({ kind: "video" }), ["V2", "A2", "A3"]);
  assert.deepEqual(w.sourceEditTracks({ kind: "audio" }), ["A2"]);
});

test("sourceEditTracks drops the picture when no video lane is a target", () => {
  const w = world({ untargeted: ["V1", "V2", "V3"] });
  assert.deepEqual(w.sourceEditTracks({ kind: "video" }), [null, "A1", "A2"]);
  assert.deepEqual(w.sourceEditTracks({ kind: "image" }), []);
});

test("an output-disabled lane still receives Source placement", () => {
  // The eye toggle only hides a lane from preview / export now.
  const w = world({ disabled: ["V1"] });
  assert.deepEqual(w.sourceEditTracks({ kind: "video" }), ["V1", "A1", "A2"]);
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

test("ripple delete shifts a linked A/V group once, partners on an untargeted track included", () => {
  // G1 = [3,5) on V1/A1/A2, G2 = [5,9) on the same lanes. A2 is untargeted.
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
  const w = world({ clips, untargeted: ["A2"], selected: ["v1"] });
  w.rippleDeleteSelected();
  assert.deepEqual(w.project.clips.map((c) => c.id).sort(), ["b1", "b2", "v2"]);
  for (const c of w.project.clips) assert.equal(c.start, 3, `${c.id} should start at 3`);
});

test("ripple delete leaves unlinked clips on an untargeted track where they are", () => {
  const clips = [
    clip("v1", "V1", 0, 2),
    clip("v2", "V1", 2, 2),
    clip("music", "A2", 4, 3),
  ];
  const w = world({ clips, untargeted: ["A2"], selected: ["v1"] });
  w.rippleDeleteSelected();
  assert.equal(w.byId("v2").start, 0, "same-track clip closes the gap");
  assert.equal(w.byId("music").start, 4, "an untargeted lane is not rippled");
});

/* ── Replace guard ───────────────────────────────────────────────────────── */

test("Replace refuses to retarget a locked timeline clip", () => {
  const c = clip("c1", "V1", 0, 4, { locked: true });
  const w = world({ clips: [c] });
  w.state.source.mediaId = "m1";
  w.state.source.fromClipId = "c1";
  w.setWindow(() => ({ m: { id: "m1", kind: "video" }, inn: 0, duration: 2 }));
  w.replaceSourceAtPlayhead();
  assert.equal(w.calls.applyWindow, 0, "the clip must not be edited");
  assert.equal(w.calls.undo, 0, "no undo step for a refused edit");
  assert.match(w.calls.toast[0] || "", /Locked/);
});

test("Replace retargets the loaded clip even on an output-disabled track", () => {
  const c = clip("c1", "V1", 0, 4);
  const w = world({ clips: [c], disabled: ["V1"] });
  w.state.source.mediaId = "m1";
  w.state.source.fromClipId = "c1";
  w.setWindow(() => ({ m: { id: "m1", kind: "video" }, inn: 0, duration: 2 }));
  w.replaceSourceAtPlayhead();
  assert.equal(w.calls.applyWindow, 1);
});
