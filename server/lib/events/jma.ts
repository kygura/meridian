// Cherry blossom and autumn leaves in Japan, from the Japan Meteorological Agency's
// phenology tables (ADR 0021). The agency publishes observed dates per station for the last
// years and a normal (平年値). Stations are matched to Meridian cities by their Japanese
// name, which the city dataset carries as `nativeName`.

import type { City } from "../../../src/types.js";
import { orderMonths } from "../../../src/lib/eventKinds.js";
import { DAY_MS, httpGet, type SourceDef, type StoredEvent } from "./common.js";

export const JMA_BASE = "https://www.data.jma.go.jp/sakura/data/";
export const JMA_INDEX = `${JMA_BASE}index.html`;
/** Page names to use when the index cannot be read. The index is read first, as the decade suffix moves. */
export const JMA_FALLBACK_PAGES = { flowering: "sakura003_07.html", fullBloom: "sakura004_07.html", maple: "phn_014.html" } as const;

export interface MonthDay {
  m: number;
  d: number;
}

export interface SakuraRow {
  station: string;
  /** Observed date per year, in the order of `years`; null where the station has none. */
  observed: (MonthDay | null)[];
  normal: MonthDay | null;
}

export interface SakuraTable {
  years: number[];
  rows: SakuraRow[];
}

const validMd = (m: number, d: number): MonthDay | null => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { m, d } : null);

/**
 * The preformatted cherry blossom tables (開花日, 満開日): a header line "地点名 2021 ... 平年値",
 * then one line per station: the name, an optional "*", a "month day" pair or "-" for each
 * year, the same for the normal, and an optional substitute species. Station lines with a
 * name that has no digits after it are skipped.
 */
export function parseSakuraTable(text: string): SakuraTable {
  const pre = /<pre>([\s\S]*?)<\/pre>/i.exec(text)?.[1] ?? text;
  const lines = pre.split(/\r?\n/);
  let years: number[] = [];
  const rows: SakuraRow[] = [];
  for (const line of lines) {
    if (line.startsWith("地点名")) {
      const ys = [...line.matchAll(/\b(20\d{2}|19\d{2})\b/g)].map((m) => Number(m[1]));
      if (ys.length) years = ys;
      continue;
    }
    if (!years.length || !line.trim() || line.startsWith("月") || /^\s/.test(line)) continue;
    const nameMatch = /^(\S+)\s+(.*)$/.exec(line.replace(/　/g, " "));
    if (!nameMatch) continue;
    const station = nameMatch[1]!;
    const tokens = nameMatch[2]!.split(/\s+/).filter((t) => t && t !== "*");
    const cells: (MonthDay | null)[] = [];
    let i = 0;
    while (cells.length < years.length + 1 && i < tokens.length) {
      const t = tokens[i]!;
      if (t === "-") {
        cells.push(null);
        i += 1;
      } else if (/^\d+$/.test(t) && /^\d+$/.test(tokens[i + 1] ?? "")) {
        cells.push(validMd(Number(t), Number(tokens[i + 1])));
        i += 2;
      } else break;
    }
    if (cells.length !== years.length + 1) continue;
    rows.push({ station, observed: cells.slice(0, years.length), normal: cells[years.length] ?? null });
  }
  return { years, rows };
}

export interface MapleRow {
  station: string;
  /** Per year: the observed date and the difference from the normal in days (observed minus normal). */
  years: { year: number; observed: MonthDay | null; diffFromNormal: number | null }[];
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** The autumn leaf (かえで紅葉) table: observed date, difference from the normal and from last year, for each year. */
export function parseMapleTable(html: string): MapleRow[] {
  const years = [...html.matchAll(/<th[^>]*colspan=3[^>]*>\s*(\d{4})年/gi)].map((m) => Number(m[1]));
  if (!years.length) return [];
  const out: MapleRow[] = [];
  for (const tr of html.split(/<tr[^>]*>/i)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]!));
    if (tds.length < 1 + years.length * 3) continue;
    const station = tds[0]!;
    if (!station) continue;
    out.push({
      station,
      years: years.map((year, k) => {
        const obs = tds[1 + k * 3] ?? "";
        const diff = tds[2 + k * 3] ?? "";
        const md = /(\d{1,2})月\s*(\d{1,2})日/.exec(obs);
        return {
          year,
          observed: md ? validMd(Number(md[1]), Number(md[2])) : null,
          diffFromNormal: /^[+-]?\d+$/.test(diff) ? Number(diff) : null,
        };
      }),
    });
  }
  return out;
}

// Stations to cities

/** A station or city name for comparison: width-normalised, without a trailing 市, 町, 村 or 区. */
export function normalizeJa(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").replace(/[市町村区]$/, "");
}

export interface StationMatch {
  /** station name -> city id */
  matched: Map<string, string>;
  unmatched: string[];
}

/**
 * Match stations to cities in Japan by native name. Where several cities share a name the
 * biggest wins. There is no romanised fallback: a JMA station name is Japanese and the
 * dataset's romanised names are not derived from it, so a station whose name is not a
 * city's native name is counted as unmatched.
 */
export function matchStations(stations: string[], cities: City[]): StationMatch {
  const byName = new Map<string, City>();
  for (const c of cities) {
    if (c.country !== "Japan" || !c.nativeName) continue;
    const k = normalizeJa(c.nativeName);
    const cur = byName.get(k);
    if (!cur || c.population > cur.population) byName.set(k, c);
  }
  const matched = new Map<string, string>();
  const unmatched: string[] = [];
  for (const s of stations) {
    const c = byName.get(normalizeJa(s));
    if (c) matched.set(s, c.id);
    else unmatched.push(s);
  }
  return { matched, unmatched };
}

// Events

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dayOfYear = (y: number, md: MonthDay) => Date.UTC(y, md.m - 1, md.d) / DAY_MS;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMd = (md: MonthDay) => `${MONTH_ABBR[md.m - 1]} ${md.d}`;

/** The next occurrence of a month and day on or after `today`. */
export function nextOccurrence(md: MonthDay, today: Date): string {
  const y = today.getUTCFullYear();
  const t = Date.UTC(y, today.getUTCMonth(), today.getUTCDate()) / DAY_MS;
  return dayOfYear(y, md) >= t ? iso(y, md.m, md.d) : iso(y + 1, md.m, md.d);
}

/**
 * The event's date: the latest observed date when it is within the last 30 days or the next
 * 12 months (the current season), else the normal projected to its next occurrence.
 */
export function seasonDate(observed: { year: number; md: MonthDay } | undefined, normal: MonthDay, today: Date): string {
  if (observed) {
    const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / DAY_MS;
    const o = dayOfYear(observed.year, observed.md);
    if (o >= t - 30 && o <= t + 365) return iso(observed.year, observed.md.m, observed.md.d);
  }
  return nextOccurrence(normal, today);
}

/** Months from one month-day to another, at most three. */
export function monthsBetween(from: MonthDay, to: MonthDay): number[] {
  const out: number[] = [];
  let m = from.m;
  for (let i = 0; i < 3; i++) {
    out.push(m);
    if (m === to.m) break;
    m = m === 12 ? 1 : m + 1;
  }
  return orderMonths(out.includes(to.m) ? out : [from.m]);
}

const latest = (row: SakuraRow | undefined, years: number[]): { year: number; md: MonthDay } | undefined => {
  if (!row) return undefined;
  for (let i = years.length - 1; i >= 0; i--) {
    const md = row.observed[i];
    if (md) return { year: years[i]!, md };
  }
  return undefined;
};

export interface JmaInput {
  flowering?: SakuraTable;
  fullBloom?: SakuraTable;
  maple?: MapleRow[];
}

export interface JmaBuilt {
  events: StoredEvent[];
  stations: { cherry: number; maple: number };
  matched: { cherry: number; maple: number };
  unmatched: string[];
}

const cherryUrl = JMA_BASE + JMA_FALLBACK_PAGES.flowering;
const mapleUrl = JMA_BASE + JMA_FALLBACK_PAGES.maple;

/** One cherry blossom event and one autumn leaves event per matched station that has a normal. */
export function buildJmaEvents(input: JmaInput, cities: City[], now: Date, pages: { flowering?: string; maple?: string } = {}): JmaBuilt {
  const events: StoredEvent[] = [];
  const stationNames = new Set<string>();
  const cherryRows = (input.flowering?.rows ?? []).filter((r) => r.normal);
  const mapleRows = (input.maple ?? []).filter((r) => r.years.some((y) => y.observed && y.diffFromNormal !== null));
  for (const r of cherryRows) stationNames.add(r.station);
  for (const r of mapleRows) stationNames.add(r.station);
  const { matched, unmatched } = matchStations([...stationNames], cities);
  const bloomByStation = new Map((input.fullBloom?.rows ?? []).map((r) => [r.station, r]));
  const seen = new Set<string>();

  let cherryMatched = 0;
  for (const r of cherryRows) {
    const cityId = matched.get(r.station);
    if (!cityId || seen.has(`c|${cityId}`)) continue;
    seen.add(`c|${cityId}`);
    cherryMatched++;
    const normal = r.normal!;
    const bloom = bloomByStation.get(r.station);
    const fullNormal = bloom?.normal ?? null;
    const months = fullNormal ? monthsBetween(normal, fullNormal) : [normal.m];
    const obs = latest(r, input.flowering!.years);
    const obsBloom = latest(bloom, input.fullBloom?.years ?? []);
    const notes = [`Normal: first flowers ${fmtMd(normal)}${fullNormal ? `, full bloom ${fmtMd(fullNormal)}` : ""}.`];
    if (obs) notes.push(`Observed first flowers ${fmtMd(obs.md)}, ${obs.year}${obsBloom && obsBloom.year === obs.year ? `, full bloom ${fmtMd(obsBloom.md)}` : ""}.`);
    events.push({
      id: `jma-sakura-${cityId}`,
      title: "Cherry blossom",
      kind: "nature",
      cityIds: [cityId],
      month: months[0]!,
      ...(months.length > 1 ? { months } : {}),
      date: seasonDate(obs, normal, now),
      recurring: true,
      tags: ["cherry-blossom", "nature"],
      note: `${notes.join(" ")} Japan Meteorological Agency.`,
      source: "jma",
      sourceUrl: pages.flowering ?? cherryUrl,
      feed: "jma",
    });
  }

  let mapleMatched = 0;
  for (const r of mapleRows) {
    const cityId = matched.get(r.station);
    if (!cityId || seen.has(`m|${cityId}`)) continue;
    const withDiff = [...r.years].reverse().find((y) => y.observed && y.diffFromNormal !== null);
    if (!withDiff?.observed) continue;
    seen.add(`m|${cityId}`);
    mapleMatched++;
    // The normal is the observed date minus the stated difference from it.
    const obsDay = dayOfYear(withDiff.year, withDiff.observed);
    const nd = new Date((obsDay - withDiff.diffFromNormal!) * DAY_MS);
    const normal: MonthDay = { m: nd.getUTCMonth() + 1, d: nd.getUTCDate() };
    const latestObs = [...r.years].reverse().find((y) => y.observed);
    const obs = latestObs?.observed ? { year: latestObs.year, md: latestObs.observed } : undefined;
    events.push({
      id: `jma-koyo-${cityId}`,
      title: "Autumn leaves",
      kind: "nature",
      cityIds: [cityId],
      month: normal.m,
      date: seasonDate(obs, normal, now),
      recurring: true,
      tags: ["autumn-leaves", "koyo", "nature"],
      note: `Normal: maple leaves colour around ${fmtMd(normal)}.${obs ? ` Observed ${fmtMd(obs.md)}, ${obs.year}.` : ""} Japan Meteorological Agency.`,
      source: "jma",
      sourceUrl: pages.maple ?? mapleUrl,
      feed: "jma",
    });
  }
  return {
    events,
    stations: { cherry: cherryRows.length, maple: mapleRows.length },
    matched: { cherry: cherryMatched, maple: mapleMatched },
    unmatched,
  };
}

/** The suffix on the table pages (sakura003_07) changes when the agency starts a new table, so the index is read first. */
export function discoverPages(indexHtml: string): { flowering: string; fullBloom: string; maple: string } {
  const pick = (re: RegExp, fallback: string) => {
    const all = [...indexHtml.matchAll(re)].map((m) => m[1]!);
    return all.sort().at(-1) ?? fallback;
  };
  return {
    flowering: pick(/href="(sakura003_\d+\.html)"/g, JMA_FALLBACK_PAGES.flowering),
    fullBloom: pick(/href="(sakura004_\d+\.html)"/g, JMA_FALLBACK_PAGES.fullBloom),
    maple: pick(/href="(phn_014\.html)"/g, JMA_FALLBACK_PAGES.maple),
  };
}

export const jmaSource: SourceDef = {
  id: "jma",
  intervalMs: 7 * DAY_MS,
  async run(ctx) {
    let pages: { flowering: string; fullBloom: string; maple: string } = { ...JMA_FALLBACK_PAGES };
    const get = async (name: string): Promise<string> => (await httpGet(JMA_BASE + name, ctx, "JMA", "text/html")).text();
    try {
      pages = discoverPages(await (await httpGet(JMA_INDEX, ctx, "JMA", "text/html")).text());
    } catch {
      // Fall back to the known page names.
    }
    const errors: string[] = [];
    const input: JmaInput = {};
    const tryPage = async (key: keyof JmaInput, name: string, parse: (t: string) => unknown) => {
      try {
        await ctx.sleep(500);
        (input as Record<string, unknown>)[key] = parse(await get(name));
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await tryPage("flowering", pages.flowering, parseSakuraTable);
    await tryPage("fullBloom", pages.fullBloom, parseSakuraTable);
    await tryPage("maple", pages.maple, parseMapleTable);
    if (!input.flowering && !input.maple) throw new Error(`JMA pages unavailable: ${errors.join("; ")}`.slice(0, 280));
    const built = buildJmaEvents(input, ctx.cities, ctx.now, { flowering: JMA_BASE + pages.flowering, maple: JMA_BASE + pages.maple });
    return {
      events: built.events,
      unmatched: built.unmatched.length,
      detail: {
        cherryStations: built.stations.cherry,
        cherryMatched: built.matched.cherry,
        mapleStations: built.stations.maple,
        mapleMatched: built.matched.maple,
        ...(errors.length ? { pageErrors: errors.join("; ").slice(0, 200) } : {}),
      },
    };
  },
};
