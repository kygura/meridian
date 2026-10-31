// Screen-space dashing for map paths. Pure: no React, no map.
//
// deck.gl's PathLayer has no dash support without @deck.gl/extensions, so dashed
// routes are cut into short pieces here. Lengths are in web-mercator pixels at a given
// zoom (512px world at zoom 0, the MapLibre convention), so dashes keep a steady
// on-screen length when re-cut at each whole zoom level.

import type { LngLat } from "./geo";

const WORLD = 512;
const MAX_LAT = 85.051129;

function project([lng, lat]: LngLat, scale: number): [number, number] {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const x = ((lng + 180) / 360) * WORLD * scale;
  const y = ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * WORLD * scale;
  return [x, y];
}

function unproject([x, y]: [number, number], scale: number): LngLat {
  const lng = (x / (WORLD * scale)) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / (WORLD * scale);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

/**
 * Split a path into dashes of `dash` px separated by `gap` px at `zoom`.
 * Returns the "on" pieces, each a path of two or more points. A path shorter than one
 * dash comes back whole so short legs never disappear.
 */
export function dashPath(path: LngLat[], zoom: number, dash = 8, gap = 6): LngLat[][] {
  if (path.length < 2) return [];
  if (!(dash > 0) || !(gap >= 0)) return [path];
  const scale = 2 ** Math.max(0, zoom);
  const pts = path.map((p) => project(p, scale));
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (total <= dash) return [path];
  const out: LngLat[][] = [];
  let on = true;
  let left = dash; // px remaining in the current dash or gap
  let current: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    let seg = Math.hypot(bx - ax, by - ay);
    while (seg > left) {
      const t = left / seg;
      const mx = ax + (bx - ax) * t;
      const my = ay + (by - ay) * t;
      if (on) {
        current.push([mx, my]);
        out.push(current.map((p) => unproject(p, scale)));
        current = [];
      } else {
        current = [[mx, my]];
      }
      seg -= left;
      ax = mx;
      ay = my;
      on = !on;
      left = on ? dash : gap;
    }
    left -= seg;
    if (on) current.push([bx, by]);
  }
  if (on && current.length >= 2) out.push(current.map((p) => unproject(p, scale)));
  return out.length ? out : [path];
}
