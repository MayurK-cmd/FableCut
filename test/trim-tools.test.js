/* Ripple, roll, slip and slide trims plus range Lift / Extract — the trim-tool
   ops in app.js, run against the stubbed timeline from timeline-sandbox.js.
   Every op takes a requested delta and returns the delta it applied (clamped
   to source media, MIN_DUR and free room) or a refusal string. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { world, clip, MIN_DUR } = require("./timeline-sandbox");

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: expected ${b}, got ${a}`);

/* Three back-to-back shots on V1, each with a linked stem on A1:
   A [0,3) in 0 · B [3,6) in 10 · C [6,9) in 20. */
function reel(extra = {}) {
  const shot = (tag, start, inn) => [
    clip(tag, "V1", start, 3, { in: inn, linkGroup: "g" + tag }),
    clip(tag.toLowerCase(), "A1", start, 3, { in: inn, linkGroup: "g" + tag }),
  ];
  return world({ clips: [...shot("A", 0, 0), ...shot("B", 3, 10), ...shot("C", 6, 20)], ...extra });
}

/* ── Ripple ──────────────────────────────────────────────────────────────── */

test("ripple on a tail shortens the clip and pulls everything after it left", () => {
  const w = reel();
  near(w.rippleTrim(w.byId("B"), "out", -1), -1, "applied");
  near(w.byId("B").duration, 2, "B shortened");
  near(w.byId("b").duration, 2, "its stem takes the same trim");
  for (const id of ["C", "c"]) near(w.byId(id).start, 5, `${id} pulled left`);
  near(w.byId("A").start, 0, "A untouched");
});

test("ripple on a tail lengthens into more source and pushes the rest right", () => {
  const w = reel();
  w.rippleTrim(w.byId("B"), "out", 2);
  near(w.byId("B").duration, 5, "B lengthened");
  near(w.byId("C").start, 8, "C pushed right");
});

test("ripple on a head keeps the clip's start and trims its source In", () => {
  const w = reel();
  w.rippleTrim(w.byId("B"), "in", 1);
  near(w.byId("B").start, 3, "start stays glued to A");
  near(w.byId("B").in, 11, "source In advances");
  near(w.byId("B").duration, 2, "one second shorter");
  near(w.byId("C").start, 5, "C pulls left by the trimmed amount");
});

test("ripple stops at the start of the source media", () => {
  const w = reel();
  near(w.rippleTrim(w.byId("A"), "in", -5), 0, "A starts at source 0, nothing to reveal");
  near(w.rippleTrim(w.byId("B"), "in", -15), -10, "B can reveal its 10 s of pre-roll");
  near(w.byId("B").in, 0, "B now starts at source 0");
  near(w.byId("C").start, 16, "C moved right by the revealed 10 s");
});

test("ripple stops at the end of the source media", () => {
  const w = reel({ media: [{ id: "m1", kind: "video", duration: 24 }] });
  near(w.rippleTrim(w.byId("C"), "out", 10), 1, "C has 1 s of source left");
});

test("ripple never makes a clip shorter than MIN_DUR", () => {
  const w = reel();
  w.rippleTrim(w.byId("B"), "out", -10);
  near(w.byId("B").duration, MIN_DUR, "clamped at MIN_DUR");
});

test("ripple leaves a locked track in place", () => {
  const w = reel({ locked: ["A3"] });
  w.project.clips.push(clip("bed", "A3", 4, 10));
  w.rippleTrim(w.byId("B"), "out", -1);
  near(w.byId("bed").start, 4, "the locked music bed stays");
  near(w.byId("C").start, 5, "the picture still ripples");
});

test("ripple on a locked clip refuses", () => {
  const w = reel();
  w.byId("B").locked = true;
  assert.match(w.rippleTrim(w.byId("B"), "out", -1), /Locked/);
  near(w.byId("B").duration, 3, "unchanged");
});

test("ripple can't pull a lane into a clip that stays behind", () => {
  // V2 holds an unlinked title that straddles the B|C cut: it doesn't move,
  // and a title after it on V2 may only close up to it.
  const w = reel();
  w.project.clips.push(clip("t1", "V2", 5, 2, { kind: "text", mediaId: null }));
  w.project.clips.push(clip("t2", "V2", 7.5, 1, { kind: "text", mediaId: null }));
  const d = w.rippleTrim(w.byId("B"), "out", -2);
  near(d, -0.5, "only 0.5 s of room between t1's end and t2");
  near(w.byId("t2").start, 7, "t2 closed up to t1");
});

/* ── Roll ────────────────────────────────────────────────────────────────── */

test("roll moves the cut: one side lengthens, the other shortens, nothing else moves", () => {
  const w = reel();
  near(w.rollEdit(w.byId("A"), "out", 0.5), 0.5, "applied");
  near(w.byId("A").duration, 3.5, "A lengthened");
  near(w.byId("B").start, 3.5, "B's head moved");
  near(w.byId("B").in, 10.5, "B's source In moved with it");
  near(w.byId("B").duration, 2.5, "B shortened");
  near(w.byId("b").start, 3.5, "B's stem follows");
  near(w.byId("C").start, 6, "C untouched");
});

test("roll from the other side of the cut does the same thing", () => {
  const w = reel();
  w.rollEdit(w.byId("B"), "in", -1);
  near(w.byId("A").duration, 2, "A shortened");
  near(w.byId("B").start, 2, "B extended backwards");
  near(w.byId("B").in, 9, "revealing earlier source");
});

test("roll is limited by source on both sides and by MIN_DUR", () => {
  const w = reel();
  near(w.rollEdit(w.byId("A"), "out", -10), -(3 - MIN_DUR), "A can shrink to MIN_DUR");
  const w2 = reel();
  near(w2.rollEdit(w2.byId("B"), "in", -20), -3 + MIN_DUR, "A can't go below MIN_DUR either way");
  const w3 = world({ clips: [clip("A", "V1", 0, 3), clip("B", "V1", 3, 3, { in: 1 })] });
  near(w3.rollEdit(w3.byId("B"), "in", -5), -1, "B has only 1 s of pre-roll");
});

test("roll with nothing on the other side trims into the free room only", () => {
  const w = world({ clips: [clip("A", "V1", 0, 3), clip("B", "V1", 5, 3)] });
  near(w.rollEdit(w.byId("A"), "out", 5), 2, "up to B's start");
});

test("roll refuses when either side is locked", () => {
  const w = reel();
  w.byId("B").locked = true;
  assert.match(w.rollEdit(w.byId("A"), "out", 1), /Locked/);
});

/* ── Slip ────────────────────────────────────────────────────────────────── */

test("slip changes the source In only", () => {
  const w = reel();
  near(w.slipClip(w.byId("B"), -2), -2, "applied");
  near(w.byId("B").in, 12, "dragging left shows later source");
  near(w.byId("b").in, 12, "the stem slips with it");
  near(w.byId("B").start, 3, "position stays");
  near(w.byId("B").duration, 3, "length stays");
});

test("slip is clamped to the source media", () => {
  const w = reel({ media: [{ id: "m1", kind: "video", duration: 15 }] });
  near(w.slipClip(w.byId("B"), 100), 10, "can't go before source 0");
  near(w.byId("B").in, 0, "at source 0");
  const w2 = reel({ media: [{ id: "m1", kind: "video", duration: 15 }] });
  near(w2.slipClip(w2.byId("B"), -100), -2, "can't run past the end (15 − 3 − 10)");
});

test("slip refuses stills and titles", () => {
  const w = world({ clips: [clip("t", "V2", 0, 3, { kind: "text", mediaId: null })] });
  assert.match(w.slipClip(w.byId("t"), 1), /video or audio/);
});

/* ── Slide ───────────────────────────────────────────────────────────────── */

test("slide moves the clip; its neighbours trim, the sequence length stays", () => {
  const w = reel();
  near(w.slideClip(w.byId("B"), 1), 1, "applied");
  near(w.byId("B").start, 4, "B moved");
  near(w.byId("B").in, 10, "B shows the same source");
  near(w.byId("A").duration, 4, "A's tail grew");
  near(w.byId("C").start, 7, "C's head moved");
  near(w.byId("C").in, 21, "C's source In moved with it");
  near(w.byId("C").duration, 2, "C shortened");
  near(w.byId("C").start + w.byId("C").duration, 9, "the sequence still ends at 9");
  near(w.byId("b").start, 4, "B's stem slides too");
});

test("slide is limited by the neighbours' length and source", () => {
  const w = reel();
  near(w.slideClip(w.byId("B"), 10), 3 - MIN_DUR, "C can shrink to MIN_DUR");
  const w2 = world({ clips: [clip("A", "V1", 0, 3), clip("B", "V1", 3, 3), clip("C", "V1", 6, 3, { in: 0.5 })] });
  near(w2.slideClip(w2.byId("B"), -10), -0.5, "C has only 0.5 s of pre-roll to give");
});

test("slide into free room when there is no neighbour", () => {
  const w = world({ clips: [clip("A", "V1", 0, 2), clip("B", "V1", 4, 2)] });
  near(w.slideClip(w.byId("B"), -5), -2, "only up to A's end");
});

test("slide refuses when a neighbour is locked", () => {
  const w = reel();
  w.byId("C").locked = true;
  assert.match(w.slideClip(w.byId("B"), 1), /Locked/);
});

/* ── Lift / Extract ──────────────────────────────────────────────────────── */

test("lift removes IN→OUT on targeted tracks and leaves the gap", () => {
  const w = reel({ inPoint: 2, outPoint: 4 });
  w.liftExtract(false);
  near(w.byId("A").duration, 2, "A cut at IN");
  assert.equal(w.project.clips.filter((c) => c.track === "V1").length, 3, "A-head, B-tail, C");
  const bTail = w.project.clips.find((c) => c.track === "V1" && c.start === 4);
  assert.ok(bTail, "B's tail starts at OUT");
  near(bTail.in, 11, "keeping its source");
  near(w.byId("C").start, 6, "no ripple");
  assert.equal(w.project.inPoint, null, "IN / OUT clear afterwards");
  near(w.state.time, 2, "playhead parks at the old IN");
});

test("extract removes IN→OUT and closes the gap", () => {
  const w = reel({ inPoint: 2, outPoint: 4 });
  w.liftExtract(true);
  const v1 = w.project.clips.filter((c) => c.track === "V1").sort((a, b) => a.start - b.start);
  assert.deepEqual(v1.map((c) => [c.start, c.duration]), [[0, 2], [2, 2], [4, 3]]);
  near(w.byId("c").start, 4, "the stems close up too");
});

test("extract skips untargeted tracks except for linked partners, and locked clips", () => {
  const w = reel({ inPoint: 2, outPoint: 4, untargeted: ["A2"], locked: ["A3"] });
  w.project.clips.push(clip("fx", "A2", 5, 1), clip("bed", "A3", 0, 9));
  w.liftExtract(true);
  near(w.byId("fx").start, 5, "an untargeted lane stays");
  near(w.byId("bed").duration, 9, "a locked lane is never cut");
  near(w.byId("c").start, 4, "linked stems on A1 follow their picture");
});

test("lift and extract need both IN and OUT", () => {
  const w = reel({ inPoint: 2 });
  w.liftExtract(false);
  assert.match(w.calls.toast[0], /Set IN and OUT/);
  assert.equal(w.calls.undo, 0);
});

/* ── Linked partners at a different speed ────────────────────────────────── */

test("every tool respects the tightest linked partner's source", () => {
  // Links are inferred from timing alone, so a partner can run at another
  // speed. B's picture runs at 1×, its linked stem at 2×; the source is 20 s.
  const media = [{ id: "m1", kind: "video", duration: 20 }];
  const reel2x = () => world({ media, clips: [
    clip("A", "V1", 0, 3, { in: 0, linkGroup: "gA" }),
    clip("B", "V1", 3, 3, { in: 4, linkGroup: "gB" }),
    clip("b", "A1", 3, 3, { in: 4, linkGroup: "gB", props: { speed: 2 } }),
    clip("C", "V1", 6, 3, { in: 10, linkGroup: "gC" }),
  ] });
  const srcEnd = (c) => c.in + c.duration * (c.props.speed || 1);

  let w = reel2x();
  near(w.rippleTrim(w.byId("B"), "in", -10), -2, "the 2× stem has only 2 s of pre-roll");
  near(w.byId("b").in, 0, "stem stops at source 0, not below");

  w = reel2x();
  near(w.rippleTrim(w.byId("B"), "out", 20), 5, "the 2× stem runs out of source first");
  near(srcEnd(w.byId("b")), 20, "stem ends exactly at the source end");

  w = reel2x();
  near(w.slipClip(w.byId("B"), -100), -10, "slip stops where the stem's 6 s span hits the end");
  near(srcEnd(w.byId("b")), 20, "stem ends exactly at the source end");

  w = reel2x();
  near(w.rollEdit(w.byId("A"), "out", -5), -2, "rolling the cut left is limited by the stem's pre-roll");
  near(w.byId("b").in, 0);

  w = world({ media, clips: [
    clip("X", "V1", 0, 3), clip("Y", "V1", 3, 3),
    clip("Z", "V1", 6, 3, { in: 2, linkGroup: "gZ" }),
    clip("z", "A1", 6, 3, { in: 2, linkGroup: "gZ", props: { speed: 2 } }),
  ] });
  near(w.slideClip(w.byId("Y"), -5), -1, "sliding left is limited by the 2× stem after it");
  near(w.byId("z").in, 0);
});
