/* Shipped assets and their documented contracts.

   The SVG rules below are not style preferences — each one maps to a way the
   compositor actually fails. Animated SVGs are frozen at time t by injecting
   `*{animation-play-state:paused!important; animation-delay:calc(var(--d,0s) - t)!important}`
   after the opening <svg> tag and rasterising the result through a data: URI
   (see svgUrlAt / loadSvgMedia in app.js). Anything that defeats that
   injection, or that a data: URI cannot load, renders wrongly in preview and
   export alike. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { ROOT } = require("./helpers");

const SVG_DIR = path.join(ROOT, "library", "svg");
const svgFiles = fs.readdirSync(SVG_DIR).filter((f) => f.endsWith(".svg"));

test("there are library SVGs to validate", () => {
  // Guards the suite itself: a glob that silently matches nothing would make
  // every check below vacuously pass.
  assert.ok(svgFiles.length > 0, "no SVGs found — the checks below would be meaningless");
});

test("every library SVG is well-formed and self-contained", () => {
  for (const f of svgFiles) {
    const s = fs.readFileSync(path.join(SVG_DIR, f), "utf8").trim();
    assert.match(s, /^<svg[\s>]|^<\?xml/i, `${f}: does not start with an <svg> root`);
    assert.match(s, /<\/svg>$/, `${f}: truncated — does not end with </svg>`);

    // parseSvgSize() falls back to 800x600 when it cannot find a size, which
    // silently rescales the clip on the canvas.
    assert.match(s, /<svg[^>]*\s(width|viewBox)=/i, `${f}: needs a width/height or viewBox`);

    // Rasterisation happens from a data: URI, which cannot fetch anything.
    assert.doesNotMatch(s, /(?:href|src)\s*=\s*["']https?:/i,
      `${f}: external reference will not load when rasterised from a data: URI`);
  }
});

test("animated library SVGs stay drivable by the compositor clock", () => {
  for (const f of svgFiles) {
    const s = fs.readFileSync(path.join(SVG_DIR, f), "utf8");

    // SMIL is wall-clock driven and ignores the injected CSS entirely, so it
    // would animate in preview and freeze (or drift) in export.
    assert.doesNotMatch(s, /<animate(?:Transform|Motion)?[\s>]/i,
      `${f}: uses SMIL <animate>; CSS @keyframes are required`);

    // The engine's override is !important at specificity (0,0,0). An author
    // !important on a class selector outranks it and pins the animation.
    assert.doesNotMatch(s, /animation-delay\s*:[^;}]*!important/i,
      `${f}: !important animation-delay overrides the compositor's time driver`);
    assert.doesNotMatch(s, /animation-play-state\s*:[^;}]*!important/i,
      `${f}: !important animation-play-state defeats the compositor's pause`);

    // A hardcoded delay is silently discarded by the override, so the author's
    // intended stagger is lost. `--d` is the supported way to express it.
    const delays = s.match(/animation-delay\s*:[^;}]*/gi) || [];
    for (const d of delays) {
      assert.match(d, /var\(\s*--d/,
        `${f}: hardcoded "${d.trim()}" is discarded at render time; set --d on the element instead`);
    }

    // A file that declares --d but has no keyframes is staging a stagger that
    // will never run.
    if (/--d\s*:/.test(s)) {
      assert.match(s, /@keyframes/,
        `${f}: sets --d for a stagger but defines no @keyframes`);
    }
  }
});

test("the documented starter SVGs still ship", () => {
  // CLAUDE.md points authors at these by name as the worked examples.
  for (const named of ["sparkles.svg", "lower-third.svg", "confetti-burst.svg", "underline-swoosh.svg"]) {
    assert.ok(svgFiles.includes(named), `CLAUDE.md cites library/svg/${named} but it is missing`);
  }
});

/* Code points a WOFF2 file maps to a glyph: the table directory gives cmap's
   place in the Brotli stream, then its format 4 / 12 subtables are walked. */
function woff2CodePoints(buf) {
  assert.equal(buf.toString("latin1", 0, 4), "wOF2", "not a WOFF2 file");
  let o = 48, at = 0, cmap = null;
  const base128 = () => { let x = 0, b; do { b = buf[o++]; x = x * 128 + (b & 127); } while (b & 128); return x; };
  for (let i = 0, n = buf.readUInt16BE(12); i < n; i++) {
    const flags = buf[o++], known = flags & 63;
    if (known === 63) o += 4;
    const orig = base128(), xform = flags >> 6;
    const len = (known === 10 || known === 11 ? xform !== 3 : xform !== 0) ? base128() : orig;
    if (known === 0) cmap = { at, len: orig };
    at += len;
  }
  const c = zlib.brotliDecompressSync(buf.subarray(o, o + buf.readUInt32BE(20)))
    .subarray(cmap.at, cmap.at + cmap.len);
  const cps = new Set();
  for (let i = 0, n = c.readUInt16BE(2); i < n; i++) {
    const s = c.readUInt32BE(8 + i * 8), fmt = c.readUInt16BE(s);
    if (fmt === 4) {
      const segs = c.readUInt16BE(s + 6) / 2, ends = s + 14, starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2, ranges = deltas + segs * 2;
      for (let k = 0; k < segs; k++) {
        const start = c.readUInt16BE(starts + k * 2), end = c.readUInt16BE(ends + k * 2);
        const delta = c.readInt16BE(deltas + k * 2), ro = c.readUInt16BE(ranges + k * 2);
        for (let cp = start; cp <= end && cp < 0xffff; cp++) {
          const g = ro ? c.readUInt16BE(ranges + k * 2 + ro + (cp - start) * 2) : (cp + delta) & 0xffff;
          if (g) cps.add(cp);
        }
      }
    } else if (fmt === 12) {
      for (let k = 0, groups = c.readUInt32BE(s + 12); k < groups; k++) {
        const g = s + 16 + k * 12;
        for (let cp = c.readUInt32BE(g), end = c.readUInt32BE(g + 4); cp <= end; cp++) cps.add(cp);
      }
    }
  }
  return cps;
}

test("library fonts can draw Latin text", () => {
  // Every title style names one of these. A font without these glyphs doesn't
  // fail to load: the title quietly draws in the fallback face instead, which
  // is how 1.0-1.9.0 shipped (each file was a Cyrillic/Vietnamese/... slice).
  const dir = path.join(ROOT, "library", "fonts");
  const fonts = fs.readdirSync(dir).filter((f) => f.endsWith(".woff2"));
  assert.ok(fonts.length > 0, "no library fonts found");
  const need = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789é";
  for (const f of fonts) {
    const cps = woff2CodePoints(fs.readFileSync(path.join(dir, f)));
    const missing = [...need].filter((ch) => !cps.has(ch.codePointAt(0)));
    assert.equal(missing.join(""), "", `${f} has no glyphs for these (not the Google Fonts "latin" subset?)`);
  }
});

test("shipped JSON files parse", () => {
  const files = ["package.json", "manifest.json", "glama.json", "project.json"];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;   // optional files stay optional
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(p, "utf8")), `${f} is not valid JSON`);
  }
});

test("package.json declares no runtime dependencies", () => {
  // The project's headline constraint: `node server.js` must work on a bare
  // clone with no npm install.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {},
    "FableCut must stay zero-runtime-dependency");
  assert.ok(pkg.scripts?.test, "package.json needs a test script so CI can run the suite");
});

test("inspector sliders advertise and handle Ctrl/Cmd-click reset", () => {
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.match(app, /els\.inspector\.addEventListener\("pointerdown"/,
    "slider reset is delegated on the inspector, not bound per range");
  assert.match(app, /Ctrl\/Cmd-click: reset to default/);
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /inspector label or slider/);
});
