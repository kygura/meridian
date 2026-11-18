// Turns the recurrence Wikidata gives a festival ("day in year for periodic occurrence", P837,
// or its month of the year, P2922) into months or dates. Calendar systems are rules, not
// event lists: the Chinese calendar comes from the runtime's ICU data, and a Hindu lunar
// month name maps to the Gregorian month its bright fortnight usually falls in.

import { monthOf, MONTH_NAMES } from "./common.js";

export type When =
  /** A month, or a Gregorian "Month day": recurring every year. */
  | { kind: "months"; months: number[]; approximate?: boolean }
  /** A lunisolar date resolved to Gregorian dates inside the horizon. */
  | { kind: "dates"; dates: string[] };

/**
 * Hindu lunar month (amanta) to the Gregorian month its bright fortnight mostly falls in.
 * The lunar month drifts about a month against the Gregorian one from year to year, so a
 * festival read through this table is placed in an approximate month, and marked so.
 */
const HINDU_MONTH: Record<string, number> = {
  chaitra: 4,
  vaishakha: 5,
  vaisakha: 5,
  jyeshtha: 6,
  jyaishtha: 6,
  ashadha: 7,
  ashadh: 7,
  shraavana: 8,
  shravana: 8,
  sravana: 8,
  bhadra: 9,
  bhadrapada: 9,
  ashvin: 10,
  ashwin: 10,
  ashvina: 10,
  kartik: 11,
  kartika: 11,
  margashirsha: 12,
  agrahayana: 12,
  pausha: 1,
  pushya: 1,
  magha: 2,
  phalguna: 3,
  phalgun: 3,
};

const HINDU_RE = new RegExp(`^(${Object.keys(HINDU_MONTH).join("|")})\\b`, "i");

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const ordinal = "(\\d{1,2})(?:st|nd|rd|th)";
const CHINESE_DAY_RE = new RegExp(`^${ordinal} day of the ${ordinal} month\\b`, "i");
const CHINESE_NY_RE = /^lunar\/lunisolar new year'?s day$|^(?:chinese|lunar) new year'?s day$/i;

/** The Chinese calendar's (month, day) for each Gregorian day from `from` through `to`, by ICU. Leap months are marked 0. */
export function chineseCalendarDays(from: Date, to: Date): { date: string; month: number; day: number }[] {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-u-ca-chinese", { month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" });
  } catch {
    return [];
  }
  const out: { date: string; month: number; day: number }[] = [];
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 4);
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 4);
  for (let t = start; t <= end; t += 86_400_000) {
    const parts = fmt.formatToParts(new Date(t));
    const m = parts.find((p) => p.type === "month")?.value ?? "";
    const d = Number(parts.find((p) => p.type === "day")?.value);
    // A leap month reads "5bis" or similar; it is not the ordinary month 5.
    out.push({ date: isoDay(new Date(t)), month: /^\d+$/.test(m) ? Number(m) : 0, day: d });
  }
  return out;
}

const chineseCache = new Map<string, { date: string; month: number; day: number }[]>();
function chineseDays(from: Date, to: Date) {
  const key = `${isoDay(from)}/${isoDay(to)}`;
  let v = chineseCache.get(key);
  if (!v) {
    v = chineseCalendarDays(from, to);
    chineseCache.set(key, v);
    if (chineseCache.size > 4) chineseCache.delete(chineseCache.keys().next().value as string);
  }
  return v;
}

/**
 * What a P837 or P2922 label means:
 *   "October", "April 13"                    a month, every year
 *   "Ashvin Shukla Pratipada"                an approximate month (Hindu lunar calendar)
 *   "15th day of the 8th month ... Chinese"  dates in [from, to] from the Chinese calendar
 *   "Lunar/Lunisolar New Year's Day"         the same, month 1 day 1
 * Anything else (a weekday rule, "Easter - 47 days", a Thai lunar month) is undefined.
 */
export function parseWhen(label: string, from: Date, to: Date): When | undefined {
  const text = label.trim();
  if (!text) return undefined;
  const direct = monthOf(text);
  if (direct) return { kind: "months", months: [direct] };
  const md = /^([A-Za-z]+)\s+(\d{1,2})$/.exec(text);
  if (md) {
    const m = MONTH_NAMES.indexOf(md[1]!.toLowerCase());
    if (m >= 0) return { kind: "months", months: [m + 1] };
  }
  const hindu = HINDU_RE.exec(text);
  if (hindu) return { kind: "months", months: [HINDU_MONTH[hindu[1]!.toLowerCase()]!], approximate: true };
  let target: { month: number; day: number } | undefined;
  const cd = CHINESE_DAY_RE.exec(text);
  if (cd && /chinese|lunisolar|lunar/i.test(text)) target = { day: Number(cd[1]), month: Number(cd[2]) };
  else if (CHINESE_NY_RE.test(text)) target = { month: 1, day: 1 };
  if (target) {
    const dates = chineseDays(from, to)
      .filter((x) => x.month === target!.month && x.day === target!.day)
      .map((x) => x.date);
    return dates.length ? { kind: "dates", dates } : undefined;
  }
  return undefined;
}
