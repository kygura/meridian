// Pure helpers for the Scout screen: wording, the month strip and the settings form.
// No React, no fetch. Tested in atlasFormat.test.ts.

import type { Trip } from "../types";
import type { AtlasConfig, AtlasConfigPatch, MonthPoint, OriginSource, RunMode, RunSummary, TripIdea, WishlistPlace } from "./atlasApi";
import { formatShortDate } from "./rotation";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const monthShort = (m: number): string => MONTHS[m - 1] ?? "";
export const monthLong = (m: number): string => MONTHS_LONG[m - 1] ?? "";

// ── Origin, windows, time ────────────────────────────────────────────

export const ORIGIN_TEXT: Record<OriginSource, string> = {
  "rotation-current": "where you are now (Rotation)",
  "rotation-next": "your next stay (Rotation)",
  "rotation-home": "your home (Rotation)",
  fallback: "fallback airport",
};

/** "2 Dec to 2 Jan 2027": the year is shown once, on the end date, unless the dates sit in different years. */
export function windowText(w: { from: string; to: string }): string {
  const from = formatShortDate(w.from);
  const to = formatShortDate(w.to);
  const shortFrom = w.from.slice(0, 4) === w.to.slice(0, 4) ? from.replace(/ \d{4}$/, "") : from;
  return `${shortFrom} to ${to}`;
}

/** "3 hours ago", "2 days ago", "just now". Dates in the future read "soon". */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms < 0) return "soon";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d} ${d === 1 ? "day" : "days"} ago`;
  return `${Math.floor(d / 30)} months ago`;
}

export const RUN_MODE_LABEL: Record<RunMode, string> = { scan: "Scan", discover: "Discover", research: "Research" };

export const RUN_MODE_HINT: Record<RunMode, string> = {
  scan: "Searches fares for your best places and plans trips.",
  discover: "Looks for new places that fit the season and adds them to the wishlist.",
  research: "Checks quiet seasons and conditions for the months that need it.",
};

// ── Runs ─────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function runKindLabel(run: RunSummary): string {
  if (run.kind === "fire") return `Run requested, ${RUN_MODE_LABEL[run.mode as RunMode]?.toLowerCase() ?? run.mode}`;
  if (run.kind === "discovery") return "Discovery";
  return run.mode === "scheduled" ? "Scan, scheduled" : run.mode === "query" ? "Scan, on request" : run.mode === "watch" ? "Scan, watches" : "Scan";
}

/** One line for a run's outcome. Fire runs say whether the routine accepted the request. */
export function runSummaryText(run: RunSummary): string {
  const c = run.counts ?? {};
  if (run.kind === "fire") {
    return run.status === "failed" ? `Not started. ${run.detail ?? "The routine did not accept the request."}` : "Started. The routine reports back when it finishes.";
  }
  if (run.kind === "discovery") {
    const parts = [plural(c.candidates ?? 0, "candidate"), `${c.passed ?? 0} added`];
    if (c.unresolved) parts.push(`${c.unresolved} not found`);
    return parts.join(", ");
  }
  const parts = [plural(c.flights ?? 0, "fare"), `${c.passed ?? 0} passed`];
  if (c.rejected) parts.push(`${c.rejected} rejected`);
  if (c.watchHits) parts.push(plural(c.watchHits, "watch hit"));
  return parts.join(", ");
}

/** "Lisbon, 214 EUR" for a scan's top result, or null. */
export function runTopText(run: RunSummary): string | null {
  if (!run.top) return null;
  return `${run.top.destination}${run.top.priceEur != null ? `, ${Math.round(run.top.priceEur)} EUR` : ""}`;
}

/** Outcome tone for a badge: failed fire runs are danger, everything stored is neutral or success. */
export function runTone(run: RunSummary): "success" | "danger" | "neutral" {
  if (run.kind === "fire") return run.status === "failed" ? "danger" : "success";
  return "neutral";
}

/** "12% under the median", "5% over the median", or "no baseline yet". */
export function vsMedianText(pct: number | null): string {
  if (pct == null) return "no baseline yet";
  const r = Math.round(Math.abs(pct));
  if (r === 0) return "at the median";
  return `${r}% ${pct < 0 ? "under" : "over"} the median`;
}

export const planThisText = (idea: Pick<TripIdea, "name" | "from" | "to">): string => `Plan a trip to ${idea.name} between ${idea.from} and ${idea.to}`;

// ── Trips ────────────────────────────────────────────────────────────

export const TRIP_STATUS_LABEL: Record<Trip["status"], string> = { draft: "Draft", scouting: "Scouting", confirmed: "Confirmed" };

export function tripDatesText(trip: Pick<Trip, "nodes">): string {
  const n = trip.nodes[0];
  if (!n?.arrive) return "Dates not set";
  return n.depart ? windowText({ from: n.arrive, to: n.depart }) : formatShortDate(n.arrive);
}

// ── Month strip ──────────────────────────────────────────────────────

export interface StripCell {
  month: number;
  comfort: number | null;
  /** Ramp step 0 to 6 for the colour, or null when there is no figure. */
  step: number | null;
  best: boolean;
  avoided: boolean;
  signal?: MonthPoint["signal"];
  title: string;
}

/** The step of the sequential ramp for a 0 to 100 comfort score (same scale as When to go). */
export function comfortStep(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(6, Math.round(score / (100 / 6))));
}

function signalText(s: NonNullable<MonthPoint["signal"]>): string {
  const parts: string[] = [];
  if (s.quiet != null) parts.push(`quiet ${s.quiet} of 5`);
  if (s.conditions != null) parts.push(`conditions ${s.conditions} of 5`);
  if (s.events.length) parts.push(`events: ${s.events.map((e) => e.title).join(", ")}`);
  if (s.note) parts.push(s.note);
  return parts.join("; ");
}

/**
 * Twelve cells, January to December, for one wishlist place: comfort from `season.year`,
 * the best months marked, avoided months flagged, and any researched signal attached.
 */
export function stripCells(place: Pick<WishlistPlace, "avoidMonths" | "season">): StripCell[] {
  const bySignal = new Map(place.season.months.filter((m) => m.signal).map((m) => [m.month, m.signal!]));
  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const comfort = place.season.year ? (place.season.year[i] ?? null) : null;
    const best = place.season.bestMonths.includes(month);
    const avoided = place.avoidMonths.includes(month);
    const signal = bySignal.get(month);
    const bits = [monthLong(month), comfort == null ? "no climate data" : `comfort ${comfort}`];
    if (best) bits.push("one of the best months");
    if (avoided) bits.push("avoid");
    if (signal) bits.push(signalText(signal) || "researched");
    return { month, comfort, step: comfort == null ? null : comfortStep(comfort), best, avoided, ...(signal ? { signal } : {}), title: bits.join(". ") };
  });
}

/** Words for a place's priority, 1 to 5. */
export const PRIORITY_LABEL: Record<number, string> = { 1: "Someday", 2: "Low", 3: "Normal", 4: "High", 5: "Next chance" };

/** Budget text for a watch: "Up to 300 EUR", "From 100 EUR", "100 to 300 EUR" or "Any fare". */
export function watchBudgetText(b: { min?: number; max?: number } | undefined): string {
  if (!b || (b.min == null && b.max == null)) return "Any fare";
  if (b.min != null && b.max != null) return `${b.min} to ${b.max} EUR`;
  return b.max != null ? `Up to ${b.max} EUR` : `From ${b.min} EUR`;
}

/** Parse an optional whole-number euro amount. "" is no value; anything else invalid is NaN. */
export function parseEuro(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

// ── Settings form ────────────────────────────────────────────────────

export interface ConfigForm {
  persona: string;
  intentTags: string;
  avoid: string;
  budgetMin: string;
  budgetMax: string;
  maxStops: string;
  maxTravelTimeHours: string;
  maxLayoverWaitHours: string;
  fallbackOrigins: string;
  aMin: string;
  aMax: string;
  bMin: string;
  bMax: string;
  activityBudget: string;
}

const num = (n: number) => String(n);

/** Comma list: trimmed, empty entries dropped, repeats removed (first spelling wins). */
export function parseList(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s.split(",")) {
    const t = raw.trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function configToForm(c: AtlasConfig): ConfigForm {
  return {
    persona: c.profile.persona,
    intentTags: c.profile.intentTags.join(", "),
    avoid: c.profile.avoid.join(", "),
    budgetMin: num(c.hardFilters.budgetEconomyEur.min),
    budgetMax: num(c.hardFilters.budgetEconomyEur.max),
    maxStops: num(c.hardFilters.maxStops),
    maxTravelTimeHours: num(c.hardFilters.maxTravelTimeHours),
    maxLayoverWaitHours: num(c.hardFilters.maxLayoverWaitHours),
    fallbackOrigins: c.hardFilters.fallbackOrigins.join(", "),
    aMin: num(c.windows.a.minDays),
    aMax: num(c.windows.a.maxDays),
    bMin: num(c.windows.b.minDays),
    bMax: num(c.windows.b.maxDays),
    activityBudget: num(c.tripPreferences.activities.budgetPerDayEur),
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export type FormErrors = Partial<Record<keyof ConfigForm, string>>;

/**
 * The PATCH body for a form edit: only the fields that differ from `base`, nested as the server
 * expects. `errors` lists fields that cannot be sent (not a number, a bad airport code); when it is
 * not empty nothing should be sent.
 */
export function buildConfigPatch(base: AtlasConfig, form: ConfigForm): { patch: AtlasConfigPatch; errors: FormErrors } {
  const was = configToForm(base);
  const errors: FormErrors = {};
  const patch: AtlasConfigPatch = {};
  const changed = (k: keyof ConfigForm) => form[k].trim() !== was[k].trim();

  const number = (k: keyof ConfigForm, opts: { int?: boolean; min?: number } = {}): number | undefined => {
    if (!changed(k)) return undefined;
    const t = form[k].trim();
    const n = Number(t);
    if (!t || !Number.isFinite(n)) {
      errors[k] = "Enter a number.";
      return undefined;
    }
    if (opts.int && !Number.isInteger(n)) {
      errors[k] = "Enter a whole number.";
      return undefined;
    }
    if (n < (opts.min ?? 0)) {
      errors[k] = opts.min ? `Enter ${opts.min} or more.` : "Enter 0 or more.";
      return undefined;
    }
    return n;
  };

  const profile: NonNullable<AtlasConfigPatch["profile"]> = {};
  if (changed("persona")) {
    if (!form.persona.trim()) errors.persona = "Describe the persona in a sentence or two.";
    else profile.persona = form.persona.trim();
  }
  if (changed("intentTags") && !sameList(parseList(form.intentTags), base.profile.intentTags)) profile.intentTags = parseList(form.intentTags);
  if (changed("avoid") && !sameList(parseList(form.avoid), base.profile.avoid)) profile.avoid = parseList(form.avoid);
  if (Object.keys(profile).length) patch.profile = profile;

  const hard: NonNullable<AtlasConfigPatch["hardFilters"]> = {};
  const bMin = number("budgetMin");
  const bMax = number("budgetMax");
  if (bMin !== undefined || bMax !== undefined) {
    hard.budgetEconomyEur = { ...(bMin !== undefined ? { min: bMin } : {}), ...(bMax !== undefined ? { max: bMax } : {}) };
  }
  const stops = number("maxStops", { int: true });
  if (stops !== undefined) hard.maxStops = stops;
  const hours = number("maxTravelTimeHours");
  if (hours !== undefined) hard.maxTravelTimeHours = hours;
  const layover = number("maxLayoverWaitHours");
  if (layover !== undefined) hard.maxLayoverWaitHours = layover;
  if (changed("fallbackOrigins")) {
    const codes = parseList(form.fallbackOrigins).map((c) => c.toUpperCase());
    if (!codes.length) errors.fallbackOrigins = "Enter at least one airport code.";
    else if (codes.some((c) => !/^[A-Z]{3}$/.test(c))) errors.fallbackOrigins = "Use 3-letter airport codes, separated by commas.";
    else if (!sameList(codes, base.hardFilters.fallbackOrigins)) hard.fallbackOrigins = codes;
  }
  if (Object.keys(hard).length) patch.hardFilters = hard;

  const win = (key: "a" | "b", minK: keyof ConfigForm, maxK: keyof ConfigForm) => {
    const min = number(minK, { int: true });
    const max = number(maxK, { int: true });
    if (min !== undefined || max !== undefined) {
      patch.windows = { ...patch.windows, [key]: { ...(min !== undefined ? { minDays: min } : {}), ...(max !== undefined ? { maxDays: max } : {}) } };
    }
  };
  win("a", "aMin", "aMax");
  win("b", "bMin", "bMax");

  const act = number("activityBudget");
  if (act !== undefined) patch.tripPreferences = { activities: { budgetPerDayEur: act } };

  // Cross-field checks the server also makes, so the owner sees them next to the field.
  const merged = { ...was, ...Object.fromEntries((Object.keys(form) as (keyof ConfigForm)[]).map((k) => [k, form[k].trim()])) } as ConfigForm;
  if (!errors.budgetMin && !errors.budgetMax && Number(merged.budgetMin) > Number(merged.budgetMax)) errors.budgetMax = "The maximum is below the minimum.";
  if (!errors.aMin && !errors.aMax && Number(merged.aMin) > Number(merged.aMax)) errors.aMax = "The latest day is before the earliest.";
  if (!errors.bMin && !errors.bMax && Number(merged.bMin) > Number(merged.bMax)) errors.bMax = "The latest day is before the earliest.";

  return { patch, errors };
}

/** Map server `issues` (zod issues from a 400) to a message per form field where the path is known. */
export function issuesToErrors(issues: unknown): { fields: FormErrors; general: string[] } {
  const fields: FormErrors = {};
  const general: string[] = [];
  const paths: Record<string, keyof ConfigForm> = {
    "profile.persona": "persona",
    "profile.intentTags": "intentTags",
    "profile.avoid": "avoid",
    "hardFilters.budgetEconomyEur.min": "budgetMin",
    "hardFilters.budgetEconomyEur.max": "budgetMax",
    "hardFilters.budgetEconomyEur": "budgetMax",
    "hardFilters.maxStops": "maxStops",
    "hardFilters.maxTravelTimeHours": "maxTravelTimeHours",
    "hardFilters.maxLayoverWaitHours": "maxLayoverWaitHours",
    "hardFilters.fallbackOrigins": "fallbackOrigins",
    "windows.a.minDays": "aMin",
    "windows.a.maxDays": "aMax",
    "windows.a": "aMax",
    "windows.b.minDays": "bMin",
    "windows.b.maxDays": "bMax",
    "windows.b": "bMax",
    "tripPreferences.activities.budgetPerDayEur": "activityBudget",
  };
  const key = (path: string): keyof ConfigForm | null => paths[path] ?? null;
  if (!Array.isArray(issues)) return { fields, general };
  for (const raw of issues) {
    const issue = raw as { path?: unknown[]; message?: string };
    const message = issue.message ?? "Not accepted.";
    const path = (issue.path ?? []).filter((p) => typeof p === "string").join(".");
    const k = key(path) ?? (path.startsWith("hardFilters.fallbackOrigins") ? "fallbackOrigins" : null);
    if (k && !fields[k]) fields[k] = message;
    else general.push(path ? `${path}: ${message}` : message);
  }
  return { fields, general };
}
