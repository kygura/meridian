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

function budgetTierFromEconomics(economics: number): "budget" | "mid" | "premium" {
  if (economics >= 65) return "budget";
  if (economics >= 35) return "mid";
  return "premium";
}

function tierLabel(tier: "budget" | "mid" | "premium"): string {
  if (tier === "budget") return "Budget-friendly";
  if (tier === "premium") return "Premium cost";
  return "Mid-range cost";
}

function toPlaceResult(city: City, score: ReturnType<typeof computeFullScore>): PlaceResult {
  const tier = budgetTierFromEconomics(score.economics);
  const popLabel = city.population > 0 ? `${city.population.toLocaleString()} people` : "population unknown";
  return {
    cityId: city.id,
    name: city.name,
    country: city.country,
    iata: city.iata,
    lat: city.lat,
    lng: city.lng,
    population: city.population,
    score: score.overall,
    summaryLine: `${popLabel} · Meridian score ${score.overall}/100 · ${tierLabel(tier)}`,
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

    let scored = pool.map((c) => ({ city: c, score: computeFullScore(c) }));

    if (params.budgetTier) {
      scored = scored.filter((e) => budgetTierFromEconomics(e.score.economics) === params.budgetTier);
    }
    if (typeof params.minScore === "number") {
      const minScore = params.minScore;
      scored = scored.filter((e) => e.score.overall >= minScore);
    }

    scored.sort((a, b) => b.score.overall - a.score.overall || a.city.name.localeCompare(b.city.name));

    return scored.slice(0, limit).map((e) => toPlaceResult(e.city, e.score));
  } catch (err) {
    console.error("[agent/tools] searchPlaces error:", err instanceof Error ? err.message : String(err));
    return [];
  }
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
    if (!result || !Array.isArray(result.months)) {
      return { available: false };
    }
    return { available: true, months: result.months };
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
