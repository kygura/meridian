// Day counting for the solver (ADR 0015): Schengen 90/180, per-country rules the owner
// enters, and tax-year days. Pure. Days are whole UTC day numbers (days since 1970-01-01).
//
// Counting rule (the Schengen Borders Code, Regulation (EU) 2016/399, Art. 6): every
// calendar day the traveller is inside the area counts, the entry and exit days
// included. A stay from move-in day s to move-out day e therefore occupies days s..e
// inclusive; two consecutive Schengen stays share the moving day and it counts once.

export const SCHENGEN_RULE = { days: 90, windowDays: 180 } as const;

/**
 * Schengen Area members (29, with Bulgaria and Romania in full from 1 January 2025), in
 * the city dataset's spelling. Source: European Commission, "Schengen Area"
 * (home-affairs.ec.europa.eu). Cyprus and Ireland are EU members outside it.
 */
export const SCHENGEN_COUNTRIES: ReadonlySet<string> = new Set([
  "Austria",
  "Belgium",
  "Bulgaria",
  "Croatia",
  "Czechia",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Iceland",
  "Italy",
  "Latvia",
  "Liechtenstein",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Netherlands",
  "Norway",
  "Poland",
  "Portugal",
  "Romania",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden",
  "Switzerland",
]);

export const SCHENGEN_SOURCE = "Schengen Borders Code (EU) 2016/399, Art. 6: 90 days in any 180; members per the European Commission";

export function inSchengen(country: string | undefined): boolean {
  return !!country && SCHENGEN_COUNTRIES.has(country);
}

const DAY = 86_400_000;
export const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY);
export const dayIso = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

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

/** Days used in the window of `windowDays` ending on `day`. */
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

/** Nights of [start, end) by calendar year. */
export function nightsByYear(start: number, end: number): Map<number, number> {
  const out = new Map<number, number>();
  let d = start;
  while (d < end) {
    const y = new Date(d * DAY).getUTCFullYear();
    const next = Math.min(end, dayNum(`${y + 1}-01-01`));
    out.set(y, (out.get(y) ?? 0) + (next - d));
    d = next;
  }
  return out;
}

export const TAX_NOTE =
  "Tax days count nights in a country per calendar year against the common 183-day test. Your own countries' rules may differ; check them.";
