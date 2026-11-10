// Visa, entry-requirement and residency day counting (ADR 0012). Pure: no clock, no I/O.
// Works from (passports, list of country + date range): the journal's past stops, planned
// trip stops and Rotation Stays all reduce to that.
//
//   checkStays(data, passports, stays, opts)  per-stay verdicts and whole-plan violations
//   schengenTimeline / schengenOn / earliestEntry / maxStayFrom   the 90/180 window
//   countLimits(presence, limits)              the counting core, shared with the solver
//   taxDays(presence, opts)                    tax-residency day counters
//   borderRunOptions(...), schengenBuffers(...) where to go when a limit is reached
//
// Day rule: a stay from `start` to `end` (the move-out or departure day) is present on every
// day from start to end inclusive, as border counts do (entry and exit days count).

import { haversineKm } from "../geo";
import { CURATED, SCHENGEN, VISA_DISCLAIMER, countryName, inSchengenIso, isoOf, type SourceRef, type TaxRule, type VisaData, type YellowFeverRow } from "./data";
import { addRange, dayIso, dayNum, daysWithin, firstOver, peakUse, usedOn, yearOf, type Ranges } from "./days";
import { ARRIVE_OK, entryRule, limitLabel, type EntryRule, type Limit } from "./rules";

// ── Inputs ────────────────────────────────────────────────────────────

export interface StayInput {
  id: string;
  /** Country name (any spelling the app uses) or ISO-2 code. */
  country: string;
  start: string;
  /** Departure or move-out day; that day counts as present. */
  end: string;
  label?: string;
  /** From the journal: already happened. */
  past?: boolean;
  /** Dates not fixed yet (a month window). */
  tentative?: boolean;
}

/** One presence range with the country resolved. */
export interface Presence {
  id: string;
  country: string | null;
  start: number;
  end: number;
  label: string;
  past: boolean;
  tentative: boolean;
}

/** A limit to count against: a country's own, a zone's (Schengen) or one the owner typed. */
export interface CountLimit {
  /** "schengen", or a country code. */
  key: string;
  label: string;
  countries: string[];
  limit: Limit;
  source: string;
  origin: "zone" | "curated" | "dataset" | "owner";
}

export interface Violation {
  key: string;
  kind: Limit["kind"] | "no-admission";
  country: string;
  label: string;
  /** First day you would be over the limit. */
  firstOver: string;
  /** Most days counted (in the window, the entry or the year). */
  days: number;
  limit: string;
  stayIds: string[];
  message: string;
  source: string;
}

export interface OwnerRule {
  country: string;
  maxDaysPerEntry?: number;
  maxDaysIn?: { days: number; windowDays: number };
  maxDaysPerYear?: number;
  note?: string;
}

export interface CheckOptions {
  /** ISO date; verdicts before it are history. */
  today?: string;
  /** Passport expiry by passport code, for the validity check. */
  expiry?: Record<string, string | undefined>;
  /** The owner's own rules; they replace the data's limit for the same country. */
  overrides?: OwnerRule[];
}

export type VerdictLevel = "ok" | "near" | "over" | "visa" | "blocked" | "unknown" | "free";

export interface PassportValidity {
  rule: string | null;
  quote: string;
  url: string;
  updated: string;
  /** Your passport must be valid until at least this day. */
  requiredUntil: string | null;
  /** True/false when the owner gave the expiry; null otherwise. */
  ok: boolean | null;
}

export interface YellowFeverFlag {
  requirement: "all" | "from-risk" | null;
  risk: YellowFeverRow["risk"];
  age?: string;
  /** An earlier stay on this plan is in a WHO risk country, so a "from risk countries" rule applies. */
  triggeredBy: string | null;
  message: string;
  source: SourceRef;
}

export interface StayVerdict {
  id: string;
  country: string | null;
  countryName: string;
  rule: EntryRule | null;
  level: VerdictLevel;
  plannedDays: number;
  /** Days the limit allows for this stay, given what came before; null when unlimited or unknown. */
  allowedDays: number | null;
  /** First day over, when the stay goes over. */
  overFrom: string | null;
  message: string;
  validity: PassportValidity | null;
  yellowFever: YellowFeverFlag | null;
  limitSource: string | null;
}

export interface CheckResult {
  verdicts: StayVerdict[];
  violations: Violation[];
  limits: CountLimit[];
  passports: string[];
  notes: string[];
  disclaimer: string;
}

// ── Presence ─────────────────────────────────────────────────────────

export function toPresence(data: VisaData | null, stays: StayInput[]): Presence[] {
  return stays
    .filter((s) => s.start && s.end && s.end >= s.start)
    .map((s) => ({ id: s.id, country: isoOf(data, s.country), start: dayNum(s.start), end: dayNum(s.end), label: s.label ?? s.country, past: !!s.past, tentative: !!s.tentative }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function rangesOf(p: Presence[], countries: readonly string[]): Ranges {
  let r: Ranges = [];
  for (const x of p) if (x.country && countries.includes(x.country)) r = addRange(r, x.start, x.end);
  return r;
}

/** Entries into one country: presence that overlaps or shares a day joins one entry. */
export function entriesOf(p: Presence[], countries: readonly string[]): { start: number; end: number; ids: string[] }[] {
  const mine = p.filter((x) => x.country && countries.includes(x.country)).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number; ids: string[] }[] = [];
  for (const x of mine) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) {
      last.end = Math.max(last.end, x.end);
      last.ids.push(x.id);
    } else out.push({ start: x.start, end: x.end, ids: [x.id] });
  }
  return out;
}

// ── The counting core ────────────────────────────────────────────────

/** Every limit broken by this presence, with the first day over. `from` ignores breaches that ended before it. */
export function countLimits(p: Presence[], limits: CountLimit[], from = -Infinity): Violation[] {
  const out: Violation[] = [];
  for (const L of limits) {
    const touching = (a: number, b: number) => p.filter((x) => x.country && L.countries.includes(x.country) && x.start <= b && a <= x.end).map((x) => x.id);
    if (L.limit.kind === "rolling") {
      const r = rangesOf(p, L.countries);
      const over = firstOver(r, L.limit.days, L.limit.windowDays, from);
      if (over === null) continue;
      const peak = peakUse(r, L.limit.windowDays, over, Infinity);
      out.push({
        key: L.key,
        kind: "rolling",
        country: L.key,
        label: L.label,
        firstOver: dayIso(over),
        days: Math.max(peak.used, usedOn(r, over, L.limit.windowDays)),
        limit: limitLabel(L.limit),
        stayIds: touching(over - L.limit.windowDays + 1, over),
        message: `${L.label}: ${usedOn(r, over, L.limit.windowDays)} days in the ${L.limit.windowDays} to ${dayIso(over)}, over ${L.limit.days}.`,
        source: L.source,
      });
    } else if (L.limit.kind === "per-entry") {
      for (const e of entriesOf(p, L.countries)) {
        const days = e.end - e.start + 1;
        if (days <= L.limit.days || e.end < from) continue;
        const overDay = e.start + L.limit.days;
        out.push({
          key: L.key,
          kind: "per-entry",
          country: L.key,
          label: L.label,
          firstOver: dayIso(overDay),
          days,
          limit: limitLabel(L.limit),
          stayIds: e.ids,
          message: `${L.label}: one entry of ${days} days from ${dayIso(e.start)}, over ${L.limit.days}. Day ${L.limit.days + 1} is ${dayIso(overDay)}.`,
          source: L.source,
        });
      }
    } else {
      const r = rangesOf(p, L.countries);
      const years = new Set<number>();
      for (const [a, b] of r) for (let y = yearOf(a); y <= yearOf(b); y++) years.add(y);
      for (const y of [...years].sort()) {
        const y0 = dayNum(`${y}-01-01`);
        const y1 = dayNum(`${y}-12-31`);
        const days = daysWithin(r, y0, y1);
        if (days <= L.limit.days || y1 < from) continue;
        // The day the count passes the limit.
        let n = 0;
        let overDay = y1;
        for (const [a, b] of r) {
          if (b < y0 || a > y1) continue;
          const lo = Math.max(a, y0);
          const hi = Math.min(b, y1);
          if (n + (hi - lo + 1) > L.limit.days) {
            overDay = lo + (L.limit.days - n);
            break;
          }
          n += hi - lo + 1;
        }
        out.push({
          key: L.key,
          kind: "calendar-year",
          country: L.key,
          label: L.label,
          firstOver: dayIso(overDay),
          days,
          limit: limitLabel(L.limit),
          stayIds: touching(y0, y1),
          message: `${L.label}: ${days} days in ${y}, over ${L.limit.days}.`,
          source: L.source,
        });
      }
    }
  }
  return out.sort((a, b) => a.firstOver.localeCompare(b.firstOver) || a.key.localeCompare(b.key));
}

export interface LimitUsage {
  limit: CountLimit;
  /** Most days counted from `from` on (window, entry or year), and the day it peaks. */
  peak: number;
  peakOn: string | null;
  /** Days counted on `from` itself (window ending then, the entry under way, the year so far). */
  now: number;
  over: boolean;
}

/** How close each limit comes, from a day on: for the Days page counters. */
export function limitUsage(p: Presence[], limits: CountLimit[], from: number): LimitUsage[] {
  return limits.map((L) => {
    const r = rangesOf(p, L.countries);
    let peak = 0;
    let peakOn: number | null = null;
    let now = 0;
    if (L.limit.kind === "rolling") {
      const pk = peakUse(r, L.limit.windowDays, from, Infinity);
      const live = usedOn(r, from, L.limit.windowDays);
      peak = Math.max(pk.day !== null && pk.day >= from ? pk.used : 0, live);
      peakOn = pk.day !== null && pk.day >= from && pk.used >= live ? pk.day : from;
      now = live;
    } else if (L.limit.kind === "per-entry") {
      for (const e of entriesOf(p, L.countries)) {
        if (e.end < from) continue;
        const days = e.end - e.start + 1;
        if (days > peak) {
          peak = days;
          peakOn = e.end;
        }
        if (e.start <= from && from <= e.end) now = from - e.start + 1;
      }
    } else {
      const y0 = yearOf(from);
      for (const y of [y0, y0 + 1]) {
        const days = daysWithin(r, dayNum(`${y}-01-01`), dayNum(`${y}-12-31`));
        if (days > peak) {
          peak = days;
          peakOn = dayNum(`${y}-12-31`);
        }
      }
      now = daysWithin(r, dayNum(`${y0}-01-01`), from);
    }
    return { limit: L, peak, peakOn: peakOn !== null ? dayIso(peakOn) : null, now, over: peak > L.limit.days };
  });
}

/** A limit from an owner-typed rule (the solver's country rules, ADR 0015). */
export function ownerLimits(data: VisaData | null, rules: OwnerRule[]): CountLimit[] {
  const out: CountLimit[] = [];
  for (const r of rules) {
    const code = isoOf(data, r.country);
    if (!code) continue;
    const src = r.note ? `Your rule: ${r.note}` : "Your rule";
    if (r.maxDaysPerEntry) out.push({ key: code, label: r.country, countries: [code], limit: { kind: "per-entry", days: r.maxDaysPerEntry }, source: src, origin: "owner" });
    if (r.maxDaysIn) out.push({ key: code, label: r.country, countries: [code], limit: { kind: "rolling", ...r.maxDaysIn }, source: src, origin: "owner" });
    if (r.maxDaysPerYear) out.push({ key: code, label: r.country, countries: [code], limit: { kind: "calendar-year", days: r.maxDaysPerYear }, source: src, origin: "owner" });
  }
  return out;
}

/**
 * The limits that apply to these passports in these countries: Schengen once for the area,
 * each other country's own (read for the first arrival there), and the owner's rules in place
 * of the data's for their countries.
 */
export function limitsFor(data: VisaData, passports: string[], firstArrival: Map<string, string>, overrides: OwnerRule[] = []): CountLimit[] {
  const own = ownerLimits(data, overrides);
  const owned = new Set(own.map((l) => l.key));
  const limits: CountLimit[] = [...own];
  let schengenAdded = false;
  for (const [c, onDate] of [...firstArrival.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (owned.has(c) || !passports.length) continue;
    const rule = entryRule(data, passports, c, onDate);
    if (!rule.limit) continue;
    if (rule.pool === SCHENGEN.id) {
      if (schengenAdded) continue;
      schengenAdded = true;
      limits.push({ key: SCHENGEN.id, label: SCHENGEN.name, countries: SCHENGEN.members, limit: rule.limit, source: SCHENGEN.sources[1]?.title ?? SCHENGEN.sources[0].title, origin: "zone" });
      continue;
    }
    limits.push({ key: c, label: rule.destinationName, countries: [c], limit: rule.limit, source: rule.sources[0]?.title ?? "", origin: rule.basis === "curated" ? "curated" : "dataset" });
  }
  return limits;
}

/** First arrival per country in a presence list (future stays first, else the earliest). */
export function firstArrivals(p: Presence[]): Map<string, string> {
  const m = new Map<string, string>();
  const future = p.filter((x) => !x.past);
  for (const x of [...future, ...p]) if (x.country && !m.has(x.country)) m.set(x.country, dayIso(x.start));
  return m;
}

// ── Passport validity and yellow fever ───────────────────────────────

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const k = y * 12 + (m - 1) + months;
  const ny = Math.floor(k / 12);
  const nm = (k % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function passportValidity(data: VisaData, destination: string, arrive: string, depart: string, expiry?: string): PassportValidity | null {
  const v = data.validity[destination];
  if (!v) return null;
  let requiredUntil: string | null = null;
  let rule: string | null = null;
  if (v.rule) {
    const base = v.rule.from === "arrival" ? arrive : depart;
    requiredUntil = v.rule.unit === "months" ? addMonths(base, v.rule.amount) : dayIso(dayNum(base) + v.rule.amount);
    rule = v.rule.amount === 0 ? "Valid for the whole stay" : `Valid ${v.rule.amount} ${v.rule.unit} beyond the day you ${v.rule.from === "arrival" ? "arrive" : "leave"}`;
  }
  return { rule, quote: v.quote, url: v.url, updated: v.updated, requiredUntil, ok: expiry && requiredUntil ? expiry >= requiredUntil : null };
}

const YF = new Map(CURATED.yellowFever.rows.filter((r) => r.c).map((r) => [r.c!, r]));

/** `arrivingFrom`: the country (code and name) of the stay just before, if any. */
export function yellowFever(destination: string, arrivingFrom: { code: string; name: string } | null): YellowFeverFlag | null {
  const row = YF.get(destination);
  if (!row || !row.from) {
    if (row && row.risk !== "no") return { requirement: null, risk: row.risk, triggeredBy: null, message: `WHO lists ${row.risk === "part" ? "parts of the country" : "the country"} as at risk of yellow fever; no certificate is required on entry, but vaccination may be recommended.`, source: CURATED.yellowFever.source };
    return null;
  }
  const source = CURATED.yellowFever.source;
  const age = row.age ? ` (travellers aged ${row.age} and over)` : "";
  if (row.from === "all") return { requirement: "all", risk: row.risk, age: row.age, triggeredBy: null, message: `Yellow fever certificate required of every traveller${age}.`, source };
  const prev = arrivingFrom ? YF.get(arrivingFrom.code) : undefined;
  const trigger = prev && prev.risk !== "no" ? arrivingFrom!.name : undefined;
  return {
    requirement: "from-risk",
    risk: row.risk,
    age: row.age,
    triggeredBy: trigger ?? null,
    message: trigger ? `Certificate required: you arrive after a stay in ${trigger}, a WHO yellow-fever risk country${age}.` : `Certificate required only if you arrive from (or transit through) a WHO yellow-fever risk country${age}.`,
    source,
  };
}

// ── Per-stay verdicts and the whole plan ─────────────────────────────

/** Days counted before `day` that still sit in the window, and what is left for a stay starting then. */
function allowedFrom(limit: Limit, r: Ranges, entryStart: number, start: number): number {
  if (limit.kind === "per-entry") return limit.days - (start - entryStart);
  if (limit.kind === "calendar-year") return limit.days - daysWithin(r, dayNum(`${yearOf(start)}-01-01`), start - 1);
  return maxStayFrom(r, start, limit.days, limit.windowDays);
}

/**
 * Check a list of stays for these passports: one verdict per stay (entry requirement, days
 * allowed against days planned, passport validity, yellow fever) and the whole plan's
 * violations (Schengen 90/180, rolling windows, per-entry and calendar-year limits).
 */
export function checkStays(data: VisaData, passports: string[], stays: StayInput[], opts: CheckOptions = {}): CheckResult {
  const presence = toPresence(data, stays);
  const notes: string[] = [];
  const limits = limitsFor(data, passports, firstArrivals(presence), opts.overrides);
  if (!passports.length) notes.push("No passport set: only your own rules were counted. Add your passport in Settings › Visas.");
  const from = opts.today ? dayNum(opts.today) : -Infinity;
  const violations = countLimits(presence, limits, from);
  const verdicts: StayVerdict[] = [];
  const seen: { code: string; name: string }[] = [];
  for (const s of presence) {
    const planned = s.end - s.start + 1;
    const code = s.country;
    const name = code ? countryName(data, code) : (stays.find((x) => x.id === s.id)?.country ?? "Unknown");
    // Read for this stay's own arrival day: dated rules (Thailand from 15 September 2026) apply per entry.
    const rule = code && passports.length ? entryRule(data, passports, code, dayIso(s.start)) : null;
    const own = code ? limits.find((l) => l.origin === "owner" && l.countries.includes(code)) : undefined;
    const limit: Limit | null = own?.limit ?? rule?.limit ?? null;
    const counted = own ? own.countries : rule?.pool === SCHENGEN.id ? SCHENGEN.members : code ? [code] : [];
    const limitSource = own?.source ?? rule?.sources[0]?.title ?? null;
    let allowed: number | null = null;
    let overFrom: string | null = null;
    if (limit && code) {
      const others = presence.filter((x) => x !== s && x.start < s.start);
      const r = rangesOf(others, counted);
      const entry = entriesOf([...others, s], counted).find((e) => e.ids.includes(s.id));
      allowed = Math.max(0, allowedFrom(limit, r, entry?.start ?? s.start, s.start));
      if (planned > allowed) overFrom = dayIso(s.start + allowed);
    }
    let level: VerdictLevel;
    let message: string;
    if (!code) {
      level = "unknown";
      message = `No entry data for ${name}.`;
    } else if (!rule) {
      level = own ? (overFrom ? "over" : "ok") : "unknown";
      message = own ? (overFrom ? `Over your rule (${limitLabel(own.limit)}) from ${overFrom}.` : `Within your rule (${limitLabel(own.limit)}).`) : "Add your passport to check entry rules.";
    } else if (rule.status === "home" || rule.status === "free-movement") {
      level = "free";
      message = rule.status === "home" ? "Your own country." : "Free movement: no day limit.";
    } else if (rule.status === "no-admission") {
      level = "blocked";
      message = `The dataset says ${name} does not admit ${countryName(data, rule.passport ?? "")} passport holders.`;
    } else if (rule.status === "unknown") {
      level = "unknown";
      message = rule.notes[0] ?? `No entry data for ${name}.`;
    } else if (overFrom) {
      level = "over";
      message = `${planned} days planned, ${allowed} allowed (${limitLabel(limit)}${own ? ", your rule" : ""}): over from ${overFrom}.`;
    } else if (rule.status === "visa-required" || rule.status === "e-visa") {
      level = "visa";
      message = `${rule.status === "e-visa" ? "E-visa" : "Visa"} needed before you go${limit && allowed !== null ? `; ${planned} of ${allowed} days` : ""}.`;
    } else if (limit && allowed !== null && allowed - planned < 7) {
      level = "near";
      message = `${planned} of ${allowed} days allowed (${limitLabel(limit)}).`;
    } else {
      level = "ok";
      message = limit && allowed !== null ? `${planned} of ${allowed} days allowed (${limitLabel(limit)}).` : `${planned} days; no day limit in the data.`;
    }
    const exp = rule?.passport ? opts.expiry?.[rule.passport] : undefined;
    const validity = code && !s.past && rule && rule.status !== "home" ? passportValidity(data, code, dayIso(s.start), dayIso(s.end), exp) : null;
    const prev = seen[seen.length - 1];
    const yf = code && !s.past ? yellowFever(code, prev && prev.code !== code ? prev : null) : null;
    if (code) seen.push({ code, name });
    verdicts.push({ id: s.id, country: code, countryName: name, rule, level, plannedDays: planned, allowedDays: allowed, overFrom, message, validity, yellowFever: yf, limitSource });
  }
  return { verdicts, violations, limits, passports, notes, disclaimer: VISA_DISCLAIMER };
}

// ── Schengen window ──────────────────────────────────────────────────

export function schengenRanges(p: Presence[]): Ranges {
  return rangesOf(p, SCHENGEN.members);
}

/** Days used in the 180 ending on `day`, and days left. */
export function schengenOn(r: Ranges, day: number, days = SCHENGEN.days, windowDays = SCHENGEN.windowDays): { used: number; left: number } {
  const used = usedOn(r, day, windowDays);
  return { used, left: Math.max(0, days - used) };
}

/**
 * The longest stay you could start on `day` (days counted, entry day included) without any
 * window passing the limit, taking presence already planned after it into account.
 */
export function maxStayFrom(r: Ranges, day: number, days = SCHENGEN.days, windowDays = SCHENGEN.windowDays): number {
  const fits = (n: number) => n === 0 || firstOver(addRange(r, day, day + n - 1), days, windowDays, day) === null;
  // Fitting is monotonic in n, so search for the largest n that fits.
  let lo = 0;
  let hi = days;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The first day from `from`, not already inside the area, on which a stay of at least `minDays` fits. */
export function earliestEntry(r: Ranges, from: number, minDays = 1, days = SCHENGEN.days, windowDays = SCHENGEN.windowDays): number | null {
  for (let d = from; d <= from + windowDays * 2; d++) {
    if (r.some(([a, b]) => a <= d && d <= b)) continue;
    if (firstOver(addRange(r, d, d + minDays - 1), days, windowDays, d) === null) return d;
  }
  return null;
}

export interface SchengenDay {
  day: string;
  used: number;
  present: boolean;
}

/** Days used per day over [from, to], for the timeline. */
export function schengenTimeline(r: Ranges, from: number, to: number, windowDays = SCHENGEN.windowDays): SchengenDay[] {
  const out: SchengenDay[] = [];
  for (let d = from; d <= to; d++) out.push({ day: dayIso(d), used: usedOn(r, d, windowDays), present: r.some(([a, b]) => a <= d && d <= b) });
  return out;
}

export interface SchengenSummary {
  applies: boolean;
  /** Why not, when it does not (an EU passport). */
  reason?: string;
  today: { used: number; left: number };
  firstOverstay: string | null;
  peak: { used: number; day: string | null };
  /** Earliest day a fresh entry fits, from today (when you are outside or over). */
  earliestEntry: string | null;
  /** Longest stay that fits if you entered today. */
  maxStayToday: number;
}

export function schengenSummary(data: VisaData, passports: string[], stays: StayInput[], today: string): SchengenSummary {
  const free = passports.find((p) => SCHENGEN.freeMovement.includes(p));
  const r = schengenRanges(toPresence(data, stays));
  const t = dayNum(today);
  const first = firstOver(r, SCHENGEN.days, SCHENGEN.windowDays, t - SCHENGEN.windowDays);
  const pk = peakUse(r, SCHENGEN.windowDays, t, Infinity);
  const e = earliestEntry(r, t);
  return {
    applies: !free && passports.length > 0,
    reason: free ? `Your ${countryName(data, free)} passport has free movement in the area.` : !passports.length ? "No passport set: counted as if 90/180 applies." : undefined,
    today: schengenOn(r, t),
    firstOverstay: first !== null ? dayIso(first) : null,
    peak: { used: pk.used, day: pk.day !== null ? dayIso(pk.day) : null },
    earliestEntry: e !== null ? dayIso(e) : null,
    maxStayToday: r.some(([a, b]) => a <= t && t <= b) ? 0 : maxStayFrom(r, t),
  };
}

// ── Tax residency ────────────────────────────────────────────────────

/** Days before the threshold at which a counter warns. */
export const TAX_WARN_DAYS = 30;

export interface TaxCounter {
  country: string;
  countryName: string;
  /** "2026", "Tax year 2026–27", "12 months to 2027-03-01". */
  period: string;
  periodStart: string;
  periodEnd: string;
  days: number;
  threshold: number;
  atLeast: boolean;
  status: "ok" | "near" | "over";
  residency: boolean;
  watched: boolean;
  rule: string;
  source: { title: string; url?: string; checked?: string };
}

export interface TaxOptions {
  years: number[];
  /** Countries to list even with no days. */
  watch?: string[];
  /** The owner's legal-residency country. */
  residency?: string | null;
}

function ruleFor(country: string): TaxRule | null {
  return CURATED.taxRules.find((r) => r.country === country) ?? null;
}

function verdict(days: number, threshold: number, atLeast: boolean): TaxCounter["status"] {
  const over = atLeast ? days >= threshold : days > threshold;
  if (over) return "over";
  return days >= threshold - TAX_WARN_DAYS ? "near" : "ok";
}

/** Days present per country per period, against each country's sourced test or the general 183-day rule. */
export function taxDays(data: VisaData | null, presence: Presence[], opts: TaxOptions): TaxCounter[] {
  const countries = new Set<string>([...presence.map((p) => p.country).filter((c): c is string => !!c), ...(opts.watch ?? []), ...(opts.residency ? [opts.residency] : [])]);
  const out: TaxCounter[] = [];
  for (const c of [...countries].sort()) {
    const r = rangesOf(presence, [c]);
    const rule = ruleFor(c);
    const def = CURATED.taxDefault;
    const threshold = rule?.threshold ?? def.threshold;
    const atLeast = rule?.atLeast ?? def.atLeast;
    const period = rule?.period ?? def.period;
    const source = rule ? { title: rule.source, url: rule.url, checked: rule.checked } : { title: "General 183-day rule of thumb (no country rule on file)" };
    const ruleText = rule ? rule.note : def.note;
    const base = { country: c, countryName: countryName(data, c), threshold, atLeast, residency: opts.residency === c, watched: !!opts.watch?.includes(c), rule: ruleText, source };
    for (const y of opts.years) {
      if (period.kind === "rolling") {
        const len = 365;
        const y0 = dayNum(`${y}-01-01`);
        const y1 = dayNum(`${y}-12-31`);
        // Windows of 12 months that start or end in the year.
        let best = 0;
        let bestEnd = y1;
        for (let e = y0; e <= y1 + len - 1; e++) {
          const n = daysWithin(r, e - len + 1, e);
          if (n > best) {
            best = n;
            bestEnd = e;
          }
        }
        // The same 12 months can be the most for two years running: list it once.
        const prev = out[out.length - 1];
        if (prev && prev.country === c && prev.periodEnd === dayIso(bestEnd)) continue;
        out.push({ ...base, period: `Any 12 months touching ${y}`, periodStart: dayIso(bestEnd - len + 1), periodEnd: dayIso(bestEnd), days: best, status: verdict(best, threshold, atLeast) });
      } else if (period.kind === "tax-year") {
        const sm = String(period.startMonth ?? 1).padStart(2, "0");
        const sd = String(period.startDay ?? 1).padStart(2, "0");
        const a = dayNum(`${y}-${sm}-${sd}`);
        const b = dayNum(`${y + 1}-${sm}-${sd}`) - 1;
        const n = daysWithin(r, a, b);
        out.push({ ...base, period: `Tax year ${y}–${String((y + 1) % 100).padStart(2, "0")}`, periodStart: dayIso(a), periodEnd: dayIso(b), days: n, status: verdict(n, threshold, atLeast) });
      } else {
        const a = dayNum(`${y}-01-01`);
        const b = dayNum(`${y}-12-31`);
        const n = daysWithin(r, a, b);
        out.push({ ...base, period: String(y), periodStart: dayIso(a), periodEnd: dayIso(b), days: n, status: verdict(n, threshold, atLeast) });
      }
    }
  }
  // Drop empty rows of countries that are neither watched nor the residency.
  return out.filter((t) => t.days > 0 || t.watched || t.residency);
}

/** Warnings worth showing: another country nearing its test, or the residency country losing out. */
export function taxWarnings(counters: TaxCounter[]): string[] {
  const out: string[] = [];
  for (const t of counters) {
    if (t.residency) continue;
    if (t.status === "over") out.push(`${t.countryName} (${t.period}): ${t.days} days, at or past its ${t.threshold}-day test. You may become tax-resident there.`);
    else if (t.status === "near") out.push(`${t.countryName} (${t.period}): ${t.days} days, ${t.threshold - t.days} from its ${t.threshold}-day test.`);
  }
  return out;
}

// ── Border runs ──────────────────────────────────────────────────────

export interface Place {
  cityId: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  iata?: string;
  /** Twelve Comfort Index values, January first; null where unknown. */
  comfort?: (number | null)[] | null;
  /** Standing advisories or conflicts for the country (Meridian's curated list); severity 3 = avoid. */
  advisories?: { label: string; severity: number; source: string }[];
}

/** Places under a severity-3 advisory are never suggested; lesser ones are named. */
function advisoryNotes(p: Place): string[] | null {
  if (p.advisories?.some((a) => a.severity >= 3)) return null;
  return (p.advisories ?? []).map((a) => `Advisory: ${a.label} (${a.source}).`);
}

export interface BorderRunOption {
  place: Place;
  countryName: string;
  km: number;
  rule: EntryRule;
  /** Rough door-to-door estimate by straight-line distance; labelled as one. */
  estimate: string;
  notes: string[];
}

export const BORDER_RUN_METHOD = "Distance is straight-line; the time is a rough estimate (ground at 60 km/h up to 600 km, else a flight at 700 km/h plus 3 hours), not a timetable.";

function roughHours(km: number): number {
  return km <= 600 ? km / 60 : km / 700 + 3;
}

/**
 * Where to go to restart a per-entry limit: the nearest places in other countries these
 * passports can enter without applying ahead, one per country, with restrictions noted. For
 * a rolling or calendar limit a run does not help, and the result says so.
 */
export function borderRunOptions(data: VisaData, passports: string[], from: { country: string; lat: number; lng: number; date: string }, places: Place[], limit = 5): { options: BorderRunOption[]; notes: string[] } {
  const origin = isoOf(data, from.country);
  const notes: string[] = [];
  if (!origin) return { options: [], notes: ["No entry data for this country."] };
  const here = entryRule(data, passports, origin, from.date);
  if (here.limit && here.limit.kind !== "per-entry") {
    notes.push(`${here.destinationName} counts ${limitLabel(here.limit)}: leaving and coming back does not restart it. Days only come back as old ones leave the window.`);
    return { options: [], notes };
  }
  for (const n of CURATED.borderRunNotes.filter((x) => x.destination === origin)) notes.push(n.note);
  if (here.landEntriesPerYear) notes.push(`Land entries are capped at ${here.landEntriesPerYear} a calendar year; a run by air does not count against that.`);
  const best = new Map<string, BorderRunOption>();
  for (const p of places) {
    const c = isoOf(data, p.country);
    if (!c || c === origin) continue;
    if (inSchengenIso(origin) && inSchengenIso(c)) continue;
    const rule = entryRule(data, passports, c, from.date);
    if (!ARRIVE_OK.has(rule.status)) continue;
    const adv = advisoryNotes(p);
    if (!adv) continue;
    const km = Math.round(haversineKm([from.lng, from.lat], [p.lng, p.lat]));
    const prev = best.get(c);
    if (prev && prev.km <= km) continue;
    const h = roughHours(km);
    const optNotes = [...CURATED.borderRunNotes.filter((x) => x.destination === c).map((x) => x.note), ...adv];
    if (rule.status === "eta") optNotes.push("Needs a travel authorisation (ETA) applied for online.");
    if (inSchengenIso(c)) optNotes.push("Days there count towards Schengen 90/180.");
    best.set(c, { place: p, countryName: rule.destinationName, km, rule, estimate: `about ${h < 1 ? "1" : Math.round(h)} h each way (${km} km)`, notes: optNotes });
  }
  const options = [...best.values()].sort((a, b) => a.km - b.km || a.place.cityId.localeCompare(b.place.cityId)).slice(0, limit);
  return { options, notes };
}

// ── Schengen buffers ─────────────────────────────────────────────────

export interface BufferOption {
  place: Place;
  countryName: string;
  km: number;
  /** Mean Comfort Index over the months of the stay, or null. */
  comfort: number | null;
  rule: EntryRule;
  /** Days the entry rule allows for this stay. */
  allowedDays: number | null;
  distanceRank: number;
  comfortRank: number | null;
  /** Mean of the two ranks' scores (distance 0-100, comfort 0-100); unknown comfort counts 50. */
  score: number;
  notes: string[];
}

export const BUFFER_MAX_KM = 4000;

/**
 * Microstates surrounded by the Schengen Area: there are no border checks into Monaco, San
 * Marino and the Vatican, and Andorra is reached only through Spain or France. Meridian does
 * not suggest them as a place to wait out 90/180 (a judgement, stated in ADR 0012).
 */
export const ENCLAVED_BY_SCHENGEN = ["AD", "MC", "SM", "VA"];

/**
 * Places outside the Schengen Area to wait out the 90/180 count: one per country, that these
 * passports can enter for `nights`, ranked by distance from `from` and by comfort in the
 * months of the stay. Cyprus and Ireland are EU members outside Schengen and qualify.
 */
export function schengenBuffers(data: VisaData, passports: string[], from: { lat: number; lng: number }, start: string, nights: number, places: Place[], limit = 8): BufferOption[] {
  const months: number[] = [];
  for (let d = dayNum(start); d < dayNum(start) + Math.max(1, nights); d += 7) {
    const m = Number(dayIso(d).slice(5, 7));
    if (!months.includes(m)) months.push(m);
  }
  const best = new Map<string, Omit<BufferOption, "distanceRank" | "comfortRank" | "score">>();
  for (const p of places) {
    const c = isoOf(data, p.country);
    if (!c || inSchengenIso(c) || ENCLAVED_BY_SCHENGEN.includes(c)) continue;
    const rule = entryRule(data, passports, c, start);
    if (!ARRIVE_OK.has(rule.status)) continue;
    const allowed = rule.limit ? rule.limit.days : null;
    if (allowed !== null && allowed < nights + 1) continue;
    const adv = advisoryNotes(p);
    if (!adv) continue;
    const km = Math.round(haversineKm([from.lng, from.lat], [p.lng, p.lat]));
    if (km > BUFFER_MAX_KM) continue;
    const vals = months.map((m) => p.comfort?.[m - 1]).filter((v): v is number => typeof v === "number");
    const comfort = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    const prev = best.get(c);
    // Keep the better place per country: higher comfort, then nearer.
    if (prev && ((prev.comfort ?? -1) > (comfort ?? -1) || ((prev.comfort ?? -1) === (comfort ?? -1) && prev.km <= km))) continue;
    const notes: string[] = [...adv];
    if (SCHENGEN.outside[c]) notes.push(SCHENGEN.outside[c]);
    if (rule.limit) notes.push(`Allows ${limitLabel(rule.limit)}.`);
    if (rule.status === "eta") notes.push("Needs a travel authorisation (ETA) applied for online.");
    best.set(c, { place: p, countryName: rule.destinationName, km, comfort, rule, allowedDays: allowed, notes });
  }
  const list = [...best.values()];
  const byKm = [...list].sort((a, b) => a.km - b.km || a.place.cityId.localeCompare(b.place.cityId));
  const byComfort = list.filter((x) => x.comfort !== null).sort((a, b) => b.comfort! - a.comfort! || a.km - b.km);
  return list
    .map((x) => {
      const dScore = 100 * (1 - x.km / BUFFER_MAX_KM);
      const cScore = x.comfort ?? 50;
      return { ...x, distanceRank: byKm.indexOf(x) + 1, comfortRank: x.comfort !== null ? byComfort.indexOf(x) + 1 : null, score: Math.round((dScore + cScore) / 2) };
    })
    .sort((a, b) => b.score - a.score || a.km - b.km || a.place.cityId.localeCompare(b.place.cityId))
    .slice(0, limit);
}
