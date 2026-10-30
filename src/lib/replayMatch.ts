// Pure helpers for rendering PlaceResult.replayMatch on agent place cards. No React.

import { MONTHS } from "./journal";
import type { FingerprintDim, PlaceResult } from "../types";

export const DIM_LABEL: Record<FingerprintDim, string> = {
  month: "SEASON",
  comfort: "COMFORT",
  tempC: "TEMPERATURE",
  precipMm: "RAINFALL",
  dailySpendEur: "SPEND",
  flightCostEurPer1000km: "FLIGHT COST",
  crowdProxy: "CROWD",
};

export interface MatchSummary {
  /** 0-100, rounded. */
  match: number;
  month: string;
  /** The strongest contributors, biggest first, as whole percents of the match. */
  top: Array<{ name: FingerprintDim; label: string; pct: number }>;
  /** What the score was computed on, in words. */
  scoredOn: string[];
}

/** null when the place did not come from a replay (the card then renders unchanged). */
export function matchSummary(rm: PlaceResult["replayMatch"], topN = 3): MatchSummary | null {
  if (!rm) return null;
  const top = [...rm.dims]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, topN)
    .map((d) => ({ name: d.name, label: DIM_LABEL[d.name] ?? d.name.toUpperCase(), pct: Math.round(d.contribution * 100) }));
  return {
    match: Math.round(rm.match),
    month: MONTHS[rm.month - 1] ?? "?",
    top,
    scoredOn: rm.scoredOn.map((d) => DIM_LABEL[d] ?? d.toUpperCase()),
  };
}

/** `Authorization` header for agent requests, only when a token exists (journal tools need it). */
export function bearerHeaders(token: string | null | undefined): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/** Places carrying a replay breakdown, from the AI-SDK tool invocations of one message. */
export function replayPlaces(invocations: ReadonlyArray<{ toolName: string; state: string; result?: unknown }> | undefined): PlaceResult[] {
  const out: PlaceResult[] = [];
  for (const inv of invocations ?? []) {
    if (inv.toolName !== "find_similar_windows" || inv.state !== "result") continue;
    const places = (inv.result as { places?: PlaceResult[] } | undefined)?.places;
    if (Array.isArray(places)) out.push(...places.filter((p) => p.replayMatch));
  }
  return out;
}
