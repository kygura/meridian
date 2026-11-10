// What one passport set may do in one destination on one date (ADR 0012). Pure.
//
// Order of evidence: the curated file (Schengen and other zones, dated regimes that are newer
// or more specific than the dataset), then the Passport Index dataset, then nothing. With
// several passports, the one with the easiest entry is used and named.

import { CURATED, SCHENGEN, cellOf, countryName, inSchengenIso, type Cell, type EntryStatus, type Regime, type SourceRef, type VisaData } from "./data";

export type Limit = { kind: "per-entry"; days: number } | { kind: "rolling"; days: number; windowDays: number } | { kind: "calendar-year"; days: number };

export interface EntryRule {
  destination: string;
  destinationName: string;
  /** The passport whose entry is easiest here, or null when none is known. */
  passport: string | null;
  status: EntryStatus;
  /** The days limit and how it counts; null when there is none or it is not known. */
  limit: Limit | null;
  /** Days shared with other countries ("schengen"); otherwise the country's own count. */
  pool: string | null;
  /** How the limit was found. */
  basis: "zone" | "curated" | "dataset" | "none";
  extension?: { days: number; times: number; note: string };
  landEntriesPerYear?: number;
  notes: string[];
  sources: (SourceRef & { checked?: string })[];
}

const RANK: Record<EntryStatus, number> = {
  home: 0,
  "free-movement": 1,
  "visa-free": 2,
  "visa-on-arrival": 3,
  eta: 4,
  "e-visa": 5,
  "visa-required": 6,
  "no-admission": 7,
  unknown: 8,
};

/** Statuses that let you arrive without applying for anything in advance (an ETA is an online form). */
export const ARRIVE_OK: ReadonlySet<EntryStatus> = new Set<EntryStatus>(["home", "free-movement", "visa-free", "visa-on-arrival", "eta"]);

export const STATUS_LABEL: Record<EntryStatus, string> = {
  home: "Your own country",
  "free-movement": "Free movement",
  "visa-free": "No visa needed",
  "visa-on-arrival": "Visa on arrival",
  eta: "Travel authorisation (ETA) needed",
  "e-visa": "E-visa needed",
  "visa-required": "Visa needed before you go",
  "no-admission": "Entry not permitted",
  unknown: "No data",
};

export const DATASET_COUNTING_NOTE =
  "The dataset gives days but not how they are counted; Meridian counts them per entry unless a curated rule says otherwise.";

function datasetSource(data: VisaData): SourceRef & { checked?: string } {
  const s = data.sources.requirements;
  return { title: `${s?.name ?? "Passport Index Data"} (dataset of ${s?.datasetUpdated ?? s?.fetchedAt ?? "unknown date"})`, url: s?.url ?? "", checked: s?.fetchedAt };
}

function regimeApplies(r: Regime, status: EntryStatus, cell: Cell, onDate: string): boolean {
  if (r.validFrom && onDate < r.validFrom) return false;
  if (r.validUntil && onDate > r.validUntil) return false;
  const ok =
    r.appliesTo === "visa-free"
      ? status === "visa-free"
      : r.appliesTo === "visa-on-arrival"
        ? status === "visa-on-arrival"
        : status === "visa-free" || status === "eta";
  if (!ok) return false;
  if (r.onlyWhenDatasetDaysAtMost !== undefined && cell.days !== null && cell.days > r.onlyWhenDatasetDaysAtMost) return false;
  return true;
}

/**
 * The entry rule for `destination` (ISO-2) with these passports, for an arrival on `onDate`.
 * Without data for the destination the status is "unknown" and nothing is assumed.
 */
export function entryRule(data: VisaData, passports: string[], destination: string, onDate: string): EntryRule {
  const name = countryName(data, destination);
  const base: EntryRule = { destination, destinationName: name, passport: null, status: "unknown", limit: null, pool: null, basis: "none", notes: [], sources: [] };
  if (!passports.length) return { ...base, notes: ["Add your passport in Settings › Visas to check entry rules."] };

  // Free movement inside the Schengen and EU/EEA area.
  if (inSchengenIso(destination) || SCHENGEN.freeMovement.includes(destination)) {
    const free = passports.find((p) => SCHENGEN.freeMovement.includes(p));
    if (free && SCHENGEN.freeMovement.includes(destination)) {
      return { ...base, passport: free, status: free === destination ? "home" : "free-movement", basis: "zone", notes: [SCHENGEN.freeMovementNote], sources: SCHENGEN.sources.map((s) => ({ ...s, checked: SCHENGEN.checked })) };
    }
  }

  // The easiest passport by the dataset.
  let best: { p: string; cell: Cell } | null = null;
  for (const p of passports) {
    const cell = cellOf(data, p, destination);
    if (!best || RANK[cell.status] < RANK[best.cell.status] || (RANK[cell.status] === RANK[best.cell.status] && (cell.days ?? 0) > (best.cell.days ?? 0))) best = { p, cell };
  }
  const { p, cell } = best!;
  const rule: EntryRule = { ...base, passport: p, status: cell.status };
  if (cell.status === "home" || cell.status === "unknown" || cell.status === "no-admission") {
    if (cell.status === "unknown") rule.notes.push(`No entry data for ${name} with ${passports.map((x) => countryName(data, x)).join(" or ")} passports.`);
    else if (cell.status !== "home") rule.sources.push(datasetSource(data));
    return rule;
  }
  rule.sources.push(datasetSource(data));

  // Schengen: one 90/180 count for the whole area.
  if (inSchengenIso(destination)) {
    rule.limit = { kind: "rolling", days: SCHENGEN.days, windowDays: SCHENGEN.windowDays };
    rule.pool = SCHENGEN.id;
    rule.basis = "zone";
    rule.notes.push(`${SCHENGEN.name}: ${SCHENGEN.days} days in any ${SCHENGEN.windowDays}, counted across all ${SCHENGEN.members.length} member countries. ${SCHENGEN.counting}`);
    if (cell.status === "visa-required" || cell.status === "e-visa") rule.notes.push("A short-stay Schengen visa is needed first; its days count against the same 90 in 180.");
    for (const s of SCHENGEN.sources) rule.sources.push({ ...s, checked: SCHENGEN.checked });
    return rule;
  }
  if (SCHENGEN.outside[destination]) rule.notes.push(SCHENGEN.outside[destination]);

  if (cell.status === "visa-required") {
    rule.notes.push("The visa you get decides how long you can stay; Meridian cannot count it.");
    return rule;
  }

  const regimes = CURATED.regimes.filter((r) => r.destination === destination && regimeApplies(r, cell.status, cell, onDate));
  const regime = regimes[0];
  if (regime) {
    rule.basis = "curated";
    const days = regime.days ?? cell.days;
    if (regime.kind === "rolling" && days) rule.limit = { kind: "rolling", days: cell.days ? Math.min(days, cell.days) : days, windowDays: regime.windowDays ?? 180 };
    else if (regime.kind === "calendar-year" && days) rule.limit = { kind: "calendar-year", days };
    else if (days) rule.limit = { kind: "per-entry", days };
    if (regime.extension) rule.extension = regime.extension;
    if (regime.landEntriesPerYear) rule.landEntriesPerYear = regime.landEntriesPerYear;
    rule.notes.push(regime.note);
    rule.sources.unshift({ ...regime.source, checked: regime.checked });
    return rule;
  }
  if (cell.days) {
    rule.limit = { kind: "per-entry", days: cell.days };
    rule.basis = "dataset";
    rule.notes.push(DATASET_COUNTING_NOTE);
  } else {
    rule.notes.push("The dataset gives no number of days for this entry.");
  }
  if (cell.status === "e-visa") rule.notes.push("Apply for the e-visa before you travel; the days are the e-visa's.");
  if (cell.status === "eta") rule.notes.push("Apply for the travel authorisation online before you travel.");
  return rule;
}

export function limitLabel(l: Limit | null): string {
  if (!l) return "no day limit known";
  if (l.kind === "per-entry") return `${l.days} days per entry`;
  if (l.kind === "rolling") return `${l.days} days in any ${l.windowDays}`;
  return `${l.days} days a calendar year`;
}
