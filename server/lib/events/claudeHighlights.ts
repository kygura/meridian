// Seasonal highlights of each place, read by Claude from the place's own Wikivoyage and Wikipedia
// text and checked against it (ADR 0021). Rolling: each run reads as many cities as its time and
// its call budget allow, the owner's places first, and a result is kept for 120 days. A region's
// articles are read once and the result is shared by every checked city in it.

import type Anthropic from "@anthropic-ai/sdk";
import type { City } from "../../../src/types.js";
import { anthropic, hasAnthropicKey } from "../agent/claude.js";
import { httpGet, HttpError, DAY_MS, type SourceContext, type SourceDef, type SourceResult, type StoredEvent } from "./common.js";
import { articleBlocks, estimateTokens, promptText, selectBlocks, type TextBlock } from "./highlightText.js";
import { groundHighlights, highlightEvent, HIGHLIGHTS_SCHEMA, slugOf, SYSTEM_PROMPT, TOOL_NAME, userPrompt, type StoredHighlight } from "./highlightExtract.js";
import { fetchExtract, resolvePlace, type PlaceArticles } from "./placeText.js";

/** A result is kept this long before it is read again. */
export const RECHECK_MS = 120 * DAY_MS;
/** A city whose text could not be found is tried again after this. */
export const NO_TEXT_RECHECK_MS = 7 * DAY_MS;
/** Claude calls one refresh may make: 8 on Vercel (within the 45 s budget), 40 elsewhere. */
export const DEFAULT_MAX_CALLS = process.env.VERCEL ? 8 : 40;
/** Time one city takes at most (about 9 Wikimedia requests and up to three Claude calls), for deciding whether to start one. */
export const CITY_ESTIMATE_MS = 30_000;
/** Worst case calls for one city: its own article and two regions. */
const CALLS_PER_CITY = 3;
const STATE_VERSION = 4;
const MAX_RETRIES = 4;
const RETRY_CAP_MS = 30_000;
const MAX_OUTPUT_TOKENS = 3000;

export function eventsModel(): string {
  return process.env.EVENTS_MODEL || "claude-haiku-5-5";
}

export interface CityResult {
  at: string;
  /** 0 when no text of the city could be read. */
  t?: 0;
  /** Wikidata ids of the regions above the city; their results are in `regions`. */
  regions: string[];
  highlights: StoredHighlight[];
}

export interface RegionResult {
  at: string;
  title: string;
  highlights: StoredHighlight[];
}

export interface HighlightStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  kept: number;
  ungrounded: number;
  badMonths: number;
  invalid: number;
}

export interface HighlightState {
  version: number;
  cities: Record<string, CityResult>;
  regions: Record<string, RegionResult>;
  stats: HighlightStats;
}

const emptyStats = (): HighlightStats => ({ calls: 0, inputTokens: 0, outputTokens: 0, kept: 0, ungrounded: 0, badMonths: 0, invalid: 0 });
export const emptyHighlightState = (): HighlightState => ({ version: STATE_VERSION, cities: {}, regions: {}, stats: emptyStats() });

/** The stored state, or an empty one when it is missing or was written by the earlier iNaturalist source. */
export function readHighlightState(raw: unknown): HighlightState {
  const r = raw as Partial<HighlightState> | null | undefined;
  if (!r || typeof r !== "object" || r.version !== STATE_VERSION || !r.cities || typeof r.cities !== "object") return emptyHighlightState();
  return { version: STATE_VERSION, cities: r.cities, regions: r.regions && typeof r.regions === "object" ? r.regions : {}, stats: { ...emptyStats(), ...(r.stats ?? {}) } };
}

export interface CheckTask {
  city: City;
  checkedAt: string;
  rank: number;
}

/** The cities due for a read, never-read first and then the longest ago, each group in the order given. */
export function dueChecks(ordered: City[], state: HighlightState, now: Date): CheckTask[] {
  const tasks: CheckTask[] = [];
  ordered.forEach((city, rank) => {
    const prev = state.cities[city.id];
    if (prev && now.getTime() - Date.parse(prev.at) < (prev.t === 0 ? NO_TEXT_RECHECK_MS : RECHECK_MS)) return;
    tasks.push({ city, checkedAt: prev?.at ?? "", rank });
  });
  return tasks.sort((a, b) => a.checkedAt.localeCompare(b.checkedAt) || a.rank - b.rank);
}

/** The cities in reading order: the owner's, then by attention, then the remaining airport cities by population. */
export function orderCities(cities: City[], owner: string[], attention: string[]): City[] {
  const byId = new Map(cities.map((c) => [c.id, c]));
  const out: City[] = [];
  const seen = new Set<string>();
  const add = (c: City | undefined) => {
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  };
  for (const id of owner) add(byId.get(id));
  for (const id of attention) add(byId.get(id));
  for (const c of cities.filter((x) => x.iata).sort((a, b) => b.population - a.population || a.id.localeCompare(b.id))) add(c);
  return out;
}

/** The events of every read city: its own highlights, then those of its regions, same titles merged (the city's first). */
export function eventsFromState(state: HighlightState, cities: Map<string, City>): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (const [cityId, res] of Object.entries(state.cities)) {
    const city = cities.get(cityId);
    if (!city) continue;
    const seen = new Set<string>();
    const all = [...res.highlights, ...res.regions.flatMap((q) => state.regions[q]?.highlights ?? [])];
    for (const h of all) {
      const slug = slugOf(h.title);
      if (seen.has(slug)) continue;
      seen.add(slug);
      events.push(highlightEvent(h, city));
    }
  }
  return events.sort((a, b) => a.id.localeCompare(b.id));
}

export interface CallResult {
  raw: unknown;
  inputTokens: number;
  outputTokens: number;
}

/** One call to the model with the one tool, forced. Throws on a refusal, a cut-off answer or no tool answer. */
export async function callClaude(placeName: string, text: string, client: Anthropic = anthropic()): Promise<CallResult> {
  const response = await client.messages.create({
    model: eventsModel(),
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [{ name: TOOL_NAME, description: "Record the seasonal highlights found in the text.", input_schema: HIGHLIGHTS_SCHEMA as unknown as Anthropic.Tool.InputSchema }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: userPrompt(placeName, text) }],
  });
  if (response.stop_reason === "refusal") throw new Error(`refused (${response.stop_details?.category ?? "unknown"})`);
  if (response.stop_reason === "max_tokens") throw new Error("answer cut off at max_tokens");
  const block = response.content.find((b) => b.type === "tool_use" && b.name === TOOL_NAME);
  if (!block || block.type !== "tool_use") throw new Error("no tool answer");
  const raw = (block.input as { highlights?: unknown } | null)?.highlights;
  return { raw, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
}

export const highlightsSource: SourceDef = {
  id: "highlights",
  // Due often: a run does bounded work, and most runs find nothing due and make no request.
  intervalMs: 60 * 60 * 1000,
  mayBeEmpty: true,
  async run(ctx: SourceContext): Promise<SourceResult> {
    if (!hasAnthropicKey()) throw new Error("no Anthropic key");
    const state = readHighlightState(ctx.prev.state?.["highlights"]);
    const byId = new Map(ctx.cities.map((c) => [c.id, c]));
    const owner = await ctx.places.ownerCityIds().catch(() => [] as string[]);
    const ordered = orderCities(ctx.cities, owner, ctx.places.attentionCityIds());
    const nowIso = ctx.now.toISOString();
    const tasks = dueChecks(ordered, state, ctx.now);
    let requests = 0;
    let ran = 0;
    let callsThisRun = 0;
    let error: unknown;

    // Wikimedia request starts are spaced `hostPauseMs` apart, one at a time.
    let nextStart = 0;
    const getJson = async (url: string, label: string): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        const now = Date.now();
        const at = Math.max(now, nextStart);
        nextStart = at + ctx.hostPauseMs;
        if (at > now) await ctx.sleep(at - now);
        requests++;
        try {
          return await (await httpGet(url, ctx, label)).json();
        } catch (err) {
          // Wikimedia answers 429 often to a shared address: wait Retry-After (at least 2 s, growing) and try again.
          if (!(err instanceof HttpError) || err.status !== 429 || attempt >= MAX_RETRIES) throw err;
          const secs = Number(err.retryAfter);
          const wait = Math.min(RETRY_CAP_MS, (err.retryAfter !== null && Number.isFinite(secs) && secs >= 0 ? Math.max(secs, 2) : 5) * 1000 * (attempt + 1));
          const limit = ctx.deadline ?? ctx.softDeadline;
          if (limit !== undefined && Date.now() + wait > limit - 1500) throw err;
          nextStart = Math.max(nextStart, Date.now() + wait);
        }
      }
    };
    const tryExtract = async (wiki: "wikipedia" | "wikivoyage", title: string | undefined): Promise<string> => {
      if (!title) return "";
      try {
        return await fetchExtract(wiki, title, getJson);
      } catch {
        return "";
      }
    };
    const ask = async (placeName: string, blocks: TextBlock[]): Promise<StoredHighlight[]> => {
      const sent = selectBlocks(blocks);
      callsThisRun++;
      state.stats.calls++;
      const res = await callClaude(placeName, promptText(sent));
      state.stats.inputTokens += res.inputTokens;
      state.stats.outputTokens += res.outputTokens;
      const g = groundHighlights(res.raw, sent);
      state.stats.kept += g.kept.length;
      state.stats.ungrounded += g.dropped.ungrounded;
      state.stats.badMonths += g.dropped.badMonths;
      state.stats.invalid += g.dropped.invalid;
      return g.kept;
    };

    const readCity = async (city: City): Promise<CityResult> => {
      const place: PlaceArticles = await resolvePlace(city, getJson);
      const blocks: TextBlock[] = [];
      const wv = await tryExtract("wikivoyage", place.cityWv);
      if (wv && place.cityWv) blocks.push(...articleBlocks("wikivoyage", "wikivoyage", place.cityWv, wv));
      const wp = await tryExtract("wikipedia", place.cityWp);
      if (wp && place.cityWp) blocks.push(...articleBlocks("wikipedia", "wikipedia", place.cityWp, wp));
      const out: CityResult = { at: nowIso, regions: [], highlights: [] };
      if (blocks.length) out.highlights = await ask(city.name, blocks);
      else out.t = 0;
      // Regions: read once, shared by every checked city in them.
      // Regions with a Wikivoyage article, two at most; the nearest one with only a Wikipedia article when none has.
      const withVoyage = place.regions.filter((r) => r.wv);
      const used = withVoyage.length ? withVoyage.slice(0, 2) : place.regions.slice(0, 1);
      out.regions = used.map((r) => r.qid);
      for (const r of used) {
        const have = state.regions[r.qid];
        if (have && ctx.now.getTime() - Date.parse(have.at) < RECHECK_MS) continue;
        const title = r.wv ?? r.wp ?? r.qid;
        // The region's Wikivoyage article; its Wikipedia lead and sections when it has none.
        const wvText = await tryExtract("wikivoyage", r.wv);
        const wpText = wvText ? "" : await tryExtract("wikipedia", r.wp);
        const rb = r.wv && wvText ? articleBlocks("region", "wikivoyage", r.wv, wvText) : r.wp && wpText ? articleBlocks("region", "wikipedia", r.wp, wpText) : [];
        state.regions[r.qid] = { at: nowIso, title, highlights: rb.length ? await ask(title, rb) : [] };
      }
      return out;
    };

    const summary = (): Record<string, number | string> => ({
      cities: ordered.length,
      owners: owner.length,
      checked: Object.keys(state.cities).length,
      regionsRead: Object.keys(state.regions).length,
      ranThisRun: ran,
      // Cities never read or last read 120 or more days ago: while this is above zero the source keeps being retried.
      pending: tasks.length - ran,
      requests,
      callsThisRun,
      model: eventsModel(),
      calls: state.stats.calls,
      inputTokens: state.stats.inputTokens,
      outputTokens: state.stats.outputTokens,
      kept: state.stats.kept,
      droppedUngrounded: state.stats.ungrounded,
      droppedBadMonths: state.stats.badMonths,
      droppedInvalid: state.stats.invalid,
    });
    const save = async () => ctx.checkpoint({ events: eventsFromState(state, byId), state, detail: summary() });

    try {
      for (const t of tasks) {
        if (ran >= ctx.maxChecks && ctx.maxChecks < Infinity) break;
        if (callsThisRun + CALLS_PER_CITY > ctx.maxChecks) break;
        const limit = ctx.deadline ?? ctx.softDeadline;
        if (limit !== undefined && Date.now() + CITY_ESTIMATE_MS > limit - 1500) break;
        state.cities[t.city.id] = await readCity(t.city);
        ran++;
        await save();
      }
    } catch (err) {
      error = err;
    }
    const events = eventsFromState(state, byId);
    if (error) {
      await ctx.checkpoint({ events, state, detail: summary() });
      const status = error instanceof HttpError ? ` (${error.status})` : "";
      throw new Error(`highlights stopped after ${ran} cities${status}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 280));
    }
    return { events, state, detail: summary() };
  },
};
