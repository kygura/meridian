import { Hono } from "hono";
import { fetchAllNews } from "../lib/rss.js";
import { existsSync } from "fs";
import { readFileSync } from "fs";
import { join } from "path";
import { ensureDataDir } from "../lib/paths.js";
import type { TickerItem } from "../../src/types.js";

const news = new Hono();

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
