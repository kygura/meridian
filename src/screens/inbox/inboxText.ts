// Plain-words copy for the inbox (DESIGN-v3 §1.2, §6 Inbox). Pure: no React, no fetch.
// The older helpers in lib/inbox.ts return upper-case teletype strings; these are the sentence-case
// equivalents the v3 screen renders. Structural helpers (clusterMembers, looseCandidates,
// suggestedJourneys, searchJourneys, cityFixes, isUnresolved) are still imported from lib/inbox.

import { cityFixes } from "../../lib/inbox";
import type { CityIndex } from "../../lib/journal";
import type { ImportCandidate, ImportReport, Provenance, SegmentMode } from "../../types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const n = (v: number) => v.toLocaleString("en-US");

/** "3 items", "1 item". */
export function count(v: number, one: string, many = `${one}s`): string {
  return `${n(v)} ${v === 1 ? one : many}`;
}

function parts(s: string): [number, number, number] {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return [y, m, d];
}

/** "14 May". */
export function day(s: string): string {
  const [, m, d] = parts(s);
  return `${d} ${MONTHS[m - 1] ?? "?"}`;
}

/** "12–20 May 2024", "28 May – 2 Jun 2024", "31 Dec 2023 – 3 Jan 2024", "14 May 2024". */
export function dateRange(a: string, b: string): string {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  const A = MONTHS[ma - 1] ?? "?";
  const B = MONTHS[mb - 1] ?? "?";
  if (ya !== yb) return `${da} ${A} ${ya} – ${db} ${B} ${yb}`;
  if (ma !== mb) return `${da} ${A} – ${db} ${B} ${yb}`;
  return da === db ? `${da} ${A} ${ya}` : `${da}–${db} ${A} ${ya}`;
}

// ── Candidates ───────────────────────────────────────────────────────

const MODE_WORD: Record<SegmentMode, string> = { flight: "Flight", train: "Train", bus: "Bus", car: "Drive", ferry: "Ferry", other: "Travel" };

/** "Flight", "Train", "Stay", "Experience", "Stop". */
export function kindWord(c: Pick<ImportCandidate, "kind" | "payload">): string {
  switch (c.kind) {
    case "segment":
      return MODE_WORD[c.payload.mode ?? "flight"] ?? "Travel";
    case "lodging":
      return "Stay";
    case "experience":
      return "Experience";
    default:
      return "Stop";
  }
}

/** City name when known, else the hint the import carried, else "Unknown place". */
export function placeName(id: string | undefined, iata: string | undefined, hint: string | undefined, cities: CityIndex): string {
  const c = id ? cities.get(id) : undefined;
  if (c) return c.name;
  return hint ?? iata ?? "Unknown place";
}

/** The main line for a candidate: "TP1023 · Lisbon → Porto", "Hotel Baixa, Lisbon", "Lisbon". */
export function candidateTitle(c: ImportCandidate, cities: CityIndex): string {
  const p = c.payload;
  const here = placeName(p.cityId, p.iataHint, p.cityHint, cities);
  switch (c.kind) {
    case "segment": {
      const code = p.number && /[A-Za-z]/.test(p.number) ? p.number : [p.carrier, p.number].filter(Boolean).join(" ");
      const route = `${placeName(p.fromCityId, p.iataHint, p.cityHint, cities)} → ${placeName(p.toCityId, p.toIataHint, p.toCityHint, cities)}`;
      return code ? `${code} · ${route}` : route;
    }
    case "lodging":
      return `${p.lodging?.name ?? p.name ?? "Stay"}, ${here}`;
    case "experience":
      return `${p.title ?? "Experience"}, ${here}`;
    default:
      return here;
  }
}

/** The candidate's dates in words: "14 May", "14 – 17 May". Empty when it has none. */
export function candidateWhen(c: ImportCandidate): string {
  const p = c.payload;
  if (c.kind === "segment") return p.departAt ? day(p.departAt) : "";
  if (c.kind === "experience") return p.date ? day(p.date) : "";
  if (!p.arrive) return "";
  return p.depart && p.depart.slice(0, 10) !== p.arrive.slice(0, 10) ? `${day(p.arrive)} – ${day(p.depart)}` : day(p.arrive);
}

const SOURCE_WORD: Record<Provenance["source"], string> = {
  manual: "Added by hand",
  booking: "Booking",
  gmail: "Email",
  jsonld: "Email",
  calendar: "Calendar",
  timeline: "Location history",
  photo: "Photos",
};

/** Where an item came from, in words. Agent drafts carry an "agent:" sourceRef. */
export function sourceWord(p: Provenance): string {
  if (p.sourceRef?.startsWith("agent:")) return "Suggested by Ask";
  return SOURCE_WORD[p.source] ?? "Import";
}

/** Review notes in plain words: "Pick the city for “Oporto Cty”", "Low confidence". */
export function flagNotes(c: ImportCandidate, cities?: CityIndex): string[] {
  const out: string[] = [];
  for (const f of c.flags ?? []) {
    if (f === "unresolved-city") {
      const hints = cityFixes(c, cities).map((x) => `“${x.hint}”`);
      out.push(hints.length ? `Pick the city for ${hints.join(" and ")}` : "Pick the city");
    } else {
      const words = f.replace(/[-_]+/g, " ").trim();
      if (words) out.push(words.charAt(0).toUpperCase() + words.slice(1).toLowerCase());
    }
  }
  if (c.provenance.confidence === "low" && !c.flags?.includes("unresolved-city")) out.push("Low confidence");
  return out;
}

/** Label beside the inline city picker. */
export function fixLabel(field: "cityId" | "fromCityId" | "toCityId", hint: string): string {
  if (field === "fromCityId") return `From “${hint}”`;
  if (field === "toCityId") return `To “${hint}”`;
  return `City for “${hint}”`;
}

// ── Queue ────────────────────────────────────────────────────────────

/** "37 items in 6 suggested trips", "1 item". */
export function queueSummary(items: number, clusters: number): string {
  const head = count(items, "item");
  return clusters ? `${head} in ${count(clusters, "suggested trip")}` : head;
}

// ── Reports ──────────────────────────────────────────────────────────

/** Notes from lib/importUpload are upper case ("CANCELLED"); turn any all-caps chunk into a sentence. */
export function noteText(note: string | undefined): string | undefined {
  if (!note) return undefined;
  const chunks = note
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s));
  return chunks.length ? chunks.join(". ") : undefined;
}

/** One-line summary of an upload: "8 added, 4 already in your inbox or journal, 2 emails without booking details". */
export function reportSummary(r: ImportReport & { note?: string }): string {
  if (r.received === 0 && r.added === 0 && r.duplicates === 0) return noteText(r.note) ?? "Nothing new found";
  const bits = [r.added ? `${n(r.added)} new ${r.added === 1 ? "item" : "items"} to review` : "Nothing new to review"];
  if (r.duplicates) bits.push(`${n(r.duplicates)} already seen`);
  if (r.unstructured) bits.push(`${count(r.unstructured, "email")} without booking details`);
  const note = noteText(r.note);
  return bits.join(", ") + "." + (note ? ` ${note}.` : "");
}

/** "Reading 412 of 1,280 photos on this device". */
export function progressLine(done: number, total: number): string {
  return `Reading ${n(done)} of ${count(total, "photo")} on this device`;
}

// ── Errors ───────────────────────────────────────────────────────────

/** Sentence-case message for a failed inbox action or upload. */
export function errorText(e: unknown): string {
  const err = (e ?? {}) as { status?: number; code?: string; name?: string };
  if (err.name === "JournalNetworkError") return "Couldn't reach the server. Try again.";
  switch (err.code) {
    case "not_pending":
      return "Already reviewed elsewhere. The list was refreshed.";
    case "unresolved":
      return "Some cities still need picking first.";
    case "journey_changed":
      return "That trip changed in the meantime. Try again.";
    case "journey_not_found":
      return "That trip no longer exists.";
    case "cluster_not_found":
    case "not_found":
      return "That item is gone. The list was refreshed.";
    case "no_stops":
      return "No stop could be worked out from these items.";
    case "too_large":
      return "That file is too large.";
    case "too_many":
      return "Too many items in one upload.";
    case "fx_unavailable":
      return "No exchange rate is available for a price yet. Try again later.";
    case "invalid_json":
      return "That file couldn't be read. Pick a location history export.";
    case "no_images":
      return "There are no images in that selection.";
  }
  if (err.status === 413) return "That file is too large.";
  if (err.status === 422) return "The server couldn't read that.";
  return "Something went wrong. Try again.";
}
