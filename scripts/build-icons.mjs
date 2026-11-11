// Draws the app icons (ADR 0016): the Meridian mark from src/ui/icons.tsx (IconLogo: a
// globe ring, its equator and prime meridian, and one curved meridian) in paper on the
// accent orange. Writes public/icons/*.png and icon.svg.
//
//   node scripts/build-icons.mjs
//
// No renderer needed: the mark is a ring, two lines and one curve, rasterised here by
// distance to the stroke with one pixel of anti-aliasing.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { PNG } from "pngjs";

const ACCENT = [0xc2, 0x68, 0x0c]; // --accent (light theme)
const PAPER = [0xfb, 0xf5, 0xe6]; // --on-accent
const STROKE = 1.5; // in the mark's 24-unit box, as the UI icon draws it

// The mark, in its 24×24 box.
const RING = { cx: 12, cy: 12, r: 8.5 };
const SEGMENTS = [
  [12, 3.5, 12, 20.5],
  [3.5, 12, 20.5, 12],
];
// "M12 3.5c3 2.6 4.5 5.4 4.5 8.5S15 17.9 12 20.5" as two cubic Béziers.
const CURVES = [
  [12, 3.5, 15, 6.1, 16.5, 8.9, 16.5, 12],
  [16.5, 12, 16.5, 15.1, 15, 17.9, 12, 20.5],
];

function flatten([x0, y0, x1, y1, x2, y2, x3, y3], steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ]);
  }
  return pts;
}

const LINES = [...SEGMENTS];
for (const c of CURVES) {
  const pts = flatten(c);
  for (let i = 1; i < pts.length; i++) LINES.push([...pts[i - 1], ...pts[i]]);
}

function distToSegment(px, py, [ax, ay, bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point (mark units) to the nearest stroke centre line. */
function distToMark(x, y) {
  let d = Math.abs(Math.hypot(x - RING.cx, y - RING.cy) - RING.r);
  for (const s of LINES) d = Math.min(d, distToSegment(x, y, s));
  return d;
}

/** `fill` is how much of the icon's width the 24-unit box takes (smaller for maskable: the safe zone is the inner 80%). */
function draw(size, fill, { mask = false } = {}) {
  const png = new PNG({ width: size, height: size });
  const scale = (size * fill) / 24; // pixels per mark unit
  const offset = (size - 24 * scale) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = distToMark((x + 0.5 - offset) / scale, (y + 0.5 - offset) / scale) * scale;
      const a = Math.max(0, Math.min(1, (STROKE * scale) / 2 - d + 0.5));
      const i = (y * size + x) * 4;
      // mask: white mark on transparent, for the Android notification badge (only alpha is used).
      for (let c = 0; c < 3; c++) png.data[i + c] = mask ? 255 : Math.round(ACCENT[c] + (PAPER[c] - ACCENT[c]) * a);
      png.data[i + 3] = mask ? Math.round(a * 255) : 255;
    }
  }
  return PNG.sync.write(png);
}

const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const svg = (fill) => {
  const s = fill;
  const o = (24 - 24 * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" fill="${hex(ACCENT)}"/>
  <g transform="translate(${o} ${o}) scale(${s})" fill="none" stroke="${hex(PAPER)}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M12 3.5v17M3.5 12h17"/>
    <path d="M12 3.5c3 2.6 4.5 5.4 4.5 8.5S15 17.9 12 20.5"/>
  </g>
</svg>
`;
};

const out = join(process.cwd(), "public/icons");
mkdirSync(out, { recursive: true });
const files = {
  "icon-192.png": draw(192, 0.78),
  "icon-512.png": draw(512, 0.78),
  "icon-maskable-512.png": draw(512, 0.56),
  "apple-touch-icon.png": draw(180, 0.74),
  "badge-96.png": draw(96, 0.92, { mask: true }),
};
for (const [name, buf] of Object.entries(files)) writeFileSync(join(out, name), buf);
writeFileSync(join(out, "icon.svg"), svg(0.78));
console.log(`[build-icons] wrote ${Object.keys(files).length + 1} files to public/icons`);
