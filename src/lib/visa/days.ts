// Day arithmetic for visa and tax counting (ADR 0012). Pure. Days are whole UTC day numbers
// (days since 1970-01-01). The solver's day counting (ADR 0015) uses these same functions.
//
// Counting rule (the Schengen Borders Code, Regulation (EU) 2016/399, Art. 6, and most
// rolling-window regimes): every calendar day the traveller is in the country counts, the
// entry and exit days included. A stay from move-in day s to move-out day e occupies days
// s..e inclusive; two consecutive stays share the moving day and, in one country, it counts once.

const DAY = 86_400_000;
export const dayNum = (d: string) => Math.round(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / DAY);
export const dayIso = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
export const yearOf = (n: number) => new Date(n * DAY).getUTCFullYear();

/** Inclusive day ranges, sorted and non-overlapping after `addRange`. */
export type Ranges = readonly (readonly [number, number])[];

/** A new list with [a, b] merged in. Ranges touching or overlapping are joined. */
export function addRange(r: Ranges, a: number, b: number): Ranges {
  const out: [number, number][] = [];
  let lo = a;
  let hi = b;
  let placed = false;
  for (const [x, y] of r) {
    if (y < lo - 1) out.push([x, y]);
    else if (x > hi + 1) {
      if (!placed) {
        out.push([lo, hi]);
        placed = true;
      }
      out.push([x, y]);
    } else {
      lo = Math.min(lo, x);
      hi = Math.max(hi, y);
    }
  }
  if (!placed) out.push([lo, hi]);
  return out;
}

/** Days of `r` inside [from, to] inclusive. */
export function daysWithin(r: Ranges, from: number, to: number): number {
  let n = 0;
  for (const [x, y] of r) {
    if (y < from) continue;
    if (x > to) break;
    n += Math.min(y, to) - Math.max(x, from) + 1;
  }
  return n;
}

/** Days used in the window of `windowDays` ending on `day` (that day included). */
export function usedOn(r: Ranges, day: number, windowDays: number): number {
  return daysWithin(r, day - windowDays + 1, day);
}

/**
 * The most days used in any window, and the day it happens. The count only rises on
 * days present, so the maximum falls on the last day of some range.
 */
export function peakUse(r: Ranges, windowDays: number, from = -Infinity, to = Infinity): { used: number; day: number | null } {
  let best = 0;
  let day: number | null = null;
  for (const [, y] of r) {
    if (y < from || y > to + windowDays) continue;
    const u = usedOn(r, y, windowDays);
    if (u > best) {
      best = u;
      day = y;
    }
  }
  return { used: best, day };
}

/**
 * The first day present on which the window ending that day holds more than `limit` days,
 * or null. Scans present days only, since only they raise the count.
 */
export function firstOver(r: Ranges, limit: number, windowDays: number, from = -Infinity): number | null {
  for (const [x, y] of r) {
    if (y < from) continue;
    for (let d = Math.max(x, from); d <= y; d++) if (usedOn(r, d, windowDays) > limit) return d;
  }
  return null;
}

/** Nights of [start, end) by calendar year. */
export function nightsByYear(start: number, end: number): Map<number, number> {
  const out = new Map<number, number>();
  let d = start;
  while (d < end) {
    const y = yearOf(d);
    const next = Math.min(end, dayNum(`${y + 1}-01-01`));
    out.set(y, (out.get(y) ?? 0) + (next - d));
    d = next;
  }
  return out;
}

/** Ranges as ISO pairs, for display and tests. */
export const rangesIso = (r: Ranges) => r.map(([a, b]) => [dayIso(a), dayIso(b)] as [string, string]);
