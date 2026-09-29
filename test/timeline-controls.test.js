/* Track targeting, track / clip locks, clip enable and AV unlink — the editing
   rules in app.js, run against the stubbed timeline from timeline-sandbox.js.
   The MCP side of locks lives in mcp-tools.test.js. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { world, clip } = require("./timeline-sandbox");

/* A linked picture + stereo stems from one file. */
const avGroup = (tag, start, duration, lg = "g" + tag, extra = {}) => [
  clip("v" + tag, "V1", start, duration, { linkGroup: lg, ...extra }),
  clip("l" + tag, "A1", start, duration, { linkGroup: lg, props: { audioChannel: 0 } }),
  clip("r" + tag, "A2", start, duration, { linkGroup: lg, props: { audioChannel: 1 } }),
];

/* ── Locks during ripples ────────────────────────────────────────────────── */

test("ripple delete leaves a locked track where it is while the rest closes up", () => {
  const clips = [...avGroup(1, 0, 2), ...avGroup(2, 2, 3), clip("music", "A3", 1, 6)];
  const w = world({ clips, locked: ["A3"], selected: ["v1"] });
  w.rippleDeleteSelected();
  for (const id of ["v2", "l2", "r2"]) assert.equal(w.byId(id).start, 0, `${id} closes the gap`);
  assert.equal(w.byId("music").start, 1, "the locked music bed must not move");
});

test("a locked member pins its whole linked group during a ripple", () => {
  // Lock only the right stem of group 2: picture and left stem must stay too.
  const clips = [...avGroup(1, 0, 2), ...avGroup(2, 2, 3)];
  clips.find((c) => c.id === "r2").locked = true;
  const w = world({ clips, selected: ["v1"] });
  w.rippleDeleteSelected();
  for (const id of ["v2", "l2", "r2"]) assert.equal(w.byId(id).start, 2, `${id} stays in sync`);
});

test("insert ripples the targeted tracks but not a locked one", () => {
  const clips = [...avGroup(1, 0, 4), clip("music", "A3", 0, 8)];
  const w = world({ clips, locked: ["A3"], time: 2 });
  w.state.source.mediaId = "m1";
  w.setWindow(() => ({ m: { id: "m1", kind: "video", name: "ins.mp4" }, inn: 0, duration: 3 }));
  w.insertSourceAtPlayhead();
  const tails = w.project.clips.filter((c) => c.start === 5).map((c) => c.track).sort();
  assert.deepEqual(tails, ["A1", "A2", "V1"], "the split tails ride right by the insert length");
  assert.deepEqual([w.byId("music").start, w.byId("music").duration], [0, 8], "locked music is untouched");
});

test("insert never splits a locked clip", () => {
  const clips = [clip("hold", "V1", 0, 6, { locked: true })];
  const w = world({ clips, time: 3 });
  w.state.source.mediaId = "m1";
  w.setWindow(() => ({ m: { id: "m1", kind: "image", name: "still.png" }, inn: 0, duration: 1 }));
  w.insertSourceAtPlayhead();
  assert.deepEqual([w.byId("hold").start, w.byId("hold").duration], [0, 6]);
});

test("close gap moves the targeted tracks and leaves locked clips alone", () => {
  const clips = [
    clip("a", "V1", 0, 2), clip("b", "V1", 4, 2),
    clip("x", "A1", 0, 2), clip("y", "A1", 4, 2, { locked: true }),
  ];
  const w = world({ clips, time: 3 });
  w.closeGapAtPlayhead();
  assert.equal(w.byId("b").start, 2, "the gap closes on V1");
  assert.equal(w.byId("y").start, 4, "the locked clip stays put");
});

test("close gap ignores a locked track even when it has no gap", () => {
  const clips = [clip("a", "V1", 0, 2), clip("b", "V1", 4, 2), clip("bed", "A3", 0, 10)];
  const w = world({ clips, locked: ["A3"], time: 3 });
  w.closeGapAtPlayhead();
  assert.equal(w.byId("b").start, 2);
  assert.equal(w.byId("bed").start, 0);
});

/* ── Locks on direct edits ───────────────────────────────────────────────── */

test("delete refuses a locked clip and reports it", () => {
  const w = world({ clips: [clip("c", "V1", 0, 2, { locked: true })], selected: ["c"] });
  w.deleteSelected();
  assert.equal(w.project.clips.length, 1);
  assert.equal(w.calls.undo, 0, "a refused delete leaves no undo step");
  assert.match(w.calls.toast[0], /Locked/);
});

test("delete removes the unlocked part of a mixed selection", () => {
  const clips = [clip("a", "V1", 0, 2), clip("b", "V1", 2, 2, { locked: true })];
  const w = world({ clips, selected: ["a", "b"] });
  w.deleteSelected();
  assert.deepEqual(w.project.clips.map((c) => c.id), ["b"]);
  assert.match(w.calls.toast[0], /left untouched/);
});

test("split skips a locked clip and splits the rest", () => {
  const clips = [clip("a", "V1", 0, 4), clip("b", "V2", 0, 4, { locked: true })];
  const w = world({ clips, time: 2 });
  w.splitAtPlayhead();
  assert.equal(w.project.clips.filter((c) => c.track === "V1").length, 2);
  assert.equal(w.project.clips.filter((c) => c.track === "V2").length, 1);
});

/* ── Targeting ───────────────────────────────────────────────────────────── */

test("split with no selection touches targeted tracks only", () => {
  const clips = [clip("a", "V1", 0, 4), clip("b", "V2", 0, 4)];
  const w = world({ clips, untargeted: ["V2"], time: 2 });
  w.splitAtPlayhead();
  assert.equal(w.project.clips.filter((c) => c.track === "V1").length, 2);
  assert.equal(w.project.clips.filter((c) => c.track === "V2").length, 1);
});

test("a selected clip splits even when its track is untargeted", () => {
  const w = world({ clips: [clip("b", "V2", 0, 4)], untargeted: ["V2"], selected: ["b"], time: 2 });
  w.splitAtPlayhead();
  assert.equal(w.project.clips.length, 2);
});

test("an output-disabled track is still edited — the eye toggle is output-only", () => {
  const clips = [clip("a", "V1", 0, 4)];
  const w = world({ clips, disabled: ["V1"], time: 2 });
  w.splitAtPlayhead();
  assert.equal(w.project.clips.length, 2);
  assert.equal(w.isEditTarget("V1"), true);
});

test("a locked track is never an edit target, even when targeted", () => {
  const w = world({ locked: ["V1"] });
  assert.equal(w.isEditTarget("V1"), false);
  assert.equal(w.isEditTarget("V2"), true);
});

/* ── Clip enable ─────────────────────────────────────────────────────────── */

test("disabling a clip disables its whole linked group, and toggles back", () => {
  const w = world({ clips: avGroup(1, 0, 2), selected: ["v1"] });
  w.toggleClipsDisabled();
  for (const id of ["v1", "l1", "r1"]) {
    assert.equal(w.byId(id).disabled, true);
    assert.equal(w.clipRenders(w.byId(id)), false, `${id} must not render`);
  }
  w.toggleClipsDisabled();
  for (const id of ["v1", "l1", "r1"]) assert.equal("disabled" in w.byId(id), false, "enable removes the flag");
});

test("a clip on a disabled track does not render; an enabled clip on an enabled track does", () => {
  const w = world({ clips: [clip("a", "V1", 0, 2), clip("b", "V2", 0, 2)], disabled: ["V2"] });
  assert.equal(w.clipRenders(w.byId("a")), true);
  assert.equal(w.clipRenders(w.byId("b")), false);
});

test("a locked clip cannot be disabled", () => {
  const w = world({ clips: [clip("a", "V1", 0, 2, { locked: true })], selected: ["a"] });
  w.toggleClipsDisabled();
  assert.equal(w.byId("a").disabled, undefined);
});

test("locking a clip locks its group; unlocking says when the track still holds it", () => {
  const w = world({ clips: avGroup(1, 0, 2), locked: ["A2"], selected: ["v1"] });
  w.toggleClipsLocked();
  for (const id of ["v1", "l1", "r1"]) assert.equal(w.byId(id).locked, true);
  w.toggleClipsLocked();
  for (const id of ["v1", "l1", "r1"]) assert.equal("locked" in w.byId(id), false);
  assert.match(w.calls.toast.at(-1), /track is still locked/);
  assert.equal(w.isGroupLocked(w.byId("v1")), true, "the locked A2 lane still pins the group");
});

/* ── Unlink / link ───────────────────────────────────────────────────────── */

test("unlink survives the reload-time relink, and link restores the group", () => {
  const w = world({ clips: avGroup(1, 0, 2), selected: ["v1"] });
  w.toggleLinkSelected();
  for (const id of ["v1", "l1", "r1"]) {
    assert.equal(w.byId(id).linkGroup, undefined);
    assert.equal(w.byId(id).unlinked, true);
  }
  w.relinkClips(); // what every project load runs
  for (const id of ["v1", "l1", "r1"]) assert.equal(w.byId(id).linkGroup, undefined, "unlink must persist");

  w.state.selIds = new Set(["v1", "l1", "r1"]);
  w.toggleLinkSelected();
  const lg = w.byId("v1").linkGroup;
  assert.ok(lg);
  for (const id of ["l1", "r1"]) assert.equal(w.byId(id).linkGroup, lg);
  for (const id of ["v1", "l1", "r1"]) assert.equal("unlinked" in w.byId(id), false);
  w.relinkClips();
  assert.equal(new Set(["v1", "l1", "r1"].map((id) => w.byId(id).linkGroup)).size, 1, "the relinked group survives a reload");
});

test("after unlink, deleting the picture leaves its audio behind", () => {
  const clips = [...avGroup(1, 0, 2), ...avGroup(2, 2, 3)];
  const w = world({ clips, selected: ["v1"] });
  w.toggleLinkSelected(); // unlink group 1
  w.state.selIds = new Set(["v1"]);
  w.rippleDeleteSelected(); // only the picture goes now
  assert.equal(w.byId("v1"), undefined);
  assert.equal(w.byId("l1").start, 0, "the unlinked audio stays");
  // Group 2 is still linked, so its stems ride with its picture (sync lock).
  for (const id of ["v2", "l2", "r2"]) assert.equal(w.byId(id).start, 0, `${id} moves by 2`);
});

test("link refuses clips that don't line up or come from different files", () => {
  const w = world();
  const v = clip("v", "V1", 0, 2), a = clip("a", "A1", 0, 2);
  assert.equal(w.linkRefusal([v, a]), null);
  assert.match(w.linkRefusal([v, { ...a, start: 0.5 }]), /Line the clips up/);
  assert.match(w.linkRefusal([v, { ...a, mediaId: "m2" }]), /same media/);
  assert.match(w.linkRefusal([v]), /Select a video clip and its audio/);
  assert.match(w.linkRefusal([v, { ...v, id: "v2" }]), /exactly one video/);
  assert.match(w.linkRefusal([v, { ...a, kind: "text" }]), /Only video and audio/);
});

test("a stale unlink does not block linking", () => {
  const clips = [clip("v", "V1", 0, 2, { unlinked: true }), clip("a", "A1", 0, 2, { unlinked: true })];
  const w = world({ clips, selected: ["v", "a"] });
  w.toggleLinkSelected();
  assert.ok(w.byId("v").linkGroup && w.byId("v").linkGroup === w.byId("a").linkGroup);
});
