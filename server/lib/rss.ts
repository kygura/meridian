import { XMLParser } from "fast-xml-parser";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { ensureDataDir } from "./paths.js";

export interface NewsItem {
  glyph: "alert" | "hazard" | "info" | "good";
  location: string;
  text: string;
  time: string;
  source: string;
  url: string;
  pubDate: string;
}

const CACHE_PATH = join(ensureDataDir("cache"), "rss-news.json");
const CACHE_TTL = 15 * 60 * 1000; // 15 min

const RSS_FEEDS = [
  {
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    source: "BBC",
  },
  {
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    source: "NYT",
  },
  {
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    source: "ALJAZEERA",
  },
];

const GLYPH_KEYWORDS: Record<NewsItem["glyph"], string[]> = {
  alert: [
    "war", "conflict", "attack", "bombing", "strike", "military", "invasion",
    "shelling", "ceasefire", "casualties", "killed", "troops", "missile",
    "explosion", "riot", "protest", "crackdown", "sanctions", "crisis",
  ],
  hazard: [
    "earthquake", "typhoon", "hurricane", "flood", "wildfire", "volcano",
    "drought", "landslide", "tsunami", "storm", "tornado", "cyclone",
    "evacuation", "disaster", "eruption", "heatwave", "blizzard",
  ],
  good: [
    "peace", "deal", "agreement", "growth", "recovery", "surplus", "boost",
    "breakthrough", "reform", "investment", "innovation", "renewable",
    "freedom", "victory", "record", "milestone", "launch", "restore",
  ],
  info: [],
};

function classifyGlyph(title: string): NewsItem["glyph"] {
  const lower = title.toLowerCase();
  let best: NewsItem["glyph"] = "info";
  let bestScore = 0;
  for (const [glyph, keywords] of Object.entries(GLYPH_KEYWORDS) as [NewsItem["glyph"], string[]][]) {
    const score = keywords.filter((k) => lower.includes(k)).length;
    if (score > bestScore) {
      bestScore = score;
      best = glyph;
    }
  }
  return best;
}

function extractLocation(title: string): string {
  const lower = title.toLowerCase();

  // Known country and region names to scan for (most common / newsworthy)
  const LOCATIONS: [RegExp, string][] = [
    [/united states|america|us\s|u\.s\./i, "US"],
    [/ukraine/i, "UKRAINE"],
    [/russia|kremlin|moscow/i, "RUSSIA"],
    [/china|beijing|shanghai/i, "CHINA"],
    [/israel|gaza|tel aviv/i, "ISRAEL"],
    [/iran|tehran/i, "IRAN"],
    [/india|delhi|mumbai/i, "INDIA"],
    [/japan|tokyo/i, "JAPAN"],
    [/south korea|seoul/i, "S.KOREA"],
    [/north korea|pyongyang/i, "N.KOREA"],
    [/germany|berlin/i, "GERMANY"],
    [/france|paris/i, "FRANCE"],
    [/united kingdom|britain|london/i, "UK"],
    [/brazil|são paulo|rio/i, "BRAZIL"],
    [/australia|sydney|melbourne/i, "AUSTRALIA"],
    [/canada|toronto|ottawa/i, "CANADA"],
    [/italy|rome|milan/i, "ITALY"],
    [/spain|madrid|barcelona/i, "SPAIN"],
    [/mexico|mexico city/i, "MEXICO"],
    [/turkey|istanbul|ankara/i, "TURKEY"],
    [/saudi arabia|riyadh/i, "SAUDI"],
    [/egypt|cairo/i, "EGYPT"],
    [/pakistan|islamabad|karachi/i, "PAKISTAN"],
    [/indonesia|jakarta/i, "INDONESIA"],
    [/thailand|bangkok/i, "THAILAND"],
    [/philippines|manila/i, "PHILIPPINES"],
    [/nigeria|lagos|abuja/i, "NIGERIA"],
    [/south africa|cape town|johannesburg/i, "S.AFRICA"],
    [/kenya|nairobi/i, "KENYA"],
    [/colombia|bogotá/i, "COLOMBIA"],
    [/argentina|buenos aires/i, "ARGENTINA"],
    [/sudan|khartoum/i, "SUDAN"],
    [/myanmar|yangon/i, "MYANMAR"],
    [/syria|damascus/i, "SYRIA"],
    [/iraq|baghdad/i, "IRAQ"],
    [/afghanistan|kabul/i, "AFGHANISTAN"],
    [/lebanon|beirut/i, "LEBANON"],
    [/yemen|aden/i, "YEMEN"],
    [/ethiopia|addis ababa/i, "ETHIOPIA"],
    [/taiwan|taipei/i, "TAIWAN"],
    [/iceland|reykjavik/i, "ICELAND"],
    [/europe|european union|eu\b/i, "EUROPE"],
    [/asia|pacific/i, "ASIA"],
    [/africa/i, "AFRICA"],
    [/middle east/i, "MIDEAST"],
    [/caribbean/i, "CARIBBEAN"],
  ];

  for (const [re, label] of LOCATIONS) {
    if (re.test(title)) return label;
  }

  return "WORLD";
}

function relativeTime(dateStr: string): string {
  try {
    const then = new Date(dateStr).getTime();
    const diff = Date.now() - then;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  } catch {
    return "—";
  }
}

function truncate(text: string, max = 80): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

async function fetchFeed(feed: (typeof RSS_FEEDS)[number]): Promise<NewsItem[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: { "User-Agent": "Meridian/2.0 (RSS Reader)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const xml = await res.text();
    const parsed = parser.parse(xml);

    const items: Array<{ title?: string; pubDate?: string; link?: string }> =
      parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];

    const arr = Array.isArray(items) ? items : [items];

    return arr
      .filter((it) => it.title && typeof it.title === "string")
      .slice(0, 10)
      .map((it) => {
        const title = it.title as string;
        return {
          glyph: classifyGlyph(title),
          location: extractLocation(title),
          text: truncate(title),
          time: relativeTime(it.pubDate ?? ""),
          source: feed.source,
          url: (it.link as string | undefined) ?? "",
          pubDate: it.pubDate ?? new Date().toISOString(),
        };
      });
  } catch {
    return [];
  }
}

export async function fetchAllNews(): Promise<NewsItem[]> {
  // Check cache
  if (existsSync(CACHE_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
      if (Date.now() - cached.fetchedAt < CACHE_TTL) {
        return cached.items as NewsItem[];
      }
    } catch {
      // Corrupted, re-fetch
    }
  }

  const results = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));
  const items = results
    .filter((r): r is PromiseFulfilledResult<NewsItem[]> => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .sort(
      (a, b) =>
        new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
    );

  // Cache
  try {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ fetchedAt: Date.now(), items }, null, 2)
    );
  } catch {
    // Cache write failed, non-critical
  }

  return items;
}
