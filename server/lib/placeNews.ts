import { XMLParser } from "fast-xml-parser";
import { detectIssues, LABOUR_STRIKE, type NewsIssue } from "./newsIssues.js";

// Headlines about one place: the city itself and its country, from Google News search
// RSS, each tagged with the travel-risk topics it touches (transport, safety, unrest,
// governance, health, utilities, hazard, conflict). Topics that keep coming up become
// "watch" flags for the city panel. Cached in memory per place.

export type NewsTopic = "transport" | "safety" | "unrest" | "governance" | "health" | "utilities" | "hazard" | "conflict";

export interface PlaceNewsItem {
  title: string;
  source: string;
  url: string;
  pubDate: string;
  /** Matched the city query or only the country one. */
  scope: "city" | "country";
  topics: NewsTopic[];
  /** 1 = background, 2 = disruption, 3 = deaths or major harm. */
  severity: 1 | 2 | 3;
  /** The headline names the city or country (search hits can be about somewhere else). */
  mentions?: boolean;
}

export interface NewsFlag {
  topic: NewsTopic;
  count: number;
  severity: 1 | 2 | 3;
  /** Most severe, then latest, matching headline. */
  headline: string;
  url: string;
  latest: string;
}

export interface PlaceNews {
  available: boolean;
  items: PlaceNewsItem[];
  flags: NewsFlag[];
  /** Systemic problems detected from the headlines (see newsIssues.ts). */
  issues: NewsIssue[];
}

export const TOPIC_LABELS: Record<NewsTopic, string> = {
  transport: "Transport",
  safety: "Crime and safety",
  unrest: "Strikes and unrest",
  governance: "Politics and corruption",
  health: "Health",
  utilities: "Power and water",
  hazard: "Natural hazards",
  conflict: "Conflict",
};

// Whole words (plural "s"/"es" allowed); a trailing "*" makes a stem ("rail*" hits
// "railway", never "trail").
const TOPIC_WORDS: Record<NewsTopic, string[]> = {
  transport: ["train", "rail*", "derail*", "metro", "subway", "tram", "high-speed", "airport", "flight", "airline", "runway", "ferry", "bridge collapse", "motorway", "highway", "bus crash", "renfe", "adif", "air traffic"],
  safety: ["crime", "murder*", "shooting", "stabbing", "robber*", "theft", "pickpocket", "kidnap*", "terror*", "gang", "cartel", "homicide", "assault", "scam"],
  unrest: ["protest*", "riot*", "walkout", "curfew", "unrest", "demonstration", "clashes", "blockade", "state of emergency"],
  governance: ["corruption", "bribe", "scandal", "indicted", "indictment", "fraud", "embezzl*", "resign*", "graft", "kickback", "coup", "impeach*"],
  health: ["outbreak", "epidemic", "cholera", "dengue", "measles", "malaria", "virus", "infection", "pandemic", "contaminat*", "food poisoning"],
  utilities: ["blackout", "power cut", "power outage", "outage", "water shortage", "drought restrictions", "rationing", "grid failure", "fuel shortage"],
  hazard: ["earthquake", "flood", "wildfire", "storm", "hurricane", "typhoon", "cyclone", "heatwave", "landslide", "tsunami", "volcano", "eruption", "tornado", "avalanche", "dana"],
  conflict: ["war", "missile", "airstrike", "shelling", "invasion", "troops", "drone attack", "ceasefire", "bombing"],
};

const HARM_WORDS = ["dead", "death", "die", "died", "kill*", "fatal*", "victim", "toll", "crash", "collision", "derail*", "massacre"];
const DISRUPT_WORDS = ["cancel*", "suspend*", "delay*", "closed", "closure", "halt*", "disrupt*", "evacuat*", "warning", "alert", "shortage", "chaos", "injur*"];

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = new Map<string, RegExp>();
function hasWord(text: string, w: string): boolean {
  let re = patterns.get(w);
  if (!re) {
    const stem = w.endsWith("*");
    const body = escape(stem ? w.slice(0, -1) : w);
    re = new RegExp(`(^|[^a-z])${body}${stem ? "" : "(e?s)?(?![a-z])"}`);
    patterns.set(w, re);
  }
  return re.test(text);
}

export function classifyHeadline(title: string): { topics: NewsTopic[]; severity: 1 | 2 | 3 } {
  const t = title.toLowerCase();
  const topics = (Object.keys(TOPIC_WORDS) as NewsTopic[]).filter((topic) => TOPIC_WORDS[topic].some((w) => hasWord(t, w)));
  const labour = LABOUR_STRIKE.test(t);
  if (labour && !topics.includes("unrest")) topics.push("unrest");
  const harm = HARM_WORDS.some((w) => hasWord(t, w));
  const disrupt = labour || DISRUPT_WORDS.some((w) => hasWord(t, w));
  const severity: 1 | 2 | 3 = topics.length && harm ? 3 : topics.length && disrupt ? 2 : 1;
  return { topics, severity };
}

/** Topics with a deadly headline, or that recur (2+ headlines with at least a disruption). */
export function buildFlags(items: PlaceNewsItem[]): NewsFlag[] {
  const by = new Map<NewsTopic, PlaceNewsItem[]>();
  for (const it of items) if (it.mentions !== false) for (const topic of it.topics) by.set(topic, [...(by.get(topic) ?? []), it]);
  const flags: NewsFlag[] = [];
  for (const [topic, list] of by) {
    const severity = Math.max(...list.map((i) => i.severity)) as 1 | 2 | 3;
    if (severity < 3 && !(list.length >= 2 && severity >= 2)) continue;
    const top = [...list].sort((a, b) => b.severity - a.severity || Date.parse(b.pubDate) - Date.parse(a.pubDate))[0]!;
    const latest = list.reduce((m, i) => (Date.parse(i.pubDate) > Date.parse(m) ? i.pubDate : m), list[0]!.pubDate);
    flags.push({ topic, count: list.length, severity, headline: top.title, url: top.url, latest });
  }
  return flags.sort((a, b) => b.severity - a.severity || b.count - a.count);
}

const parser = new XMLParser({ ignoreAttributes: false });
const FETCH_TIMEOUT_MS = 8000;

/** Google News titles end with " - Publisher". */
function splitSource(title: string): { title: string; source: string } {
  const i = title.lastIndexOf(" - ");
  return i > 20 ? { title: title.slice(0, i).trim(), source: title.slice(i + 3).trim() } : { title, source: "" };
}

export function parseFeed(xml: string, scope: PlaceNewsItem["scope"]): PlaceNewsItem[] {
  const parsed = parser.parse(xml) as { rss?: { channel?: { item?: unknown } } };
  const raw = parsed?.rss?.channel?.item;
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<{ title?: unknown; link?: unknown; pubDate?: unknown; source?: unknown }>;
  const out: PlaceNewsItem[] = [];
  for (const it of list) {
    if (typeof it.title !== "string") continue;
    const { title, source } = splitSource(it.title);
    const src = typeof it.source === "string" ? it.source : (it.source as { "#text"?: string } | undefined)?.["#text"];
    out.push({
      title,
      source: src || source,
      url: typeof it.link === "string" ? it.link : "",
      pubDate: typeof it.pubDate === "string" ? new Date(it.pubDate).toISOString() : new Date().toISOString(),
      scope,
      ...classifyHeadline(title),
    });
  }
  return out;
}

function searchUrl(q: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Meridian/2.0 (RSS Reader)" } });
    if (!res.ok) throw new Error(`news ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Match reports and fixtures crowd out everything else on a city search.
const SPORTS = /\b(vs\.?|v\.?|odds|goals?|futsal|squad|edge out|thriller|la liga|premier league|champions league|europa league|serie a|bundesliga|ryder cup|grand prix|world cup|nba|nfl|fixture|kick-off|kickoff|scoreline|transfer window|striker|goalkeeper|derby|semi-final|quarter-final|live stream(ing)?|how to watch)\b/i;

const SPORTS_EXTRA = /\b(real madrid|atl[eé]tico|fc barcelona|barça|signing|trade deadline|playoffs?|matchday|olympic)\b/i;
const SPORTS_SOURCE = /sport|score|espn|marca|goal\.com|\bas\.com/i;

export function isSports(title: string, source = ""): boolean {
  return SPORTS.test(title) || SPORTS_EXTRA.test(title) || SPORTS_SOURCE.test(source);
}

/** Simple name forms for headline matching: "Korea, South" -> "south korea" and "korea". */
function nameForms(name: string): string[] {
  const n = name.toLowerCase().replace(/\(.*?\)/g, "").trim();
  const parts = n.split(",").map((p) => p.trim()).filter(Boolean);
  const forms = new Set([n, ...(parts.length === 2 ? [`${parts[1]} ${parts[0]}`, parts[0]!] : [])]);
  return [...forms].filter((f) => f.length >= 3);
}

// Deadly events over a year, so an incident months back still counts toward a pattern.
const DEADLY_TERMS = "(crash OR derailment OR collision OR collapse OR explosion OR fire OR outbreak OR shooting OR sinking) (killed OR dead OR deaths OR toll)";

const RISK_TERMS = "(crash OR derailment OR strike OR protest OR outage OR blackout OR corruption OR outbreak OR flood OR wildfire OR earthquake OR shooting OR evacuation)";

const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; value: PlaceNews }>();

/** Test-only. */
export function resetPlaceNewsCache(): void {
  cache.clear();
}

/**
 * City headlines (14 days), country headlines (14 days), country risk headlines
 * (90 days) and deadly-incident headlines (1 year, for issue detection). Deduped by title,
 * newest first. Network failure -> { available: false } (never cached).
 */
export async function getPlaceNews(city: string, country: string, now = Date.now()): Promise<PlaceNews> {
  const key = `${city}|${country}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const sameName = city.toLowerCase() === country.toLowerCase();
  const queries: [string, PlaceNewsItem["scope"]][] = [
    ...(sameName ? [] : ([[`"${city}" ${country} when:14d`, "city"]] as [string, PlaceNewsItem["scope"]][])),
    [`"${country}" when:14d`, "country"],
    [`"${country}" ${RISK_TERMS} when:90d`, "country"],
    [`"${country}" ${DEADLY_TERMS} when:1y`, "country"],
  ];
  const results = await Promise.allSettled(queries.map(([q, scope]) => fetchText(searchUrl(q)).then((xml) => parseFeed(xml, scope))));
  if (results.every((r) => r.status === "rejected")) return { available: false, items: [], flags: [], issues: [] };

  const names = [...nameForms(city), ...nameForms(country)].map(
    (n) => new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u")
  );
  const seen = new Set<string>();
  const items: PlaceNewsItem[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const it of r.value) {
      const k = it.title.toLowerCase();
      if (seen.has(k) || isSports(it.title, it.source)) continue;
      seen.add(k);
      // Whole-name match: "Japan" must not match "Japanese" (news about Japanese abroad).
      items.push({ ...it, mentions: names.some((n) => n.test(k)) });
    }
  }
  items.sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
  const value: PlaceNews = { available: true, items: items.slice(0, 60), flags: buildFlags(items), issues: detectIssues(items) };
  cache.set(key, { at: now, value });
  return value;
}
