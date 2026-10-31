// News labels -> places and regions, for the World screen and the city panel.
// Pure: no React, no fetch. The server (server/lib/rss.ts) tags each headline with an
// uppercase location label such as "S.KOREA", "MIDEAST" or "WORLD".

import { countryKey } from "./countryNames";
import type { TickerItem } from "../types";

export type RegionKey = "europe" | "asia" | "middle-east" | "africa" | "americas" | "oceania";

export const REGIONS: { value: RegionKey; label: string }[] = [
  { value: "europe", label: "Europe" },
  { value: "asia", label: "Asia" },
  { value: "middle-east", label: "Middle East" },
  { value: "africa", label: "Africa" },
  { value: "americas", label: "Americas" },
  { value: "oceania", label: "Oceania" },
];

export interface NewsPlace {
  /** Readable name ("South Korea", "Middle East", "World"). */
  name: string;
  /** City-record (worldcities.csv) spelling, when the label is a single country. */
  country?: string;
  /** null for "WORLD" and unknown labels. */
  region: RegionKey | null;
}

const C = (name: string, region: RegionKey, country = name): NewsPlace => ({ name, country, region });

const PLACES: Record<string, NewsPlace> = {
  US: C("United States", "americas"),
  UKRAINE: C("Ukraine", "europe"),
  RUSSIA: C("Russia", "europe"),
  CHINA: C("China", "asia"),
  ISRAEL: C("Israel", "middle-east"),
  IRAN: C("Iran", "middle-east"),
  INDIA: C("India", "asia"),
  JAPAN: C("Japan", "asia"),
  "S.KOREA": C("South Korea", "asia", "Korea, South"),
  "N.KOREA": C("North Korea", "asia", "Korea, North"),
  GERMANY: C("Germany", "europe"),
  FRANCE: C("France", "europe"),
  UK: C("United Kingdom", "europe"),
  BRAZIL: C("Brazil", "americas"),
  AUSTRALIA: C("Australia", "oceania"),
  CANADA: C("Canada", "americas"),
  ITALY: C("Italy", "europe"),
  SPAIN: C("Spain", "europe"),
  MEXICO: C("Mexico", "americas"),
  TURKEY: C("Turkey", "europe"),
  SAUDI: C("Saudi Arabia", "middle-east"),
  EGYPT: C("Egypt", "africa"),
  PAKISTAN: C("Pakistan", "asia"),
  INDONESIA: C("Indonesia", "asia"),
  THAILAND: C("Thailand", "asia"),
  PHILIPPINES: C("Philippines", "asia"),
  NIGERIA: C("Nigeria", "africa"),
  "S.AFRICA": C("South Africa", "africa"),
  KENYA: C("Kenya", "africa"),
  COLOMBIA: C("Colombia", "americas"),
  ARGENTINA: C("Argentina", "americas"),
  SUDAN: C("Sudan", "africa"),
  MYANMAR: C("Myanmar", "asia", "Burma"),
  SYRIA: C("Syria", "middle-east"),
  IRAQ: C("Iraq", "middle-east"),
  AFGHANISTAN: C("Afghanistan", "asia"),
  LEBANON: C("Lebanon", "middle-east"),
  YEMEN: C("Yemen", "middle-east"),
  ETHIOPIA: C("Ethiopia", "africa"),
  TAIWAN: C("Taiwan", "asia"),
  ICELAND: C("Iceland", "europe"),
  EUROPE: { name: "Europe", region: "europe" },
  ASIA: { name: "Asia", region: "asia" },
  AFRICA: { name: "Africa", region: "africa" },
  MIDEAST: { name: "Middle East", region: "middle-east" },
  CARIBBEAN: { name: "Caribbean", region: "americas" },
  WORLD: { name: "World", region: null },
};

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s.-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

/** What a news location label refers to. Unknown labels read as a title-cased name with no region. */
export function newsPlace(label: string | undefined): NewsPlace {
  const key = (label ?? "").trim().toUpperCase();
  if (!key) return { name: "World", region: null };
  return PLACES[key] ?? { name: titleCase(key), region: null };
}

export function regionLabel(region: RegionKey): string {
  return REGIONS.find((r) => r.value === region)?.label ?? region;
}

/** Items in a region (null = all). Global ("WORLD") items show only under "All". */
export function filterNewsByRegion<T extends Pick<TickerItem, "location">>(items: T[], region: RegionKey | null): T[] {
  if (!region) return items;
  return items.filter((it) => newsPlace(it.location).region === region);
}

/** Items about one country, given a city record's country spelling. */
export function newsForCountry<T extends Pick<TickerItem, "location">>(items: T[], country: string): T[] {
  const key = countryKey(country);
  return items.filter((it) => {
    const c = newsPlace(it.location).country;
    return !!c && countryKey(c) === key;
  });
}

/**
 * Natural Earth continent/subregion -> our region key (for placing a city whose country
 * has no country-level headline). Western Asia counts as Middle East; Northern Africa
 * stays Africa.
 */
export function regionFromContinent(continent: string | undefined, subregion?: string): RegionKey | null {
  if (subregion === "Western Asia") return "middle-east";
  switch (continent) {
    case "Europe":
      return "europe";
    case "Asia":
      return "asia";
    case "Africa":
      return "africa";
    case "North America":
    case "South America":
      return "americas";
    case "Oceania":
      return "oceania";
    default:
      return null;
  }
}

/** Server relative times ("now", "12m", "3h", "2d") as plain words. */
export function formatNewsTime(time: string | undefined): string {
  const t = (time ?? "").trim();
  if (!t || t === "—") return "";
  if (t === "now") return "Just now";
  const m = t.match(/^(\d+)\s*([mhd])$/);
  if (!m) return t;
  const n = Number(m[1]);
  if (m[2] === "m") return `${n} min ago`;
  if (m[2] === "h") return n === 1 ? "1 hour ago" : `${n} hours ago`;
  return n === 1 ? "Yesterday" : `${n} days ago`;
}

/** Order for sorting by recency: minutes since publication (unknown sorts last). */
export function newsAgeMinutes(time: string | undefined): number {
  const t = (time ?? "").trim();
  if (t === "now") return 0;
  const m = t.match(/^(\d+)\s*([mhd])$/);
  if (!m) return Number.POSITIVE_INFINITY;
  const n = Number(m[1]);
  return m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 1440;
}

/** The server falls back to built-in sample headlines (no source, no link) when feeds fail. */
export function isMockNews(items: Pick<TickerItem, "source" | "url">[]): boolean {
  return items.length > 0 && items.every((it) => !it.source && !it.url);
}
