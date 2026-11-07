import { Hono } from "hono";
import { fetchAllNews } from "../lib/rss.js";
import { getPlaceNews } from "../lib/placeNews.js";
import { getNewsBrief } from "../lib/newsBrief.js";
import { advisoriesForCountry } from "../lib/phenomena.js";
import { getCityById } from "../lib/cities.js";
import { existsSync } from "fs";
import { readFileSync } from "fs";
import { join } from "path";
import { ensureDataDir } from "../lib/paths.js";
import type { TickerItem } from "../../src/types.js";

const news = new Hono();

/**
 * GET /api/news/place?cityId= - headlines about a city and its country, tagged by risk
 * topic, with "watch" flags and the curated advisories for that country.
 * available=false when the news search is unreachable (advisories still come back).
 */
news.get("/place", async (c) => {
  const cityId = c.req.query("cityId") ?? "";
  const city = getCityById(cityId);
  if (!city) return c.json({ error: `City '${cityId}' not found` }, 404);
  const place = await getPlaceNews(city.name, city.country);
  return c.json({ cityId, city: city.name, country: city.country, ...place, advisories: advisoriesForCountry(city.country) });
});

/**
 * GET /api/news/brief?cityId= - a neutral briefing written from the place's headlines
 * (a cheap model with OPENAI_API_KEY, rules without), citing numbered sources.
 * Separate from /place so the panel isn't held up by the model.
 */
news.get("/brief", async (c) => {
  const cityId = c.req.query("cityId") ?? "";
  const city = getCityById(cityId);
  if (!city) return c.json({ error: `City '${cityId}' not found` }, 404);
  const place = await getPlaceNews(city.name, city.country);
  if (!place.available) return c.json({ cityId, available: false });
  return c.json({ cityId, available: true, brief: await getNewsBrief(city.name, city.country, place) });
});

const CACHE_PATH = join(ensureDataDir("cache"), "rss-news.json");
const FALLBACK_TTL = 60 * 60 * 1000; // 1h fallback if RSS fails

const MOCK_TICKER: TickerItem[] = [
  { glyph: "alert", location: "UKRAINE", text: "Air-defense activity around Kyiv overnight.", time: "12m" },
  { glyph: "hazard", location: "PHILIPPINES", text: "Typhoon approaching N. Luzon.", time: "23m" },
  { glyph: "info", location: "JAPAN", text: "Yen weakens; tourism at 12-month high.", time: "47m" },
  { glyph: "good", location: "ICELAND", text: "Aurora Kp7 forecast this week.", time: "1h" },
  { glyph: "alert", location: "SUDAN", text: "Khartoum corridor remains restricted.", time: "1h" },
];

news.get("/", async (c) => {
  try {
    const items = await fetchAllNews();
    if (items.length === 0) {
      return c.json(MOCK_TICKER);
    }
    // Convert NewsItem to TickerItem
    const ticker: TickerItem[] = items.map((it) => ({
      glyph: it.glyph,
      location: it.location,
      text: it.text,
      time: it.time,
      source: it.source,
      url: it.url,
    }));
    return c.json(ticker);
  } catch {
    // Try stale cache
    if (existsSync(CACHE_PATH)) {
      try {
        const cached = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
        if (Date.now() - cached.fetchedAt < FALLBACK_TTL) {
          return c.json(
            (cached.items).map((it: Record<string, string>) => ({
              glyph: it.glyph,
              location: it.location,
              text: it.text,
              time: it.time,
              source: it.source,
              url: it.url,
            }))
          );
        }
      } catch {
        // Corrupted cache
      }
    }
    return c.json(MOCK_TICKER);
  }
});

export default news;
