// Small UTC date helpers shared by the journal engine (fingerprint, observed
// weather, crowd). Dates are YYYY-MM-DD; months are 1-based (R3).

const DAY_MS = 86_400_000;

export function parseDay(date: string): number {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return formatDay(parseDay(date) + days * DAY_MS);
}

/** Nights between arrive and depart (0 for a same-day stop, never negative). */
export function stayNights(arrive: string, depart: string): number {
  return Math.max(0, Math.round((parseDay(depart) - parseDay(arrive)) / DAY_MS));
}

/** Each night of the stay: arrive <= d < depart. A same-day stop yields [arrive]. */
export function eachNight(arrive: string, depart: string): string[] {
  const n = stayNights(arrive, depart);
  if (n === 0) return [arrive.slice(0, 10)];
  return Array.from({ length: n }, (_, i) => addDays(arrive, i));
}

/** Every calendar day in [from, to] inclusive. */
export function eachDay(from: string, to: string): string[] {
  const n = Math.max(0, Math.round((parseDay(to) - parseDay(from)) / DAY_MS));
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

export function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

/** Month (1-12) holding the most nights of the given dates; ties go to the earliest. */
export function dominantMonthOfNights(nights: string[]): number {
  const counts = new Map<string, number>();
  for (const d of nights) {
    const key = d.slice(0, 7);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = "";
  let bestN = -1;
  for (const key of [...counts.keys()].sort()) {
    const n = counts.get(key)!;
    if (n > bestN) {
      best = key;
      bestN = n;
    }
  }
  return Number(best.slice(5, 7));
}

export function dominantMonth(arrive: string, depart: string): number {
  return dominantMonthOfNights(eachNight(arrive, depart));
}

/** ISO-8601 week number (1-53). */
export function isoWeek(date: string): number {
  const d = new Date(parseDay(date));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
}

/** Middle night of a stay (used for weekOfYear). */
export function midNight(arrive: string, depart: string): string {
  const nights = eachNight(arrive, depart);
  return nights[Math.floor((nights.length - 1) / 2)]!;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
