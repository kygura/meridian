// Builds the map's label glyphs (MapLibre SDF .pbf ranges) from the app's own fonts,
// so city names on the globe use the same type as the rest of Meridian.
//
// Output: public/fonts/<stack>/<start>-<end>.pbf, served at /fonts/... by Vite and Vercel.
// Only ranges that city names in data/worldcities.csv need are written (plus Basic Latin).
// Each stack fills the gaps in its main font from a Noto fallback (Vietnamese letters with
// stacked diacritics, e.g. "Đồng Hới", are missing from Instrument Serif).
//
// One-off tool; its dependencies aren't part of the app:
//   mkdir -p /tmp/glyph-tools && cd /tmp/glyph-tools && npm i fontnik@0.7.7 @mapbox/glyph-pbf-composite@0.0.3
//   GLYPH_TOOLS=/tmp/glyph-tools FONTS_DIR=/path/to/ttfs node scripts/build-map-glyphs.mjs
//
// FONTS_DIR holds the .ttf files named below, from github.com/google/fonts (SIL OFL 1.1).

import { createRequire } from "module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const root = process.cwd();
const toolsDir = process.env.GLYPH_TOOLS;
const fontsDir = process.env.FONTS_DIR;
if (!toolsDir || !fontsDir) {
  console.error("Set GLYPH_TOOLS (with fontnik and @mapbox/glyph-pbf-composite installed) and FONTS_DIR.");
  process.exit(1);
}
const req = createRequire(join(resolve(toolsDir), "noop.js"));
const fontnik = req("fontnik");
const { combine } = req("@mapbox/glyph-pbf-composite");

/** Stack name (what "text-font" asks for) → main font, then fallback. */
const STACKS = {
  "meridian-serif": ["InstrumentSerif-Regular.ttf", "NotoSerif[wdth,wght].ttf"],
};

// Ranges the labels can need: every character in a city name, plus Basic Latin and Latin-1.
const names = readFileSync(join(root, "data/worldcities.csv"), "utf8")
  .split("\n")
  .slice(1)
  .map((l) => l.split(",")[0].replace(/"/g, ""));
const starts = new Set([0]);
for (const n of names) for (const ch of n) starts.add(Math.floor(ch.codePointAt(0) / 256) * 256);

const range = (font, start) =>
  new Promise((ok, fail) => fontnik.range({ font, start, end: start + 255 }, (e, pbf) => (e ? fail(e) : ok(pbf))));

const outRoot = join(root, "public/fonts");
for (const [stack, files] of Object.entries(STACKS)) {
  const fonts = files.map((f) => readFileSync(join(fontsDir, f)));
  const dir = join(outRoot, stack);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const start of [...starts].sort((a, b) => a - b)) {
    // combine() keeps the first font's glyph when both have one, so the fallback only fills gaps.
    const pbfs = await Promise.all(fonts.map((f) => range(f, start)));
    writeFileSync(join(dir, `${start}-${start + 255}.pbf`), combine(pbfs, stack));
  }
  console.log(`${stack}: ${starts.size} ranges`);
}
