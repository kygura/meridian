// Shared agent tool core (ADR 0003): plain, never-throwing functions with
// exported zod param schemas. Wrapped as AI SDK tools by the real streamText
// loop in routes/agent.ts; executed directly (same functions, same
// determinism) by the keyless mock chat pipeline; also used by legacy
// /api/agent/research and /api/agent/trip-options where their logic
// genuinely overlaps with a tool (flight pricing).
//
// Contract: every exported tool function is error-shaped, never throws, and
// never logs secrets.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { getCities, getCityById } from "../cities.js";
import { computeFullScore } from "../scoring.js";
import { placeDataInfo, placeFacts, type Fact, type FactGranularity, type PlaceFacts } from "../placeData.js";
import { ensureDataDir } from "../paths.js";
import {
  getFlightEstimate as getRealFlightEstimate,
  hasFlightProvider,
} from "../flightSearch.js";
import { haversineKm } from "../../../src/lib/geo.js";
import type {
  City,
  PlaceResult,
  PlaceImage,
  SeasonalityResult,
  FlightEstimateResult,
} from "../../../src/types.js";

// ── search_places ────────────────────────────────────────────────────

export const searchPlacesParams = z.object({
  query: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  budgetTier: z.enum(["budget", "mid", "premium"]).optional(),
  minScore: z.number().min(0).max(100).optional(),
  limit: z.number().int().min(1).max(8).optional(),
});
export type SearchPlacesParams = z.infer<typeof searchPlacesParams>;

/** Region keyword → country list, shared with the mock chat pipeline. */
export const REGION_COUNTRIES: Record<string, string[]> = {
  asia: ["Japan", "Thailand", "Vietnam", "Indonesia", "Malaysia", "India", "Philippines", "Korea, South", "Taiwan", "Singapore", "Georgia"],
  europe: ["Portugal", "Spain", "Germany", "France", "Netherlands", "Czechia", "Czech Republic", "Poland", "Italy", "Greece", "Estonia", "Croatia"],
  "latin america": ["Mexico", "Colombia", "Argentina", "Brazil", "Chile", "Peru", "Costa Rica", "Uruguay", "Ecuador"],
  africa: ["South Africa", "Kenya", "Morocco", "Egypt", "Ghana", "Tanzania", "Rwanda"],
  equator: ["Indonesia", "Kenya", "Ecuador", "Colombia", "Brazil", "Uganda", "Singapore", "Malaysia"],
};

/** Monthly cost for one person, EUR: below this is "budget", at or above BUDGET_PREMIUM_EUR is "premium". */
export const BUDGET_MID_EUR = 1300;
export const BUDGET_PREMIUM_EUR = 2300;

/** Budget tier from the estimated monthly cost (ADR 0013); null when there is no cost data. */
export function budgetTier(monthlyEur: number | null | undefined): "budget" | "mid" | "premium" | null {
  if (typeof monthlyEur !== "number") return null;
  if (monthlyEur < BUDGET_MID_EUR) return "budget";
  if (monthlyEur < BUDGET_PREMIUM_EUR) return "mid";
  return "premium";
}

const GRAIN_WORDS: Record<FactGranularity, string> = { city: "city figure", region: "regional figure", country: "country figure" };

function toPlaceResult(city: City, score: ReturnType<typeof computeFullScore>, facts: PlaceFacts): PlaceResult {
  const popLabel = city.population > 0 ? `${city.population.toLocaleString()} people` : "population unknown";
  const cost = facts.cost.monthlyEur;
  const net = facts.internet.fixed ?? facts.internet.mobile;
  const bits = [
    popLabel,
    score.overall === null ? "not enough data for a score" : `score ${score.overall} of 100 (${score.parts} of 6 measures)`,
    cost ? `about €${cost.value.toLocaleString("en-US")} a month (estimate, ${GRAIN_WORDS[cost.granularity]})` : "no cost data",
    net ? `${net.downMbps} Mbps${facts.internet.fixed ? "" : " mobile"}` : "no internet data",
  ];
  return {
    cityId: city.id,
    name: city.name,
    country: city.country,
    iata: city.iata,
    lat: city.lat,
    lng: city.lng,
    population: city.population,
    score: score.overall,
    summaryLine: bits.join(" · "),
  };
}

/**
 * Search and rank cities/places by name, country, region, budget tier, or
 * minimum score. Deterministic (ties broken by name) so it's safe to use in
 * both the real tool loop and the keyless mock pipeline.
 */
export async function searchPlaces(params: SearchPlacesParams): Promise<PlaceResult[]> {
  try {
    const limit = Math.max(1, Math.min(params.limit ?? 8, 8));
    let pool: City[] = getCities();

    const query = params.query?.trim().toLowerCase();
    if (query) {
      pool = pool.filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.iata?.toLowerCase() === query ||
          c.country.toLowerCase().includes(query)
      );
    }

    const country = params.country?.trim().toLowerCase();
    if (country) {
      pool = pool.filter((c) => c.country.toLowerCase().includes(country));
    }

    const region = params.region?.trim().toLowerCase();
    if (region) {
      const countries = REGION_COUNTRIES[region];
      if (countries) pool = pool.filter((c) => countries.includes(c.country));
    }

    let scored = pool.map((c) => ({ city: c, score: computeFullScore(c), facts: placeFacts(c) }));

    // Cities without the data a filter needs are left out of that filter, not guessed into it.
    if (params.budgetTier) {
      scored = scored.filter((e) => budgetTier(e.facts.cost.monthlyEur?.value) === params.budgetTier);
    }
    if (typeof params.minScore === "number") {
      const minScore = params.minScore;
      scored = scored.filter((e) => e.score.overall !== null && e.score.overall >= minScore);
    }

    // Scored cities first (best first); cities with too little data for a score go last, by name.
    scored.sort((a, b) => (b.score.overall ?? -1) - (a.score.overall ?? -1) || a.city.name.localeCompare(b.city.name));

    return scored.slice(0, limit).map((e) => toPlaceResult(e.city, e.score, e.facts));
  } catch (err) {
    console.error("[agent/tools] searchPlaces error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ── get_place_facts ──────────────────────────────────────────────────

export const getPlaceFactsParams = z.object({ cityId: z.string() });
export type GetPlaceFactsParams = z.infer<typeof getPlaceFactsParams>;

export interface PlaceFactLine {
  /** What the figure is ("Monthly cost for one person"). */
  label: string;
  /** The figure in words, or "No data". */
  value: string;
  /** "city", "region" or "country": how local the figure is. Absent when there is no data. */
  granularity?: FactGranularity;
  /** The named source and year. Absent when there is no data. */
  source?: string;
  estimate?: boolean;
}

export interface PlaceFactsResult {
  available: boolean;
  cityId?: string;
  name?: string;
  country?: string;
  facts?: PlaceFactLine[];
  /** Labels of the figures there is no data for. */
  gaps?: string[];
  note?: string;
}

/**
 * Measured cost, rent, internet, healthcare, stability and visitor figures for a city, each with
 * its source, year and how local it is. Figures the sources don't have come back as "No data".
 */
export async function getPlaceFacts(params: GetPlaceFactsParams): Promise<PlaceFactsResult> {
  try {
    const city = getCityById(params.cityId);
    if (!city) return { available: false };
    const f = placeFacts(city, (id) => getCityById(id)?.name);
    const { sources, anchor } = placeDataInfo();
    const src = (key: string, year?: number) => `${sources[key]?.name ?? key}${year ? `, ${year}` : ""}`;
    const lines: PlaceFactLine[] = [];
    const add = (label: string, fact: Fact | null, text: (f: Fact) => string) =>
      lines.push(
        fact
          ? { label, value: text(fact), granularity: fact.granularity, source: src(fact.source, fact.year || undefined), ...(fact.estimate ? { estimate: true } : {}) }
          : { label, value: "No data" }
      );
    const eur = (n: number) => `€${n.toLocaleString("en-US")}`;
    add("Monthly cost for one person", f.cost.monthlyEur, (x) => `about ${eur(x.value)} a month, housing included`);
    add("Price level", f.cost.index, (x) => `${x.value} (Belgium = 100, country level)`);
    add("Rent, 1-bedroom flat", f.cost.rent1br, (x) => `${eur(x.value)} a month on average`);
    if (!f.cost.rent1br && f.cost.rentReference)
      add(`Rent, 1-bedroom flat in ${f.cost.rentReference.place}`, f.cost.rentReference, (x) => `${eur(x.value)} a month on average (the capital, not this city)`);
    for (const [label, s] of [["Fixed internet", f.internet.fixed], ["Mobile internet", f.internet.mobile]] as const)
      lines.push(
        s
          ? {
              label,
              value: `${s.downMbps} Mbps down, ${s.upMbps} up, ${s.latencyMs} ms latency (${s.tests.toLocaleString("en-US")} tests within ${s.radiusKm} km)`,
              granularity: "city",
              source: src("internet"),
            }
          : { label, value: "No data" }
      );
    add("Healthcare coverage", f.health.uhc, (x) => `${x.value} of 100 on the WHO service coverage index`);
    add("Physicians", f.health.physicians, (x) => `${x.value} per 1,000 people`);
    add("Hospital beds", f.health.beds, (x) => `${x.value} per 1,000 people`);
    add("Political stability", f.stability.estimate, (x) => `${x.value} on a scale from about -2.5 (worst) to 2.5 (best)`);
    add("Homicides", f.stability.homicides, (x) => `${x.value} per 100,000 people a year`);
    add("Visitors from abroad", f.crowds.arrivalsPerResident, (x) => `${x.value} arrivals per resident a year`);
    add("Tourist nights", f.crowds.nightsPerResident, (x) => `${x.value} nights per resident a year in ${x.place}`);
    const m = f.crowds.months;
    lines.push(
      m
        ? {
            label: "Busiest months",
            value: busiestMonths(m.index),
            granularity: m.granularity,
            source: src(m.source),
          }
        : { label: "Busiest months", value: "No data" }
    );
    return {
      available: true,
      cityId: city.id,
      name: city.name,
      country: city.country,
      facts: lines,
      gaps: lines.filter((l) => l.value === "No data").map((l) => l.label),
      note: anchor
        ? `Monthly cost is an estimate: what a resident of ${anchor.place} spends a month (€${anchor.monthlyEur.toLocaleString("en-US")}, Eurostat ${anchor.y}) repriced at local prices. Country figures apply to every city in the country.`
        : undefined,
    };
  } catch (err) {
    console.error("[agent/tools] getPlaceFacts error:", err instanceof Error ? err.message : String(err));
    return { available: false };
  }
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jul, Aug, Jun (Jul is 2.1x an average month)". */
export function busiestMonths(index: number[]): string {
  const ranked = index.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const top = ranked.slice(0, 3);
  return `${top.map((t) => MONTH_SHORT[t.i]).join(", ")} (${MONTH_SHORT[top[0]!.i]} is ${(top[0]!.v / 100).toFixed(1)}x an average month)`;
}

// ── get_place_images ─────────────────────────────────────────────────

export const getPlaceImagesParams = z.object({
  cityId: z.string().optional(),
  title: z.string().optional(),
  limit: z.number().int().min(1).max(4).optional(),
});
export type GetPlaceImagesParams = z.infer<typeof getPlaceImagesParams>;

const WIKI_USER_AGENT = "Meridian/2.0 (personal travel app)";
const IMAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface ImageCacheFile {
  cachedAt: string;
  images: PlaceImage[];
}

function slugifyCacheKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

function imageCachePath(key: string): string {
  const dir = ensureDataDir("cache", "images");
  return join(dir, `${key}.json`);
}

function readImageCache(key: string): PlaceImage[] | null {
  try {
    const p = imageCachePath(key);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as ImageCacheFile;
    const age = Date.now() - new Date(raw.cachedAt).getTime();
    if (!Number.isFinite(age) || age > IMAGE_CACHE_TTL_MS) return null;
    if (!Array.isArray(raw.images)) return null;
    return raw.images;
  } catch {
    return null;
  }
}

function writeImageCache(key: string, images: PlaceImage[]): void {
  try {
    const payload: ImageCacheFile = { cachedAt: new Date().toISOString(), images };
    writeFileSync(imageCachePath(key), JSON.stringify(payload, null, 2));
  } catch {
    // Disk cache is best-effort; never fail the tool over a write error.
  }
}

async function fetchWikipediaSummary(title: string): Promise<PlaceImage[]> {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": WIKI_USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const img = data?.originalimage ?? data?.thumbnail;
    if (!img?.source) return [];
    const pageUrl =
      data?.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    return [
      {
        url: img.source,
        thumbUrl: data?.thumbnail?.source ?? img.source,
        title: data?.title ?? title,
        attribution: "Wikipedia",
        sourcePage: pageUrl,
      },
    ];
  } catch {
    return [];
  }
}

async function fetchCommonsGeosearch(lat: number, lng: number, limit: number): Promise<PlaceImage[]> {
  try {
    const searchUrl = new URL("https://commons.wikimedia.org/w/api.php");
    searchUrl.searchParams.set("action", "query");
    searchUrl.searchParams.set("list", "geosearch");
    searchUrl.searchParams.set("gscoord", `${lat}|${lng}`);
    searchUrl.searchParams.set("gsradius", "10000");
    searchUrl.searchParams.set("gsnamespace", "6"); // File namespace
    searchUrl.searchParams.set("gslimit", String(Math.min(limit * 3, 20)));
    searchUrl.searchParams.set("format", "json");

    const searchRes = await fetch(searchUrl, {
      headers: { "User-Agent": WIKI_USER_AGENT, Accept: "application/json" },
    });
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json();
    const hits: Array<{ pageid: number; title: string }> = searchData?.query?.geosearch ?? [];
    if (!hits.length) return [];

    const pageIds = hits.map((h) => h.pageid).slice(0, limit * 3).join("|");
    const infoUrl = new URL("https://commons.wikimedia.org/w/api.php");
    infoUrl.searchParams.set("action", "query");
    infoUrl.searchParams.set("pageids", pageIds);
    infoUrl.searchParams.set("prop", "imageinfo");
    infoUrl.searchParams.set("iiprop", "url|extmetadata");
    infoUrl.searchParams.set("iiurlwidth", "800");
    infoUrl.searchParams.set("format", "json");

    const infoRes = await fetch(infoUrl, {
      headers: { "User-Agent": WIKI_USER_AGENT, Accept: "application/json" },
    });
    if (!infoRes.ok) return [];
    const infoData = await infoRes.json();
    const pages = infoData?.query?.pages ?? {};

    const images: PlaceImage[] = [];
    for (const key of Object.keys(pages)) {
      const page = pages[key];
      const info = page?.imageinfo?.[0];
      if (!info?.url) continue;
      const artist = info?.extmetadata?.Artist?.value as string | undefined;
      const attribution = artist ? stripHtml(artist) : "Wikimedia Commons";
      const title = String(page?.title ?? "").replace(/^File:/, "");
      images.push({
        url: info.url,
        thumbUrl: info.thumburl ?? info.url,
        title,
        attribution,
        sourcePage: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
      });
      if (images.length >= limit) break;
    }
    return images;
  } catch {
    return [];
  }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim() || "Wikimedia Commons";
}

/**
 * Wikipedia page-summary image first, Wikimedia Commons geosearch fallback
 * for extra images. Disk-cached per cityId (or slugified title) for 7 days.
 * Never throws — returns [] on any failure or missing image.
 */
export async function getPlaceImages(params: GetPlaceImagesParams): Promise<PlaceImage[]> {
  try {
    const limit = Math.max(1, Math.min(params.limit ?? 4, 4));

    let city: City | undefined;
    let title = params.title?.trim();
    let cacheKey: string | undefined;

    if (params.cityId) {
      city = getCityById(params.cityId);
      if (!city) return [];
      cacheKey = params.cityId;
      if (!title) title = `${city.name}, ${city.country}`;
    } else if (title) {
      cacheKey = slugifyCacheKey(title);
    } else {
      return [];
    }

    if (cacheKey) {
      const cached = readImageCache(cacheKey);
      if (cached) return cached.slice(0, limit);
    }

    const images = await fetchWikipediaSummary(title!);
    if (images.length < limit && city) {
      const seen = new Set(images.map((i) => i.url));
      const extra = await fetchCommonsGeosearch(city.lat, city.lng, limit - images.length + 2);
      for (const img of extra) {
        if (images.length >= limit) break;
        if (seen.has(img.url)) continue;
        images.push(img);
        seen.add(img.url);
      }
    }

    const result = images.slice(0, limit);
    if (cacheKey) writeImageCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[agent/tools] getPlaceImages error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ── get_seasonality ──────────────────────────────────────────────────

export const getSeasonalityParams = z.object({
  cityId: z.string(),
});
export type GetSeasonalityParams = z.infer<typeof getSeasonalityParams>;

/**
 * Lazy-loads server/lib/seasonality.ts (built by a separate worker; may not
 * exist yet). Uses a non-literal import specifier so tsc does not try to
 * resolve the module at typecheck time. Never throws — {available:false}
 * when the module, data file, or city entry is missing.
 */
export async function getSeasonality(params: GetSeasonalityParams): Promise<SeasonalityResult> {
  try {
    const seasonalityModulePath = "../seasonality.js";
    const mod: any = await import(seasonalityModulePath).catch(() => null);
    if (!mod || typeof mod.getCitySeasonality !== "function") {
      return { available: false };
    }
    const result = await mod.getCitySeasonality(params.cityId);
    // getCitySeasonality returns MonthSeasonality[] | undefined directly;
    // tolerate a {months: [...]} wrapper shape too in case that ever changes.
    const months = Array.isArray(result) ? result : Array.isArray(result?.months) ? result.months : null;
    if (!months) {
      return { available: false };
    }
    return { available: true, months };
  } catch {
    return { available: false };
  }
}

// ── get_flight_estimate ──────────────────────────────────────────────

export const getFlightEstimateParams = z.object({
  originIata: z.string().length(3),
  destinationIata: z.string().length(3),
  departureDate: z.string().optional(),
});
export type GetFlightEstimateParams = z.infer<typeof getFlightEstimateParams>;

function seededRand(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000;
}

function defaultFutureDate(): string {
  return new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
}

function findCityByIata(iata: string): City | undefined {
  const wanted = iata.toUpperCase();
  return getCities().find((c) => c.iata === wanted);
}

/** Deterministic placeholder pricing — same formula family as the legacy
 * trip-options estimator, keyed by the IATA pair + date so it's stable. */
function mockFlightEstimate(originIata: string, destinationIata: string, departureDate: string): FlightEstimateResult {
  const o = findCityByIata(originIata);
  const d = findCityByIata(destinationIata);
  const km = o && d ? haversineKm([o.lng, o.lat], [d.lng, d.lat]) : 3000;
  const seed = `${originIata.toUpperCase()}-${destinationIata.toUpperCase()}-${departureDate}`;
  const r = seededRand(seed);
  const base = 60 + km * 0.045;
  const priceAmount = Math.round((base + r * base * 0.5) / 5) * 5;
  return { priceAmount, currency: "USD", source: "mock" };
}

/**
 * Wraps the existing real flight providers (Duffel/SerpAPI via
 * flightSearch.ts); falls back to a deterministic mock estimate when no
 * provider is configured or the real lookup comes back empty. Never throws.
 */
export async function getFlightEstimate(params: GetFlightEstimateParams): Promise<FlightEstimateResult> {
  const departureDate = params.departureDate ?? defaultFutureDate();
  const originIata = params.originIata.toUpperCase();
  const destinationIata = params.destinationIata.toUpperCase();

  try {
    if (hasFlightProvider()) {
      const real = await getRealFlightEstimate({ originIata, destinationIata, departureDate });
      if (real) {
        return {
          priceAmount: Math.round(real.priceAmount),
          currency: real.currency,
          airline: real.airline,
          departingAt: real.departingAt,
          arrivingAt: real.arrivingAt,
          source: real.source,
          dealRating: real.dealRating,
        };
      }
    }
  } catch (err) {
    console.error("[agent/tools] getFlightEstimate provider error:", err instanceof Error ? err.message : String(err));
  }

  return mockFlightEstimate(originIata, destinationIata, departureDate);
}
