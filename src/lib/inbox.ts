// Pure helpers for the inbox (DESIGN-journal.md §8) and the alerts list (§9). No React, no fetch.

import { MODE_GLYPH, MONTHS, cityLabel, daysBetween, formatDay, formatEur, type CityIndex } from "./journal";
import type { Alert, ImportCandidate, ImportCluster, ImportKind, Journey, SegmentMode, TickerItem, Watch } from "../types";

// ── Candidates ───────────────────────────────────────────────────────

const MODE_WORD: Record<SegmentMode, string> = { flight: "FLIGHT", train: "TRAIN", bus: "BUS", car: "CAR", ferry: "FERRY", other: "MOVE" };

/** `FLIGHT` / `STAY` / `DONE` / `STOP` (non-flight segments name their mode). */
export function kindLabel(c: ImportCandidate): string {
  if (c.kind === "segment") return MODE_WORD[c.payload.mode ?? "flight"] ?? "MOVE";
  return ({ lodging: "STAY", experience: "DONE", stop: "STOP", segment: "FLIGHT" } as Record<ImportKind, string>)[c.kind];
}

/** Decorative glyph beside the kind label (hidden from assistive tech). */
export function kindGlyph(c: ImportCandidate): string {
  if (c.kind === "segment") return MODE_GLYPH[c.payload.mode ?? "flight"] ?? "·";
  return ({ lodging: "⌂", experience: "★", stop: "●", segment: "✈" } as Record<ImportKind, string>)[c.kind];
}

const place = (id: string | undefined, iata: string | undefined, name: string | undefined, cities: CityIndex): string =>
  id && cities.has(id) ? cityLabel(id, cities) : iata ?? name ?? "?";

/** `TP1023 LIS → OPO · 14 MAY`, `Hotel Baixa · LIS · 14–17 MAY`, or the city hint when unresolved. */
export function candidateSummary(c: ImportCandidate, cities: CityIndex): string {
  const p = c.payload;
  const cityId = p.cityId;
  const here = place(cityId, p.iataHint, p.cityHint, cities);
  switch (c.kind) {
    case "segment": {
      // A flight number with letters ("TP1023") says it all; a bare number ("122") needs its carrier.
      const code = p.number && /[A-Za-z]/.test(p.number) ? p.number : [p.carrier, p.number].filter(Boolean).join(" ");
      const route = `${place(p.fromCityId, p.iataHint, p.cityHint, cities)} → ${place(p.toCityId, p.toIataHint, p.toCityHint, cities)}`;
      return [code, route].filter(Boolean).join(" ") + (p.departAt ? ` · ${formatDay(p.departAt)}` : "");
    }
    case "lodging": {
      const name = p.lodging?.name ?? p.name ?? "Stay";
      const when = p.arrive ? ` · ${formatDay(p.arrive)}${p.depart && p.depart !== p.arrive ? ` – ${formatDay(p.depart)}` : ""}` : "";
      return `${name} · ${here}${when}`;
    }
    case "experience":
      return `${p.title ?? "Experience"} · ${here}${p.date ? ` · ${formatDay(p.date)}` : ""}`;
    case "stop":
    default:
      return `${here}${p.arrive ? ` · ${p.depart && p.depart !== p.arrive ? `${formatDay(p.arrive)} – ${formatDay(p.depart)}` : formatDay(p.arrive)}` : ""}`;
  }
}

/** The candidate's own date (YYYY-MM-DD), else the day it was imported. */
export function candidateDay(c: ImportCandidate): string {
  const p = c.payload;
  return (p.departAt ?? p.arrive ?? p.date ?? c.createdAt).slice(0, 10);
}

export function isUnresolved(c: ImportCandidate): boolean {
  return !!c.flags?.includes("unresolved-city");
}

/** Which PATCH fields a candidate needs, with the hint shown beside each. */
export interface CityFix {
  field: "cityId" | "fromCityId" | "toCityId";
  hint: string;
}

/** With `cities`, an id the index does not know counts as unresolved too (its id becomes the last-resort hint). */
export function cityFixes(c: ImportCandidate, cities?: CityIndex): CityFix[] {
  const p = c.payload;
  const bad = (id: unknown) => !id || (!!cities && !cities.has(id as string));
  if (c.kind === "segment") {
    const out: CityFix[] = [];
    if (bad(p.fromCityId)) out.push({ field: "fromCityId", hint: p.cityHint ?? p.iataHint ?? p.fromCityId ?? "origin" });
    if (bad(p.toCityId)) out.push({ field: "toCityId", hint: p.toCityHint ?? p.toIataHint ?? p.toCityId ?? "destination" });
    return out;
  }
  return bad(p.cityId) ? [{ field: "cityId", hint: p.cityHint ?? p.iataHint ?? p.cityId ?? "city" }] : [];
}

/** `UNRESOLVED CITY "Oporto Cty"` and any other flag as plain words. */
export function flagTexts(c: ImportCandidate, cities?: CityIndex): string[] {
  return (c.flags ?? []).map((f) => {
    if (f === "unresolved-city") {
      const hints = cityFixes(c, cities).map((x) => `"${x.hint}"`);
      return hints.length ? `UNRESOLVED CITY ${hints.join(", ")}` : "UNRESOLVED CITY";
    }
    return f.replace(/[-_]/g, " ").toUpperCase();
  });
}

// ── Clusters ─────────────────────────────────────────────────────────

/** Candidates of a cluster in queue order. */
export function clusterMembers(cluster: ImportCluster, candidates: ImportCandidate[]): ImportCandidate[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return cluster.candidateIds.map((id) => byId.get(id)).filter((c): c is ImportCandidate => !!c);
}

/** Candidates that belong to no cluster (kept visible so nothing pending is hidden). */
export function looseCandidates(clusters: ImportCluster[], candidates: ImportCandidate[]): ImportCandidate[] {
  const inCluster = new Set(clusters.flatMap((cl) => cl.candidateIds));
  return candidates.filter((c) => c.state === "pending" && !inCluster.has(c.id));
}

/** `12–20 MAY 2024`, `28 MAY – 2 JUN 2024`, or `31 DEC 2023 – 3 JAN 2024`. */
export function clusterDates(a: string, b: string): string {
  const [ya, ma, da] = a.slice(0, 10).split("-").map(Number);
  const [yb, mb, db] = b.slice(0, 10).split("-").map(Number);
  const A = MONTHS[ma - 1];
  const B = MONTHS[mb - 1];
  if (ya !== yb) return `${da} ${A} ${ya} – ${db} ${B} ${yb}`;
  if (ma !== mb) return `${da} ${A} – ${db} ${B} ${yb}`;
  return da === db ? `${da} ${A} ${ya}` : `${da}–${db} ${A} ${ya}`;
}

/** `LIS → OPO` from the cluster's city ids. */
export function clusterChain(cluster: ImportCluster, cities: CityIndex): string {
  return cluster.cityIds.map((id) => cityLabel(id, cities)).join(" → ");
}

/** `37 ITEMS IN 6 SUGGESTED JOURNEYS` */
export function queueMeta(candidates: number, clusters: number): string {
  const items = `${candidates.toLocaleString("en-US")} ${candidates === 1 ? "ITEM" : "ITEMS"}`;
  return clusters ? `${items} IN ${clusters} SUGGESTED ${clusters === 1 ? "JOURNEY" : "JOURNEYS"}` : items;
}

// ── Merge targets ────────────────────────────────────────────────────

/** Journeys the cluster plausibly belongs to: confirmed, ending no more than 14 days before it or starting no more than 14 days after. */
export function suggestedJourneys(cluster: Pick<ImportCluster, "startDate" | "endDate">, journeys: Journey[], suggestedId?: string): Journey[] {
  return journeys
    .filter((j) => j.id === suggestedId || (j.status === "confirmed" && daysBetween(j.endDate, cluster.startDate) <= 14 && daysBetween(cluster.endDate, j.startDate) <= 14))
    .sort((a, b) => (a.id === suggestedId ? -1 : b.id === suggestedId ? 1 : Math.abs(daysBetween(a.startDate, cluster.startDate)) - Math.abs(daysBetween(b.startDate, cluster.startDate))));
}

/** Search all journeys by title or city (name, IATA, id). */
export function searchJourneys(q: string, journeys: Journey[], cities: CityIndex): Journey[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return journeys
    .filter(
      (j) =>
        j.title.toLowerCase().includes(s) ||
        j.stops.some((st) => {
          const c = cities.get(st.cityId);
          return st.cityId.toLowerCase().includes(s) || c?.name.toLowerCase().includes(s) || c?.iata?.toLowerCase() === s;
        })
    )
    .slice(0, 8);
}

// ── Errors ───────────────────────────────────────────────────────────

/** Plain-words, upper-case message for a failed inbox action (409/404/413/422/network). */
export function inboxErrorText(e: { status?: number; code?: string; message?: string; name?: string } | unknown): string {
  const err = (e ?? {}) as { status?: number; code?: string; name?: string; message?: string };
  if (err.name === "JournalNetworkError") return "⚠ COULDN'T REACH THE SERVER — TRY AGAIN";
  switch (err.code) {
    case "not_pending":
      return "⚠ ALREADY REVIEWED ELSEWHERE — THE LIST WAS REFRESHED";
    case "unresolved":
      return "⚠ SOME CITIES ARE UNRESOLVED — PICK THEM FIRST";
    case "journey_changed":
      return "⚠ THAT JOURNEY CHANGED MEANWHILE — TRY AGAIN";
    case "journey_not_found":
      return "⚠ THAT JOURNEY NO LONGER EXISTS";
    case "cluster_not_found":
    case "not_found":
      return "⚠ THAT ITEM IS GONE — THE LIST WAS REFRESHED";
    case "no_stops":
      return "⚠ NO STOP COULD BE DERIVED FROM THESE ITEMS";
    case "too_large":
      return "⚠ THAT FILE IS TOO LARGE";
    case "too_many":
      return "⚠ TOO MANY ITEMS IN ONE UPLOAD";
    case "fx_unavailable":
      return "⚠ NO EXCHANGE RATE AVAILABLE FOR A PRICE — TRY AGAIN LATER";
  }
  if (err.status === 413) return "⚠ THAT FILE IS TOO LARGE";
  if (err.status === 422) return "⚠ THE SERVER COULD NOT PROCESS THAT";
  return "⚠ SOMETHING WENT WRONG — TRY AGAIN";
}

// ── Alerts ───────────────────────────────────────────────────────────

/** Percent under (negative) or over (positive) the baseline, rounded; 0 when the baseline is unusable. */
export function alertDeltaPct(a: Pick<Alert, "priceEur" | "baselineEur">): number {
  return a.baselineEur > 0 ? Math.round(((a.priceEur - a.baselineEur) / a.baselineEur) * 100) : 0;
}

/** `−12 %` / `+3 %` with a real minus sign. */
export function formatDelta(pct: number): string {
  return `${pct < 0 ? "−" : pct > 0 ? "+" : ""}${Math.abs(pct)} %`;
}

/** `OPO · JUN` */
export function alertWhere(a: Pick<Alert, "cityId" | "month">, cities: CityIndex): string {
  return `${cityLabel(a.cityId, cities)} · ${MONTHS[a.month - 1] ?? "?"}`;
}

export function isMockSource(source: string): boolean {
  return /mock/i.test(source);
}

/** `2 DAYS AGO`, `3 H AGO`, `JUST NOW` */
export function agoText(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "NEVER";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "NEVER";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "JUST NOW";
  if (min < 60) return `${min} MIN AGO`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} H AGO`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? "DAY" : "DAYS"} AGO`;
}

/** Newest first. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Ticker time column: `5m`, `3h`, `2d`. */
export function tickerAge(iso: string, now: Date = new Date()): string {
  const min = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(min)) return "";
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

/**
 * How an alert's price relates to its reference. The server stores the rule's own reference as `baselineEur`:
 * the user's median, the provider's baseline, or (for a fixed cap) the cap itself, so a cap is never called "usual".
 */
export function alertComparison(a: Pick<Alert, "priceEur" | "baselineEur">, watch?: Pick<Watch, "priceRule">): { vs: string; delta: string | null } | null {
  const rule = watch?.priceRule;
  if (rule && typeof rule === "object") return { vs: `under your ${formatEur(rule.maxEur)} cap`, delta: null };
  if (a.baselineEur > 0) return { vs: `vs ${formatEur(a.baselineEur)} usual`, delta: formatDelta(alertDeltaPct(a)) };
  return null;
}

/** A ticker item for one unseen alert: glyph "good", first in the set. `alertId` marks it clickable (opens the panel). */
export type AlertTickerItem = TickerItem & { alertId: string };

export function alertTickerItem(a: Alert, watch: Pick<Watch, "label" | "priceRule"> | undefined, cities: CityIndex, now: Date = new Date()): AlertTickerItem {
  const pct = alertDeltaPct(a);
  const cmp = alertComparison(a, watch);
  const rel = !cmp
    ? ""
    : cmp.delta === null
      ? `, ${cmp.vs}`
      : pct < 0
        ? `, ${Math.abs(pct)} % under what you usually pay`
        : pct > 0
          ? `, ${pct} % over what you usually pay`
          : ", at what you usually pay";
  return {
    glyph: "good",
    location: alertWhere(a, cities),
    text: `Watch “${watch?.label ?? "window"}”: ${formatEur(a.priceEur)}${rel}`,
    time: tickerAge(a.createdAt, now),
    alertId: a.id,
  };
}

/** The ticker set: unseen alert items (only when `unlocked`), then the news. */
export function mergeTicker(news: TickerItem[], alerts: Alert[], watches: Watch[], cities: CityIndex, unlocked: boolean, now: Date = new Date()): Array<TickerItem & { alertId?: string }> {
  if (!unlocked) return news;
  const byId = new Map(watches.map((w) => [w.id, w]));
  const items = sortAlerts(alerts.filter((a) => !a.seen)).map((a) => alertTickerItem(a, byId.get(a.watchId), cities, now));
  return [...items, ...news];
}

/** Watch rule in words: `BELOW WHAT I USUALLY PAY`, `PROVIDER SAYS LOW`, `UNDER €100,000`. */
export function ruleText(rule: Watch["priceRule"]): string {
  if (rule === "below_my_median") return "BELOW WHAT I USUALLY PAY";
  if (rule === "deal_low") return "PROVIDER SAYS LOW";
  return `UNDER ${formatEur(rule.maxEur)}`;
}

/** Where `OPEN IN REPLAY` goes: the watch's template journey (and stop), else the replay page. */
export function replayPath(watch: Watch | undefined): string {
  const t = watch?.query.template;
  if (t && "journeyId" in t) {
    return `/journal/replay/${encodeURIComponent(t.journeyId)}${t.stopIndex !== undefined ? `/${t.stopIndex}` : ""}`;
  }
  return "/journal/replay";
}
