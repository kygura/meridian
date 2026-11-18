// What a place is known for, read from its own text (ADR 0021). The text of a city's English
// Wikipedia and Wikivoyage articles, and of the regions it lies in, is used only to see which
// seasonal species the place's own writing mentions. It is not stored and not shown. Wikipedia and
// Wikivoyage text is CC BY-SA. No names are chosen in advance: what is looked for in the text comes
// from iNaturalist's names for the candidate species and its genus.

import type { City } from "../../../src/types.js";
import { haversineKm } from "../../../src/lib/geo.js";
import { countryKey } from "./common.js";

/** Lower case, accents removed, every run of other characters one space, padded with a space at each end. */
export function normalizeText(s: string): string {
  return ` ${s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

const singular = (w: string) => (w.endsWith("ies") && w.length > 4 ? `${w.slice(0, -3)}y` : w.endsWith("s") && !w.endsWith("ss") && w.length > 3 ? w.slice(0, -1) : w);

/** The forms of a phrase to look for: as given, with a plural on its last word. */
export function phraseForms(phrase: string): string[] {
  const words = normalizeText(phrase).trim().split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const last = singular(words[words.length - 1]!);
  const head = words.slice(0, -1).join(" ");
  const join = (w: string) => ` ${head ? `${head} ` : ""}${w} `;
  const forms = new Set([join(last), join(`${last}s`), join(`${last}es`), join(last.endsWith("y") ? `${last.slice(0, -1)}ies` : last)]);
  return [...forms];
}

/** Whether the normalized text contains the phrase or its plural, on word boundaries. */
export function mentions(text: string, phrase: string): boolean {
  return phraseForms(phrase).some((f) => text.includes(f));
}

/**
 * The names in an iNaturalist common name for a genus: "plums, cherries, and allies" gives plum
 * and cherry. Only commas separate names ("annual and perennial fleabanes" is one name).
 */
export function genusAlternatives(common: string | null | undefined): string[] {
  if (!common) return [];
  return common
    .split(",")
    .map((x) => normalizeText(x.replace(/^\s*(and|or)\s+/i, "").replace(/\s+(and|or)\s+(allies|relatives)\s*$/i, "")).trim())
    .filter((x) => x.length >= 3 && !/^(allies|relatives|species)$/.test(x))
    .map((x) => x.split(" ").map((w, i, a) => (i === a.length - 1 ? singular(w) : w)).join(" "));
}

export interface CandidateNames {
  /** Scientific name. */
  n: string;
  /** English common name, "" when none. */
  c: string;
  /** iNaturalist's common names of the taxa above the species (genus, subgenus), possibly several. */
  genusCommon: string[];
}

export interface Mention {
  /** 0 not mentioned, 1 the species' own name, 2 only its genus. */
  w: 0 | 1 | 2;
  /** The genus name found in the text, singular, for a mention of 2. */
  gc?: string;
  /** The text speaks of "<gc> blossom". */
  blossom?: boolean;
}

/**
 * Whether the text mentions a candidate species. Its own names first (the common name, the
 * scientific name), then its genus: the genus name and iNaturalist's common names for the genus.
 */
export function mentionOf(text: string, names: CandidateNames): Mention {
  if ((names.c && names.c.length >= 4 && mentions(text, names.c)) || (names.n.includes(" ") && mentions(text, names.n))) return { w: 1 };
  const alts = names.genusCommon.flatMap(genusAlternatives);
  const genus = names.n.split(" ")[0] ?? "";
  if (genus.length >= 4 && mentions(text, genus)) return { w: 2, gc: normalizeText(genus).trim(), blossom: false };
  // The whole name ("true cherry"), then its last word ("cherry"), as iNaturalist's genus names often carry a qualifier.
  const found: string[] = [];
  for (const a of alts) {
    const words = a.split(" ");
    const head = words[words.length - 1]!;
    if (mentions(text, a)) found.push(a);
    else if (words.length > 1 && head.length >= 4 && mentions(text, head)) found.push(head);
  }
  if (found.length) {
    // Several names of the genus may be in the text ("plums, cherries"): the one the species' own common name carries is its name.
    const own = normalizeText(names.c);
    const gc = found.find((f) => own.includes(` ${f.split(" ").pop()}`)) ?? found[0]!;
    return { w: 2, gc, blossom: mentions(text, `${gc} blossom`) };
  }
  return { w: 0 };
}

// Fetching

export type GetJson = (url: string, label: string) => Promise<unknown>;

const WP = "https://en.wikipedia.org/w/api.php";
const WV = "https://en.wikivoyage.org/w/api.php";
const WD = "https://www.wikidata.org/w/api.php";
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

const claimIds = (j: unknown): string[] => {
  const claims = (j as { claims?: Record<string, { mainsnak?: { datavalue?: { value?: { id?: string } } }; rank?: string }[]> } | null)?.claims?.["P131"];
  return (claims ?? []).filter((c) => c.rank !== "deprecated").map((c) => c.mainsnak?.datavalue?.value?.id).filter((x): x is string => typeof x === "string");
};

export interface PlaceText {
  /** Normalized text of the city's articles and its regions' articles; "" when none was found. */
  text: string;
  /** The article titles used, for the log. */
  titles: string[];
  requests: number;
}

/**
 * The city's Wikipedia article (found by name, checked by its coordinates; or by a search near the
 * city when the name is ambiguous), its Wikivoyage article, and the introductions of the two
 * levels of administrative regions above it (Wikidata P131), so highlights of a province count for
 * its cities. Each step that fails leaves the text it has. At most 9 requests, one after another.
 */
export async function fetchPlaceText(city: City, get: GetJson): Promise<PlaceText> {
  let requests = 0;
  const call = async (url: string, label: string): Promise<unknown> => {
    requests++;
    return get(url, label);
  };
  const parts: string[] = [];
  const titles: string[] = [];
  const attempt = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      // The text found so far is still used.
    }
  };

  let qid: string | undefined;
  let cityTitle: string | undefined;
  await attempt(async () => {
    const candidates = [...new Set([city.name, `${city.name}, ${city.country}`, `${city.name} (${city.country})`])];
    const q = qs({ action: "query", titles: candidates.join("|"), redirects: "1", prop: "coordinates|pageprops", ppprop: "wikibase_item|disambiguation", coprimary: "primary", format: "json", formatversion: "2" });
    let page = pickCityPage(pagesOf(await call(`${WP}?${q}`, "Wikipedia")), city);
    if (!page) {
      const g = qs({ action: "query", list: "geosearch", gscoord: `${city.lat}|${city.lng}`, gsradius: "10000", gslimit: "10", gsprop: "type|name", format: "json", formatversion: "2" });
      const hits = ((await call(`${WP}?${g}`, "Wikipedia")) as { query?: { geosearch?: { title: string; type?: string }[] } })?.query?.geosearch ?? [];
      const first = normalizeText(city.name).trim().split(" ")[0] ?? "";
      const hit = hits.find((h) => h.type === "city" && normalizeText(h.title).includes(` ${first}`)) ?? hits.find((h) => normalizeText(h.title).includes(` ${first}`));
      if (hit) {
        const q2 = qs({ action: "query", titles: hit.title, redirects: "1", prop: "pageprops", ppprop: "wikibase_item", format: "json", formatversion: "2" });
        page = pagesOf(await call(`${WP}?${q2}`, "Wikipedia"))[0];
      }
    }
    if (page) {
      cityTitle = page.title;
      qid = page.pageprops?.wikibase_item;
    }
  });

  // Regions: P131 of the city, and of its first region; sitelinks of all of them in one call.
  let voyageTitle: string | undefined;
  const regionWp: string[] = [];
  const regionWv: string[] = [];
  if (qid) {
    await attempt(async () => {
      const level1 = claimIds(await call(`${WD}?${qs({ action: "wbgetclaims", entity: qid!, property: "P131", format: "json" })}`, "Wikidata")).slice(0, 2);
      let level2: string[] = [];
      if (level1[0]) level2 = claimIds(await call(`${WD}?${qs({ action: "wbgetclaims", entity: level1[0], property: "P131", format: "json" })}`, "Wikidata")).slice(0, 1);
      const ids = [qid!, ...level1, ...level2];
      const ent = (await call(`${WD}?${qs({ action: "wbgetentities", ids: ids.join("|"), props: "sitelinks", sitefilter: "enwiki|enwikivoyage", format: "json" })}`, "Wikidata")) as {
        entities?: Record<string, { sitelinks?: { enwiki?: { title: string }; enwikivoyage?: { title: string } } }>;
      };
      const links = (id: string) => ent.entities?.[id]?.sitelinks;
      voyageTitle = links(qid!)?.enwikivoyage?.title;
      for (const id of [...level1, ...level2]) {
        const wp = links(id)?.enwiki?.title;
        const wv = links(id)?.enwikivoyage?.title;
        // A country's own article is not a region of the city.
        if (wp && countryKey(wp) !== countryKey(city.country)) regionWp.push(wp);
        if (wv && countryKey(wv) !== countryKey(city.country)) regionWv.push(wv);
      }
    });
  }

  const extract = async (base: string, label: string, ts: string[], intro: boolean) => {
    const q = qs({ action: "query", prop: "extracts", explaintext: "1", redirects: "1", titles: ts.join("|"), format: "json", formatversion: "2", ...(intro ? { exintro: "1", exlimit: "max" } : { exlimit: "1" }) });
    for (const p of pagesOf(await call(`${base}?${q}`, label))) {
      if (p.extract) {
        parts.push(p.extract);
        titles.push(`${label}:${p.title}`);
      }
    }
  };
  if (cityTitle) await attempt(() => extract(WP, "Wikipedia", [cityTitle!], false));
  if (voyageTitle) await attempt(() => extract(WV, "Wikivoyage", [voyageTitle!], false));
  if (regionWp.length) await attempt(() => extract(WP, "Wikipedia", regionWp, true));
  if (regionWv.length) await attempt(() => extract(WV, "Wikivoyage", regionWv, true));
  return { text: parts.length ? normalizeText(parts.join("\n")) : "", titles, requests };
}
