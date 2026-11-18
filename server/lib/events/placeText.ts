// The text of a place (ADR 0021): its English Wikivoyage and Wikipedia articles and the articles of
// the regions above it, found through Wikidata, split into sections. Claude reads it to list the
// place's seasonal highlights (claudeHighlights.ts). Wikipedia and Wikivoyage text is CC BY-SA; it
// is held in memory for the call and not stored.

import type { City } from "../../../src/types.js";
import { haversineKm } from "../../../src/lib/geo.js";
import { countryKey } from "./common.js";

export type GetJson = (url: string, label: string) => Promise<unknown>;

const WP = "https://en.wikipedia.org/w/api.php";
const WV = "https://en.wikivoyage.org/w/api.php";
const WD = "https://www.wikidata.org/w/api.php";
export const WP_PAGE = "https://en.wikipedia.org/wiki/";
export const WV_PAGE = "https://en.wikivoyage.org/wiki/";
const NEAR_KM = 50;

interface WpPage {
  title: string;
  missing?: boolean;
  extract?: string;
  coordinates?: { lat: number; lon: number }[];
  pageprops?: { wikibase_item?: string; disambiguation?: string };
}

const pagesOf = (j: unknown): WpPage[] => {
  const p = (j as { query?: { pages?: WpPage[] } } | null)?.query?.pages;
  return Array.isArray(p) ? p : [];
};

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** The article of a city: the page among name candidates that has coordinates within 50 km and is not a disambiguation page. */
export function pickCityPage(pages: WpPage[], city: Pick<City, "lat" | "lng">): WpPage | undefined {
  const near = pages
    .filter((p) => !p.missing && p.pageprops?.disambiguation === undefined && p.coordinates?.[0])
    .map((p) => ({ p, d: haversineKm([city.lng, city.lat], [p.coordinates![0]!.lon, p.coordinates![0]!.lat]) }))
    .filter((x) => x.d <= NEAR_KM)
    .sort((a, b) => a.d - b.d);
  return near[0]?.p;
}

/** The current "located in" (P131) values of an item: statements with an end time (a former state or empire) are left out, and preferred ones win. */
const claimIds = (j: unknown): string[] => {
  type Claim = { mainsnak?: { datavalue?: { value?: { id?: string } } }; rank?: string; qualifiers?: Record<string, unknown> };
  const claims = ((j as { claims?: Record<string, Claim[]> } | null)?.claims?.["P131"] ?? []).filter((c) => c.rank !== "deprecated" && !c.qualifiers?.["P582"]);
  const preferred = claims.filter((c) => c.rank === "preferred");
  return (preferred.length ? preferred : claims).map((c) => c.mainsnak?.datavalue?.value?.id).filter((x): x is string => typeof x === "string");
};

export interface RegionArticles {
  /** Wikidata item of the region: what a region's result is cached by. */
  qid: string;
  wp?: string;
  wv?: string;
}

export interface PlaceArticles {
  cityWp?: string;
  cityWv?: string;
  qid?: string;
  /** The administrative regions above the city, nearest first, at most three levels, a country's own article left out. */
  regions: RegionArticles[];
  requests: number;
}

/**
 * Finds the articles. The city's Wikipedia article is found by name and checked by its
 * coordinates (or by a search near the city when the name is ambiguous); Wikidata gives its
 * Wikivoyage title and, through P131 (located in) up to three levels, the regions above it. Each step that
 * fails leaves what was found. Requests are made one after another through `get`.
 */
export async function resolvePlace(city: City, get: GetJson): Promise<PlaceArticles> {
  const out: PlaceArticles = { regions: [], requests: 0 };
  const call = async (url: string, label: string): Promise<unknown> => {
    out.requests++;
    return get(url, label);
  };
  const attempt = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      // What was found so far is still used.
    }
  };

  await attempt(async () => {
    const candidates = [...new Set([city.name, `${city.name}, ${city.country}`, `${city.name} (${city.country})`])];
    const q = qs({ action: "query", titles: candidates.join("|"), redirects: "1", prop: "coordinates|pageprops", ppprop: "wikibase_item|disambiguation", coprimary: "primary", format: "json", formatversion: "2" });
    let page = pickCityPage(pagesOf(await call(`${WP}?${q}`, "Wikipedia")), city);
    if (!page) {
      const g = qs({ action: "query", list: "geosearch", gscoord: `${city.lat}|${city.lng}`, gsradius: "10000", gslimit: "10", gsprop: "type|name", format: "json", formatversion: "2" });
      const hits = ((await call(`${WP}?${g}`, "Wikipedia")) as { query?: { geosearch?: { title: string; type?: string }[] } })?.query?.geosearch ?? [];
      const norm = (s: string) => ` ${s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
      const first = norm(city.name).trim().split(" ")[0] ?? "";
      const hit = hits.find((h) => h.type === "city" && norm(h.title).includes(` ${first}`)) ?? hits.find((h) => norm(h.title).includes(` ${first}`));
      if (hit) {
        const q2 = qs({ action: "query", titles: hit.title, redirects: "1", prop: "pageprops", ppprop: "wikibase_item", format: "json", formatversion: "2" });
        page = pagesOf(await call(`${WP}?${q2}`, "Wikipedia"))[0];
      }
    }
    if (page) {
      out.cityWp = page.title;
      out.qid = page.pageprops?.wikibase_item;
    }
  });

  if (out.qid) {
    const qid = out.qid;
    await attempt(async () => {
      // Up the chain of "located in", the current statement at each of three levels.
      const chain: string[] = [];
      let at = qid;
      for (let level = 0; level < 3; level++) {
        const up = claimIds(await call(`${WD}?${qs({ action: "wbgetclaims", entity: at, property: "P131", format: "json" })}`, "Wikidata"))[0];
        if (!up || chain.includes(up) || up === qid) break;
        chain.push(up);
        at = up;
      }
      const ids = [qid, ...chain];
      const ent = (await call(`${WD}?${qs({ action: "wbgetentities", ids: ids.join("|"), props: "sitelinks", sitefilter: "enwiki|enwikivoyage", format: "json" })}`, "Wikidata")) as {
        entities?: Record<string, { sitelinks?: { enwiki?: { title: string }; enwikivoyage?: { title: string } } }>;
      };
      const links = (id: string) => ent.entities?.[id]?.sitelinks;
      out.cityWv = links(qid)?.enwikivoyage?.title;
      for (const id of chain) {
        const wp = links(id)?.enwiki?.title;
        const wv = links(id)?.enwikivoyage?.title;
        const own = [wp, wv].filter((x): x is string => !!x).filter((t) => countryKey(t) !== countryKey(city.country));
        if (own.length) out.regions.push({ qid: id, ...(wp && own.includes(wp) ? { wp } : {}), ...(wv && own.includes(wv) ? { wv } : {}) });
      }
    });
  }
  return out;
}

/** The plain-text extract of one article, with its headings written as "== Heading ==". Empty when the article is missing. */
export async function fetchExtract(wiki: "wikipedia" | "wikivoyage", title: string, get: GetJson): Promise<string> {
  const q = qs({ action: "query", prop: "extracts", explaintext: "1", redirects: "1", titles: title, format: "json", formatversion: "2", exlimit: "1" });
  const page = pagesOf(await get(`${wiki === "wikipedia" ? WP : WV}?${q}`, wiki === "wikipedia" ? "Wikipedia" : "Wikivoyage"))[0];
  return page?.extract ?? "";
}

export interface Section {
  /** The level-2 heading, "" for the lead. */
  heading: string;
  /** The section's text with the headings of its subsections, without its own heading. */
  text: string;
}

/** An extract split on its level-2 headings ("== X =="); the part before the first is the lead. Subsections stay inside their section. */
export function splitSections(extract: string): Section[] {
  const out: Section[] = [];
  let heading = "";
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text || heading) out.push({ heading, text });
  };
  for (const line of extract.split("\n")) {
    const m = /^==\s*([^=].*?)\s*==\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[1]!;
      lines = [];
    } else lines.push(line);
  }
  flush();
  return out;
}

export const articleUrl = (wiki: "wikipedia" | "wikivoyage", title: string, heading?: string) =>
  `${wiki === "wikipedia" ? WP_PAGE : WV_PAGE}${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2C/g, ",").replace(/%3A/g, ":")}${heading ? `#${encodeURIComponent(heading.replace(/ /g, "_"))}` : ""}`;
