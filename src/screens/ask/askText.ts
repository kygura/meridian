// Pure helpers for the Ask panel: plain-word labels for agent tool output, city mentions in prose,
// and the structured bits (places, photos, drafts, lock state) pulled out of a message's tool calls.
// No React, no fetch.

import type { City, FingerprintDim, PlaceImage, PlaceResult } from "../../types";

/** Tool invocation as the AI SDK puts it on a message (only the fields read here). */
export interface ToolCall {
  toolName: string;
  state: string;
  result?: unknown;
}

// ── Words ────────────────────────────────────────────────────────────

/** Fingerprint dimensions in plain words (never "crowdProxy"). */
export const DIM_WORDS: Record<FingerprintDim, string> = {
  month: "Season",
  comfort: "Comfort",
  tempC: "Temperature",
  precipMm: "Rainfall",
  dailySpendEur: "Daily spend",
  flightCostEurPer1000km: "Flight cost",
  crowdProxy: "Crowds",
};

export function dimWord(d: string): string {
  return (DIM_WORDS as Record<string, string>)[d] ?? humanize(d);
}

/** "crowdProxy" -> "Crowd proxy", "draft_journey" -> "Draft journey": last-resort wording for unknown keys. */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** 1-based month -> "October". */
export function monthName(m: number): string {
  return MONTH_LONG[m - 1] ?? "";
}

const TOOL_ACTIVITY: Record<string, string> = {
  search_places: "Searching places",
  get_place_images: "Finding photos",
  get_seasonality: "Checking the best months",
  get_flight_estimate: "Pricing flights",
  search_journal: "Reading your past trips",
  get_fingerprint: "Checking how a past trip felt",
  find_similar_windows: "Finding similar places",
  draft_journey: "Drafting a trip for your inbox",
};

/** What a running tool is doing, in words: "Searching places". */
export function toolActivity(toolName: string): string {
  return TOOL_ACTIVITY[toolName] ?? "Working";
}

// ── Tool results ─────────────────────────────────────────────────────

const results = (calls: readonly ToolCall[] | undefined, name: string): unknown[] =>
  (calls ?? []).filter((c) => c.toolName === name && c.state === "result").map((c) => c.result);

/** Tools still running on this message, as activity lines (deduped, in order). */
export function pendingActivities(calls: readonly ToolCall[] | undefined): string[] {
  const out: string[] = [];
  for (const c of calls ?? []) {
    if (c.state === "result") continue;
    const a = toolActivity(c.toolName);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** True when any journal tool answered journal_locked (the token was missing or wrong). */
export function journalLocked(calls: readonly ToolCall[] | undefined): boolean {
  return (calls ?? []).some((c) => c.state === "result" && (c.result as { error?: string } | undefined)?.error === "journal_locked");
}

/** Places from find_similar_windows that carry a match breakdown. */
export function replayMatches(calls: readonly ToolCall[] | undefined): PlaceResult[] {
  const out: PlaceResult[] = [];
  for (const r of results(calls, "find_similar_windows")) {
    const places = (r as { places?: PlaceResult[] } | undefined)?.places;
    if (Array.isArray(places)) out.push(...places.filter((p) => p.replayMatch));
  }
  return out;
}

/** Places from search_places (ids are exact, so they make better chips than prose matching). */
export function searchedPlaces(calls: readonly ToolCall[] | undefined): PlaceResult[] {
  const out: PlaceResult[] = [];
  for (const r of results(calls, "search_places")) if (Array.isArray(r)) out.push(...(r as PlaceResult[]));
  return out;
}

/** Photos from get_place_images (the first call with any). */
export function placeImages(calls: readonly ToolCall[] | undefined): PlaceImage[] {
  for (const r of results(calls, "get_place_images")) if (Array.isArray(r) && r.length) return r as PlaceImage[];
  return [];
}

/** draft_journey outcome: how many items went to the inbox, if any call succeeded. */
export function draftOutcome(calls: readonly ToolCall[] | undefined): { drafted: number; pending: boolean } | null {
  for (const r of results(calls, "draft_journey")) {
    const d = r as { drafted?: number; notice?: string } | undefined;
    if (d && typeof d.drafted === "number") return { drafted: d.drafted, pending: d.drafted > 0 || d.notice === "already_pending" };
  }
  return null;
}

// ── Replay result cards ──────────────────────────────────────────────

export interface MatchCard {
  match: number;
  month: string;
  /** "Closest on temperature and rainfall". */
  closest: string;
  mock: boolean;
}

/** Compact card model for a replay match; null when the place has no breakdown. */
export function matchCard(p: PlaceResult): MatchCard | null {
  const rm = p.replayMatch;
  if (!rm) return null;
  const top = [...rm.dims]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 2)
    .map((d) => dimWord(d.name).toLowerCase());
  return {
    match: Math.round(rm.match),
    month: monthName(rm.month),
    closest: top.length ? `Closest on ${top.join(" and ")}` : "",
    mock: /mock/i.test(p.summaryLine ?? ""),
  };
}

// ── City mentions ────────────────────────────────────────────────────

export type CityNameIndex = Map<string, City>;

/** Lower-cased name -> city; on a shared name the bigger city wins. Names under 4 letters are skipped. */
export function cityNameIndex(cities: readonly City[]): CityNameIndex {
  const m: CityNameIndex = new Map();
  for (const c of cities) {
    const key = c.name.toLowerCase();
    if (key.length < 4) continue;
    const prev = m.get(key);
    if (!prev || (c.population ?? 0) > (prev.population ?? 0)) m.set(key, c);
  }
  return m;
}

const MAX_WORDS = 4;

/**
 * Cities named in prose, in order of first mention. Only phrases that start with a capital letter count,
 * so "nice weather" never matches Nice; the longest phrase wins ("San Jose" over "Jose").
 */
export function findCityMentions(text: string, index: CityNameIndex, limit = 6): City[] {
  const words = text.match(/[\p{L}][\p{L}'’.-]*/gu) ?? [];
  const out: City[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < words.length && out.length < limit; i++) {
    const w = words[i];
    if (w.charAt(0) !== w.charAt(0).toUpperCase() || w.charAt(0) === w.charAt(0).toLowerCase()) continue;
    for (let len = Math.min(MAX_WORDS, words.length - i); len >= 1; len--) {
      const phrase = words
        .slice(i, i + len)
        .join(" ")
        .replace(/[.'’-]+$/, "")
        .toLowerCase();
      const hit = index.get(phrase);
      if (hit) {
        if (!seen.has(hit.id)) {
          seen.add(hit.id);
          out.push(hit);
        }
        i += len - 1;
        break;
      }
    }
  }
  return out;
}

// ── Prose ────────────────────────────────────────────────────────────

export type ProseBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** Splits agent prose into paragraphs and bullet lists; drops markdown emphasis and heading marks. */
export function proseBlocks(text: string): ProseBlock[] {
  const clean = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/^\s*#{1,6}\s+/, "").trim();
  const out: ProseBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ type: "p", text: clean(para.join(" ")) });
    para = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) {
      flush();
      continue;
    }
    if (/^\s*#{1,6}\s/.test(raw)) {
      flush();
      out.push({ type: "p", text: clean(raw) });
      continue;
    }
    if (BULLET.test(raw)) {
      flush();
      const item = clean(raw.replace(BULLET, ""));
      const last = out[out.length - 1];
      if (last && last.type === "ul") last.items.push(item);
      else out.push({ type: "ul", items: [item] });
    } else {
      para.push(raw.trim());
    }
  }
  flush();
  return out.filter((b) => (b.type === "p" ? b.text : b.items.length));
}
