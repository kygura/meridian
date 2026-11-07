import { createHash } from "crypto";
import type { NewsIssue } from "./newsIssues.js";
import type { PlaceNews } from "./placeNews.js";

// A short, neutral briefing for a place, written by a cheap model from its headlines, so
// the panel shows facts instead of the headlines' own wording. Claims cite numbered
// sources that the panel lists at the bottom. Without OPENAI_API_KEY (or if the model
// fails) the briefing is assembled from the detected issues by rules instead.

export interface BriefSource {
  n: number;
  source: string;
  url: string;
  pubDate: string;
  /** Kept for the link's tooltip; the panel does not print it. */
  title: string;
}

export interface BriefPoint {
  title: string;
  level?: NewsIssue["level"];
  text: string;
  /** Source numbers backing the point. */
  sources: number[];
}

export interface NewsBrief {
  overview: string;
  points: BriefPoint[];
  sources: BriefSource[];
  /** "model" when written by the language model, "rules" for the keyless fallback. */
  by: "model" | "rules";
  generatedAt: string;
}

/** Generates the JSON text for a prompt. Swappable in tests. */
export type BriefGenerator = (system: string, prompt: string) => Promise<string>;

const MAX_SOURCES = 24;
const MAX_POINTS = 5;

/** Issue headlines first (they back the points), then flagged and recent items that name the place. */
export function pickSources(place: PlaceNews): BriefSource[] {
  const picked: { title: string; url: string; pubDate: string; source: string }[] = [];
  const seen = new Set<string>();
  const add = (it: { title: string; url: string; pubDate: string; source: string }) => {
    if (picked.length >= MAX_SOURCES || seen.has(it.title)) return;
    seen.add(it.title);
    picked.push(it);
  };
  for (const issue of place.issues) for (const h of issue.headlines) add(h);
  const named = place.items.filter((i) => i.mentions !== false);
  for (const it of named.filter((i) => i.severity >= 2)) add(it);
  const recent = [...named].sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
  for (const it of recent.slice(0, 12)) add(it);
  return picked.map((p, i) => ({ n: i + 1, source: p.source, url: p.url, pubDate: p.pubDate, title: p.title }));
}

export const SYSTEM_PROMPT = `You write short, neutral travel briefings about a place from a list of news headlines.

Rules:
- Plain, factual language. No sensational or loaded words (for example: horror, chaos, slams, shock, nightmare, carnage, fury, blasts, devastating). Do not repeat a headline's wording when a plainer phrasing exists.
- Only state what the headlines support. Attribute contested claims ("investigators are examining", "reports say"). Give numbers as reported and say when sources differ.
- Focus on what matters to a visitor: safety, transport, strikes, health, utilities, public order, and the institutional response (investigations, resignations, funding probes).
- Every point cites the numbers of the sources it relies on.
- If nothing travel-relevant stands out, say so in the overview and return no points.

Reply with JSON only, no code fences:
{"overview": "2-3 sentences", "points": [{"title": "short subject, e.g. Rail safety", "level": "systemic|incident|recurring", "text": "1-3 sentences", "sources": [1, 2]}]}
At most ${MAX_POINTS} points, most important first.`;

export function buildPrompt(city: string, country: string, issues: NewsIssue[], sources: BriefSource[], today = new Date()): string {
  const byTitle = new Map(sources.map((s) => [s.title, s.n]));
  const issueLines = issues.length
    ? issues
        .map((i) => {
          const refs = i.headlines.map((h) => byTitle.get(h.title)).filter(Boolean);
          return `- ${i.label} (${i.level}): ${i.summary} Sources: ${refs.map((r) => `[${r}]`).join(" ")}`;
        })
        .join("\n")
    : "- none detected";
  const sourceLines = sources.map((s) => `[${s.n}] (${s.source || "unknown"}, ${s.pubDate.slice(0, 10)}) ${s.title}`).join("\n");
  return `Place: ${city}, ${country}. Today: ${today.toISOString().slice(0, 10)}.

Issues detected automatically from the coverage (may contain errors; check them against the headlines):
${issueLines}

Headlines:
${sourceLines}`;
}

/** Parse and sanity-check the model's JSON: drop unknown citations and empty points. */
export function parseBrief(text: string, sourceCount: number): { overview: string; points: BriefPoint[] } | null {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const r = raw as { overview?: unknown; points?: unknown };
  if (typeof r.overview !== "string" || !r.overview.trim()) return null;
  const levels = new Set(["systemic", "incident", "recurring"]);
  const points: BriefPoint[] = (Array.isArray(r.points) ? r.points : [])
    .map((p: Record<string, unknown>) => ({
      title: typeof p?.title === "string" ? p.title.trim() : "",
      level: typeof p?.level === "string" && levels.has(p.level) ? (p.level as BriefPoint["level"]) : undefined,
      // Citations live in `sources`; strip inline [n] markers from the prose.
      text: typeof p?.text === "string" ? p.text.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "").trim() : "",
      sources: (Array.isArray(p?.sources) ? p.sources : [])
        .map(Number)
        .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= sourceCount),
    }))
    .filter((p) => p.title && p.text)
    .slice(0, MAX_POINTS);
  return { overview: r.overview.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "").trim(), points };
}

/** Keyless fallback: the detected issues' own (already neutral) summaries. */
export function rulesBrief(country: string, issues: NewsIssue[], sources: BriefSource[]): { overview: string; points: BriefPoint[] } {
  const byTitle = new Map(sources.map((s) => [s.title, s.n]));
  const points = issues.slice(0, MAX_POINTS).map((i) => ({
    title: i.label,
    level: i.level,
    text: i.summary.charAt(0).toUpperCase() + i.summary.slice(1),
    sources: i.headlines.map((h) => byTitle.get(h.title)).filter((n): n is number => !!n),
  }));
  const patterns = issues.filter((i) => i.level === "systemic").map((i) => i.label.toLowerCase());
  const overview = !issues.length
    ? `Nothing travel-relevant stands out in recent coverage of ${country}.`
    : patterns.length
      ? `Recent coverage of ${country} points to a pattern in ${patterns.join(" and ")}. Details and sources below.`
      : `Recent coverage of ${country} mentions ${issues.length === 1 ? "one issue" : `${issues.length} issues`} worth knowing about. Details and sources below.`;
  return { overview, points };
}

let generator: BriefGenerator | null | undefined;

/** Test seam: replace the model call; null forces the rules fallback; no arg restores the default. */
export function setBriefGenerator(g?: BriefGenerator | null): void {
  generator = g;
}

async function defaultGenerator(): Promise<BriefGenerator | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const { generateText } = await import("ai");
  const { openai } = await import("@ai-sdk/openai");
  const model = process.env.NEWS_BRIEF_MODEL || "gpt-4o-mini";
  return async (system, prompt) => {
    const { text } = await generateText({ model: openai(model), system, prompt, temperature: 0.2, maxTokens: 700 });
    return text;
  };
}

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; brief: NewsBrief }>();

/** Test-only. */
export function resetBriefCache(): void {
  cache.clear();
}

/**
 * The briefing for a place. Cached per place and source set for six hours, so the model
 * runs again only when the headlines it would read have changed.
 */
export async function getNewsBrief(city: string, country: string, place: PlaceNews, now = Date.now()): Promise<NewsBrief> {
  const sources = pickSources(place);
  const key = createHash("sha1")
    .update(`${city}|${country}|${sources.map((s) => s.title).join("\n")}`)
    .digest("hex");
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.brief;

  const gen = generator === undefined ? await defaultGenerator() : generator;
  let body: { overview: string; points: BriefPoint[] } | null = null;
  let by: NewsBrief["by"] = "rules";
  if (gen && sources.length) {
    try {
      body = parseBrief(await gen(SYSTEM_PROMPT, buildPrompt(city, country, place.issues, sources, new Date(now))), sources.length);
      if (body) by = "model";
    } catch (err) {
      console.warn("[news/brief] model failed, using rules:", err instanceof Error ? err.message : String(err));
    }
  }
  body ??= rulesBrief(country, place.issues, sources);

  // List only the sources the briefing cites (all of them when it cites none), renumbered.
  const cited = new Set(body.points.flatMap((p) => p.sources));
  const kept = cited.size ? sources.filter((s) => cited.has(s.n)) : sources.slice(0, 8);
  const renumber = new Map(kept.map((s, i) => [s.n, i + 1]));
  const brief: NewsBrief = {
    overview: body.overview,
    points: body.points.map((p) => ({ ...p, sources: p.sources.map((n) => renumber.get(n)).filter((n): n is number => !!n) })),
    sources: kept.map((s, i) => ({ ...s, n: i + 1 })),
    by,
    generatedAt: new Date(now).toISOString(),
  };
  cache.set(key, { at: now, brief });
  return brief;
}

