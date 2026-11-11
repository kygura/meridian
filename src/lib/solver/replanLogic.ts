// Re-plan detection (ADR 0015): turns fresh readings about the stays ahead into Shifts,
// decides with hysteresis and a cooldown whether a Shift should raise a Proposal, and
// writes plan B as a diff against the active rotation. Pure; the server feeds it.
//
// Each Shift has a magnitude: how far past its threshold the reading is (1 = exactly at
// it). Continuous readings (air, temperature, flight price) fire at 1 + h and clear below
// 1 − h, where h is the owner's hysteresis share, so a reading wobbling around the
// threshold neither fires nor clears. Discrete readings (a news issue, a visa breach) fire
// at 1 and clear only once they have been absent for the cooldown. Once a Shift has raised
// a Proposal it cannot raise another until the cooldown has passed, whatever it does.

import { countryKey, SCHENGEN_RULE, dayNum } from "./visa";
import { countLimits, type Presence } from "../visa/engine";
import { solverLimits } from "./engine";
import type { PlannedStay, ProposedRotation, CountryRule } from "./types";
import type { ReplanSettings, Shift, ShiftMemory, StayChange } from "./settings";

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

export interface WatchedStay {
  id: string;
  cityId: string;
  name: string;
  country?: string;
  start: string;
  end: string;
  /** Booked, locked or where the owner is: plan B cannot move it. */
  fixed: boolean;
}

export interface Detected extends Shift {
  continuous: boolean;
}

// ── Detectors ───────────────────────────────────────────────────────────

/**
 * Issue level that counts at each setting (recurring 1, incident 2, pattern 3). Watch Flags
 * count one step stricter, since nearly every large place has some: at "any" a flag of
 * severity 2 or more, at "incident" a deadly (severity 3) flag, at "systemic" none.
 */
const NEWS_LEVEL: Record<ReplanSettings["newsMinLevel"], number> = { any: 1, incident: 2, systemic: 3 };

export interface NewsReading {
  issues: { subject: string; label: string; level: "systemic" | "incident" | "recurring"; summary: string; lastSeen: string; headlines: { title: string; url: string; source: string; pubDate: string }[] }[];
  flags: { topic: string; severity: 1 | 2 | 3; headline: string; url: string; latest: string }[];
}

/** Only news with a headline this recent counts as a shift; older issues are the place's standing risk, already in the solver's score. */
export const NEWS_FRESH_DAYS = 14;

/**
 * News Issues and Watch Flags at or above the owner's level, with a headline in the last
 * NEWS_FRESH_DAYS. Country news penalises a place in the re-solve; it never excludes it.
 */
export function newsShifts(stay: WatchedStay, news: NewsReading, s: ReplanSettings, today: string): Detected[] {
  const T = NEWS_LEVEL[s.newsMinLevel];
  const fresh = (d: string) => !!d && daysBetween(d.slice(0, 10), today) <= NEWS_FRESH_DAYS;
  const out: Detected[] = [];
  for (const i of news.issues) {
    const sev = i.level === "systemic" ? 3 : i.level === "incident" ? 2 : 1;
    if (sev < T || !fresh(i.lastSeen)) continue;
    out.push({
      key: `news:${stay.id}:${i.subject}`,
      kind: "news",
      stayId: stay.id,
      cityId: stay.cityId,
      place: stay.name,
      title: `${i.label} in the news for ${stay.country ?? stay.name}`,
      magnitude: sev / T,
      action: "penalise",
      continuous: false,
      evidence: [
        { label: i.summary, source: "Meridian news issues (Google News headlines)" },
        ...i.headlines.slice(0, 3).map((h) => ({ label: h.title, source: h.source || "Google News", url: h.url, value: h.pubDate.slice(0, 16) })),
      ],
    });
  }
  for (const f of news.flags) {
    if (f.severity < T + 1 || !fresh(f.latest)) continue;
    out.push({
      key: `flag:${stay.id}:${f.topic}`,
      kind: "news",
      stayId: stay.id,
      cityId: stay.cityId,
      place: stay.name,
      title: `Watch flag for ${stay.name}: ${f.topic}`,
      magnitude: f.severity / (T + 1),
      action: "penalise",
      continuous: false,
      evidence: [{ label: f.headline, source: "Google News", url: f.url, value: f.latest.slice(0, 16) }],
    });
  }
  return out;
}

/** A curated advisory or conflict (data/phenomena.json) added in the last 60 days for the stay's country. */
export function advisoryShifts(stay: WatchedStay, advisories: { id: string; label: string; severity: number; since?: string; detail?: string; sources?: { title: string; url: string }[] }[], today: string): Detected[] {
  return advisories
    .filter((a) => a.since && a.severity >= 2 && daysBetween(`${a.since}-01`, today) <= 60)
    .map((a) => ({
      key: `advisory:${stay.id}:${a.id}`,
      kind: "news" as const,
      stayId: stay.id,
      cityId: stay.cityId,
      place: stay.name,
      title: `New advisory for ${stay.country ?? stay.name}: ${a.label}`,
      magnitude: a.severity / 2,
      action: a.severity >= 3 ? ("exclude" as const) : ("penalise" as const),
      continuous: false,
      evidence: [{ label: a.detail ?? a.label, source: a.sources?.[0]?.title ?? "Meridian curated list (data/phenomena.json)", url: a.sources?.[0]?.url, value: `since ${a.since}` }],
    }));
}

/** Observed PM2.5 over recent days against the month's normal. */
export function airShift(stay: WatchedStay, observed: number, normal: number, s: ReplanSettings, source: string): Detected {
  const over = observed - normal;
  return {
    key: `air:${stay.id}`,
    kind: "air",
    stayId: stay.id,
    cityId: stay.cityId,
    place: stay.name,
    title: `Air in ${stay.name}: PM2.5 ${Math.round(observed)} µg/m³ against a normal ${Math.round(normal)}`,
    magnitude: Math.max(0, over) / s.pm25Over,
    action: "penalise",
    continuous: true,
    evidence: [
      { label: "PM2.5, mean of the last 7 days", source, value: `${Math.round(observed)} µg/m³` },
      { label: "Normal for the month (CAMS)", source: "Meridian climate normals (ADR 0014)", value: `${Math.round(normal)} µg/m³` },
    ],
  };
}

/** Observed mean temperature against the month's normal. */
export function weatherShift(stay: WatchedStay, observedC: number, normalC: number, s: ReplanSettings, source: string): Detected {
  const d = observedC - normalC;
  return {
    key: `weather:${stay.id}`,
    kind: "weather",
    stayId: stay.id,
    cityId: stay.cityId,
    place: stay.name,
    title: `${stay.name} is running ${Math.abs(d).toFixed(1)}°C ${d > 0 ? "warmer" : "cooler"} than normal`,
    magnitude: Math.abs(d) / s.tempDeltaC,
    action: "penalise",
    continuous: true,
    evidence: [
      { label: "Mean temperature, recent days", source, value: `${observedC.toFixed(1)}°C` },
      { label: "Normal for the month", source: "Meridian climate normals", value: `${normalC.toFixed(1)}°C` },
    ],
  };
}

/** The fare for the next move against the first fare seen for it. */
export function flightShift(stay: WatchedStay, fromName: string, price: number, baseline: number, currency: string, s: ReplanSettings, source: string): Detected {
  const pct = ((price - baseline) / baseline) * 100;
  return {
    key: `flight:${stay.id}`,
    kind: "flight-price",
    stayId: stay.id,
    cityId: stay.cityId,
    place: stay.name,
    title: `Fare from ${fromName} to ${stay.name} ${pct > 0 ? "up" : "down"} ${Math.abs(Math.round(pct))}%`,
    magnitude: Math.abs(pct) / s.flightChangePct,
    // A rise makes this stay worse; a drop is news, not a reason to move.
    action: pct > 0 ? "penalise" : "none",
    continuous: true,
    evidence: [
      { label: "Cheapest fare now", source, value: `${Math.round(price)} ${currency}` },
      { label: "First fare Meridian saw for this move", source, value: `${Math.round(baseline)} ${currency}` },
    ],
  };
}

/**
 * Schengen 90/180 and the country rules (the owner's, and with a passport set the visa
 * module's, ADR 0012) over the committed stays, past ones included. Counted by the visa
 * module's countLimits, the same code the solver and the Days page use.
 */
export function visaShifts(stays: WatchedStay[], prior: { country: string; start: string; end: string }[], schengen: boolean, rules: CountryRule[], today: string): Detected[] {
  const out: Detected[] = [];
  const from = dayNum(today);
  const presence: Presence[] = [
    ...prior.map((p, i) => ({ id: `prior-${i}`, country: countryKey(p.country), start: dayNum(p.start), end: dayNum(p.end), label: p.country, past: true, tentative: false })),
    ...stays.map((s) => ({ id: s.id, country: countryKey(s.country), start: dayNum(s.start), end: dayNum(s.end), label: s.name, past: false, tentative: false })),
  ].filter((p) => p.country);
  const limits = solverLimits({ input: { constraints: { schengen, countryRules: rules } } as never });
  for (const v of countLimits(presence, limits, from)) {
    const over = dayNum(v.firstOver);
    const mine = stays.filter((s) => v.stayIds.includes(s.id));
    const hit = mine.find((s) => dayNum(s.start) <= over && over <= dayNum(s.end)) ?? mine[0];
    const rule = rules.find((r) => countryKey(r.country) === v.key);
    const limitDays = Number(v.limit.match(/^\d+/)?.[0] ?? 0) || 1;
    if (v.key === "schengen") {
      out.push({
        key: "visa:schengen",
        kind: "visa",
        stayId: hit?.id ?? "",
        cityId: hit?.cityId ?? "",
        place: hit?.name ?? "Schengen Area",
        title: `Schengen: ${v.days} days in the 180 to ${v.firstOver}, over 90`,
        magnitude: v.days / SCHENGEN_RULE.days,
        action: "none",
        continuous: false,
        evidence: [{ label: "Days inside the Schengen Area in any 180, your stays and past journeys counted", source: "Schengen Borders Code (EU) 2016/399, Art. 6", value: `${v.days} of 90` }],
      });
      continue;
    }
    const whose = rule?.origin === "visa" ? "the limit for your passport" : "your limit";
    const source = rule?.origin === "visa" ? rule.note ?? "Visa data" : rule?.note || "Entered by you";
    if (v.kind === "per-entry") {
      const start = v.message.match(/from (\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
      out.push({
        key: `visa:entry:${rule?.country ?? v.label}`,
        kind: "visa",
        stayId: hit?.id ?? "",
        cityId: hit?.cityId ?? "",
        place: hit?.name ?? v.label,
        title: `${rule?.country ?? v.label}: one entry of ${v.days} days from ${start}, over ${whose} of ${limitDays}`,
        magnitude: v.days / limitDays,
        action: "none",
        continuous: false,
        evidence: [{ label: rule?.origin === "visa" ? "Limit for your passport" : "Your rule for this country", source, value: v.limit }],
      });
    } else {
      out.push({
        key: `visa:${rule?.country ?? v.label}`,
        kind: "visa",
        stayId: hit?.id ?? "",
        cityId: hit?.cityId ?? "",
        place: hit?.name ?? v.label,
        title: `${rule?.country ?? v.label}: ${v.days} days ${v.kind === "rolling" ? "in the window" : "in the year"} to ${v.firstOver}, over ${whose} of ${limitDays}`,
        magnitude: v.days / limitDays,
        action: "none",
        continuous: false,
        evidence: [{ label: rule?.origin === "visa" ? "Limit for your passport" : "Your rule for this country", source, value: v.limit }],
      });
    }
  }
  return out;
}

// ── Hysteresis ──────────────────────────────────────────────────────────

export interface Step {
  fire: boolean;
  memory: ShiftMemory;
}

/**
 * One reading of a shift. `magnitude` 0 means it was looked for and not found; a shift
 * that could not be checked must not be stepped at all (unknown is not absent).
 */
export function stepShift(prev: ShiftMemory | undefined, magnitude: number, continuous: boolean, today: string, s: ReplanSettings): Step {
  const h = s.hysteresisPct / 100;
  const onAt = continuous ? 1 + h : 1;
  const offAt = continuous ? 1 - h : 1;
  const mem: ShiftMemory = prev ? { ...prev } : { active: false, firstSeen: today, lastSeen: today, lastMagnitude: 0 };
  let fire = false;
  if (magnitude >= 1) mem.lastSeen = today;
  if (!mem.active) {
    if (magnitude >= onAt) {
      mem.active = true;
      const cooled = !mem.lastProposalAt || daysBetween(mem.lastProposalAt, today) >= s.cooldownDays;
      if (cooled) {
        fire = true;
        mem.lastProposalAt = today;
      }
    }
  } else if (continuous ? magnitude < offAt : magnitude < 1 && daysBetween(mem.lastSeen, today) >= s.cooldownDays) {
    mem.active = false;
  }
  mem.lastMagnitude = Math.round(magnitude * 100) / 100;
  return { fire, memory: mem };
}

// ── Plan B as a diff ────────────────────────────────────────────────────

export interface ActiveStay {
  id: string;
  cityId: string;
  name: string;
  start: string;
  end: string;
}

/** Stays added, removed, moved (same place, new dates) and unchanged between the active rotation and plan B. */
export function diffStays(active: ActiveStay[], planB: Pick<PlannedStay, "id" | "cityId" | "name" | "start" | "end">[]): StayChange[] {
  const out: StayChange[] = [];
  const used = new Set<string>();
  const bById = new Map(planB.map((s) => [s.id, s]));
  for (const a of active) {
    const same = bById.get(a.id);
    if (same && same.cityId === a.cityId) {
      used.add(same.id);
      out.push(same.start === a.start && same.end === a.end ? { kind: "unchanged", cityId: a.cityId, name: a.name, before: { start: a.start, end: a.end }, after: { start: same.start, end: same.end } } : { kind: "moved", cityId: a.cityId, name: a.name, before: { start: a.start, end: a.end }, after: { start: same.start, end: same.end } });
      continue;
    }
    const exact = planB.find((b) => !used.has(b.id) && b.cityId === a.cityId && b.start === a.start && b.end === a.end);
    if (exact) {
      used.add(exact.id);
      out.push({ kind: "unchanged", cityId: a.cityId, name: a.name, before: { start: a.start, end: a.end }, after: { start: a.start, end: a.end } });
      continue;
    }
    const near = planB.find((b) => !used.has(b.id) && b.cityId === a.cityId && b.start < a.end && a.start < b.end);
    if (near) {
      used.add(near.id);
      out.push({ kind: "moved", cityId: a.cityId, name: a.name, before: { start: a.start, end: a.end }, after: { start: near.start, end: near.end } });
      continue;
    }
    out.push({ kind: "removed", cityId: a.cityId, name: a.name, before: { start: a.start, end: a.end } });
  }
  for (const b of planB) if (!used.has(b.id)) out.push({ kind: "added", cityId: b.cityId, name: b.name, after: { start: b.start, end: b.end } });
  return out.sort((x, y) => (x.after?.start ?? x.before!.start).localeCompare(y.after?.start ?? y.before!.start) || x.kind.localeCompare(y.kind));
}

/** Mean monthly cost (known figures only), Schengen peak and travel cost of a scored plan. */
export function impactOf(p: ProposedRotation | null): { cost: number | null; schengen: number | null; travel: number | null; score: number | null } {
  if (!p) return { cost: null, schengen: null, travel: null, score: null };
  const known = p.monthsTable.filter((m) => m.costEur !== null);
  return {
    cost: known.length ? Math.round(known.reduce((a, m) => a + m.costEur!, 0) / known.length / 10) * 10 : null,
    schengen: p.visa.schengen.enabled ? p.visa.schengen.maxUsed : null,
    travel: p.moves.reduce((a, m) => a + m.costUsd, 0),
    score: p.total,
  };
}

/** Penalty points per shift kind when the affected place is re-solved. */
export const SHIFT_PENALTY: Record<Shift["kind"], number> = { news: 30, "flight-price": 20, air: 40, weather: 25, visa: 0, "book-by": 0 };

export const REPLAN_SOURCE_NOTE = "Shifts are measured, never guessed: a source that can't be reached is reported as not checked.";
