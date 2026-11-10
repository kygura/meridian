// The re-plan loop (ADR 0015), which the owner thinks of as regime detection. A daily job
// watches the current stay and the next few for shifts: news Issues and Watch Flags,
// a fare change on the next move, air or temperature against the month's normals, a
// visa day-count breach after an edit; and it sends book-by reminders. When a shift
// crosses its threshold (with hysteresis and a cooldown, replanLogic.ts) it re-solves
// with the affected place penalised or excluded and everything booked, locked or current
// held fixed, and stores a Proposal: what changed, the evidence, and plan B as a diff.
// Nothing in the rotation changes until the owner accepts it.

import { createHash } from "crypto";
import { getCityById } from "./cities.js";
import { registerDailyJob } from "./dailyJobs.js";
import { getFlightEstimate, hasFlightProvider } from "./flightSearch.js";
import { notify, type NotifyInput } from "./notifier.js";
import { defaultObservedWeatherDeps, fetchObservedWeather } from "./observedWeather.js";
import { getPlaceNews } from "./placeNews.js";
import { readRotation, stateOf } from "./rotation.js";
import { getCitySeasonality } from "./seasonality.js";
import { readSolverDoc, updateSolverDoc } from "./solverStore.js";
import { acceptPlan, activePlan, prepareSolve, priorPresence, runSolve } from "./solverService.js";
import { addDays, dueReminders, effectiveStatus, formatShortDate, hasDates, orderStays, todayIso, type RotationStay } from "../../src/lib/rotation.js";
import { addMonthsToDate, evaluatePlan, planOf } from "../../src/lib/solver/engine.js";
import { advisoriesForCountry } from "./phenomena.js";
import {
  advisoryShifts,
  airShift,
  diffStays,
  flightShift,
  impactOf,
  newsShifts,
  SHIFT_PENALTY,
  stepShift,
  visaShifts,
  weatherShift,
  type Detected,
  type NewsReading,
  type WatchedStay,
} from "../../src/lib/solver/replanLogic.js";
import type { Proposal, ReplanSettings, Shift } from "../../src/lib/solver/settings.js";

/** Everything the loop reads from outside, so tests can replace it. */
export interface ReplanDeps {
  news(city: string, country: string): Promise<NewsReading | null>;
  /** Mean temperature over [from, to) and the month's normal. */
  observedTemp(cityId: string, from: string, to: string): Promise<{ tempC: number; normalTempC: number } | null>;
  /** Mean PM2.5 over the last 7 days at a point. */
  recentPm25(lat: number, lng: number): Promise<number | null>;
  /** The month's PM2.5 normal for a city. */
  normalPm25(cityId: string, month: number): Promise<number | null>;
  /** Cheapest real fare (null without a flight provider). */
  fare(origin: string, dest: string, date: string): Promise<{ price: number; currency: string; source: string } | null>;
  notify(n: NotifyInput): Promise<unknown>;
}

const AIR_SOURCE = "Open-Meteo air quality (CAMS), last 7 days";
const WEATHER_SOURCE = "Open-Meteo historical weather (ERA5), via Meridian's observed weather";

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]).catch(() => null);
}

export function defaultDeps(): ReplanDeps {
  const wx = defaultObservedWeatherDeps();
  return {
    news: async (city, country) => {
      const n = await withTimeout(getPlaceNews(city, country), 8000);
      return n && n.available ? { issues: n.issues, flags: n.flags } : null;
    },
    observedTemp: async (cityId, from, to) => {
      const r = await withTimeout(fetchObservedWeather(cityId, from, to, wx), 10000);
      if (!r || !r.ok || r.observed.normalTempC === undefined) return null;
      return { tempC: r.observed.tempC, normalTempC: r.observed.normalTempC };
    },
    recentPm25: async (lat, lng) => {
      const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&hourly=pm2_5&past_days=7&forecast_days=0`;
      const res = await withTimeout(fetch(url), 10000);
      if (!res || !res.ok) return null;
      const j = (await res.json().catch(() => null)) as { hourly?: { pm2_5?: (number | null)[] } } | null;
      const xs = (j?.hourly?.pm2_5 ?? []).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      return xs.length >= 24 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    },
    normalPm25: async (cityId, month) => {
      const m = await withTimeout(getCitySeasonality(cityId), 8000);
      const v = m?.[month - 1]?.pm25;
      return typeof v === "number" ? v : null;
    },
    fare: async (origin, dest, date) => {
      if (!hasFlightProvider()) return null;
      const f = await withTimeout(getFlightEstimate({ originIata: origin, destinationIata: dest, departureDate: date }), 15000);
      return f ? { price: f.priceAmount, currency: f.currency, source: f.source === "duffel" ? "Duffel" : "SerpAPI (Google Flights)" } : null;
    },
    notify: (n) => notify(n),
  };
}

/** The current stay and the next `ahead` committed stays. */
export function watchedStays(stays: RotationStay[], today: string, ahead: number): WatchedStay[] {
  const committed = orderStays(stays.filter((s) => s.status !== "idea" && hasDates(s) && s.end! > today));
  const current = committed.filter((s) => s.start! <= today);
  const next = committed.filter((s) => s.start! > today).slice(0, ahead);
  return [...current, ...next].map((s) => {
    const st = effectiveStatus(s, today);
    return { id: s.id, cityId: s.place.cityId, name: s.place.name, country: s.place.country, start: s.start!, end: s.end!, fixed: !!s.locked || st === "booked" || st === "current" };
  });
}

export interface ReplanReport {
  day: string;
  watched: number;
  shifts: number;
  fired: number;
  proposals: number;
  reminders: number;
  notes: string[];
}

const proposalId = (day: string, keys: string[]) => `pr-${day.replace(/-/g, "")}-${createHash("sha256").update(keys.sort().join("|")).digest("hex").slice(0, 8)}`;

/** One pass of the loop. Idempotent per day: proposal ids and notice keys derive from the day and the shifts. */
export async function runReplan(opts: { now?: Date; force?: boolean; deps?: ReplanDeps } = {}): Promise<ReplanReport> {
  const now = opts.now ?? new Date();
  const today = todayIso(now);
  const deps = opts.deps ?? defaultDeps();
  const doc = await readSolverDoc();
  const s: ReplanSettings = doc.settings.replan;
  const report: ReplanReport = { day: today, watched: 0, shifts: 0, fired: 0, proposals: 0, reminders: 0, notes: [] };
  if (!s.enabled && !opts.force) {
    report.notes.push("Re-planning is off in Settings.");
    return report;
  }
  const rot = stateOf(await readRotation());

  // Book-by reminders, deduped by stay, deadline and kind.
  for (const r of dueReminders(rot, today, s.bookByNoticeDays)) {
    await deps.notify({
      kind: "book-by",
      title: r.message.slice(0, 160),
      body: r.links.map((l) => `${l.label}: ${l.url}`).join("\n"),
      url: "/#/rotation",
      dedupeKey: `book-by:${r.stayId}:${r.bookBy}:${r.kind}`,
    });
    report.reminders++;
  }

  const watched = watchedStays(rot.stays, today, s.watchAhead);
  report.watched = watched.length;
  if (!watched.length) {
    report.notes.push("No current or upcoming committed stay to watch.");
    return report;
  }

  // Readings. Each detector either gives a reading (stepped, even when it is below the
  // threshold) or says it could not check (not stepped).
  const readings: { shift: Detected; checked: true }[] = [];
  const checkedKeys = new Set<string>();
  const notChecked: string[] = [];
  const zero = (key: string) => checkedKeys.add(key);

  await Promise.all(
    watched.map(async (w) => {
      const city = getCityById(w.cityId);
      if (!city) return;
      const news = await deps.news(city.name, city.country);
      if (news) {
        for (const sh of newsShifts(w, news, s, today)) readings.push({ shift: sh, checked: true });
        zero(`news:${w.id}:*`);
      } else notChecked.push(`news for ${w.name}`);
      for (const sh of advisoryShifts(w, advisoriesForCountry(city.country), today)) readings.push({ shift: sh, checked: true });
      const month = Number(today.slice(5, 7));
      const [pm, normal] = await Promise.all([deps.recentPm25(city.lat, city.lng), deps.normalPm25(city.id, month)]);
      if (pm !== null && normal !== null) readings.push({ shift: airShift(w, pm, normal, s, AIR_SOURCE), checked: true });
      else notChecked.push(`air quality for ${w.name}${pm !== null && normal === null ? " (no normal yet)" : ""}`);
      const t = await deps.observedTemp(city.id, addDays(today, -12), addDays(today, -5));
      if (t) readings.push({ shift: weatherShift(w, t.tempC, t.normalTempC, s, WEATHER_SOURCE), checked: true });
      else notChecked.push(`weather for ${w.name}`);
    })
  );

  // The next move's fare against the first fare seen for it.
  const nextIdx = watched.findIndex((w) => w.start > today);
  const fareBaselines: Record<string, number> = { ...doc.fareBaselines };
  if (nextIdx > 0) {
    const from = watched[nextIdx - 1];
    const to = watched[nextIdx];
    const a = getCityById(from.cityId)?.iata;
    const b = getCityById(to.cityId)?.iata;
    if (a && b && from.cityId !== to.cityId) {
      const f = await deps.fare(a, b, to.start);
      if (f) {
        const k = `${a}-${b}-${to.start}`;
        fareBaselines[k] ??= f.price;
        readings.push({ shift: flightShift(to, from.name, f.price, fareBaselines[k], f.currency, s, f.source), checked: true });
      } else notChecked.push(`fares (${hasFlightProvider() ? "no fare found" : "no flight provider set up"})`);
    }
  }

  // Day counts after edits, past stays and journeys counted.
  const committed = rot.stays.filter((x) => x.status !== "idea" && hasDates(x));
  const prior = await priorPresence(rot.stays, today);
  const all = watchedStays(committed, today, 100);
  for (const sh of visaShifts(all, prior, doc.settings.constraints.schengen, doc.settings.constraints.countryRules, today)) readings.push({ shift: sh, checked: true });
  zero("visa:*");

  // Hysteresis. Shifts seen before but missing now count as magnitude 0, if their source was checked.
  const fired: Detected[] = [];
  const memory = { ...doc.shifts };
  const seen = new Set<string>();
  for (const { shift } of readings) {
    seen.add(shift.key);
    const step = stepShift(memory[shift.key], shift.magnitude, shift.continuous, today, s);
    memory[shift.key] = step.memory;
    if (step.fire) fired.push(shift);
  }
  for (const key of Object.keys(memory)) {
    if (seen.has(key)) continue;
    const stayId = key.split(":")[1];
    const checked = key.startsWith("visa:") || key.startsWith("advisory:") ? checkedKeys.has("visa:*") : key.startsWith("news:") || key.startsWith("flag:") ? checkedKeys.has(`news:${stayId}:*`) : false;
    if (!checked) continue;
    memory[key] = stepShift(memory[key], 0, false, today, s).memory;
  }
  report.shifts = readings.filter((r) => r.shift.magnitude >= 1).length;
  report.fired = fired.length;
  if (notChecked.length) report.notes.push(`Not checked: ${[...new Set(notChecked)].join("; ")}.`);

  let proposal: Proposal | null = null;
  if (fired.length) proposal = await buildProposal(fired, rot.stays, doc.settings, today, now);

  await updateSolverDoc((d) => {
    d.shifts = memory;
    d.fareBaselines = fareBaselines;
    if (proposal && !d.proposals.some((p) => p.id === proposal!.id)) {
      for (const p of d.proposals) if (p.status === "open" || p.status === "snoozed") p.status = "superseded";
      d.proposals.unshift(proposal);
      d.proposals = d.proposals.slice(0, 50);
      report.proposals = 1;
    }
    d.lastReplan = { at: now.toISOString(), shifts: report.shifts, proposals: report.proposals, notes: report.notes };
  });

  if (proposal && report.proposals) {
    const first = proposal.shifts[0];
    await deps.notify({
      kind: "replan",
      title: `${first.title}${proposal.shifts.length > 1 ? ` (+${proposal.shifts.length - 1} more)` : ""}`.slice(0, 160),
      body: proposal.planB ? `Plan B is ready: ${summarizeDiff(proposal)} Nothing changes until you accept it.` : `No plan B: ${proposal.note ?? "nothing legal fits."}`,
      url: "/#/rotation",
      dedupeKey: `replan:${proposal.id}`,
    });
  }
  return report;
}

function summarizeDiff(p: Proposal): string {
  const ch = p.diff?.stays.filter((c) => c.kind !== "unchanged") ?? [];
  if (!ch.length) return "the plan stays as it is.";
  return ch
    .slice(0, 3)
    .map((c) => (c.kind === "added" ? `add ${c.name} from ${formatShortDate(c.after!.start)}` : c.kind === "removed" ? `drop ${c.name}` : `move ${c.name} to ${formatShortDate(c.after!.start)}`))
    .join("; ")
    .concat(".");
}

async function buildProposal(fired: Detected[], stays: RotationStay[], settings: Awaited<ReturnType<typeof readSolverDoc>>["settings"], today: string, now: Date): Promise<Proposal> {
  const id = proposalId(today, fired.map((f) => f.key));
  const shifts: Shift[] = fired.map(({ continuous: _c, ...sh }) => sh);
  const exclude = fired.filter((f) => f.action === "exclude" && f.cityId).map((f) => ({ cityId: f.cityId, reason: f.title }));
  const penalise = fired.filter((f) => f.action === "penalise" && f.cityId).map((f) => ({ cityId: f.cityId, points: SHIFT_PENALTY[f.kind], reason: f.title }));
  // With no pool saved, re-plan among the places already in the rotation.
  const pool = settings.pool.length ? settings.pool : [...new Set(stays.map((s) => s.place.cityId))].map((cityId) => ({ cityId, kind: "base" as const }));
  const base: Proposal = { id, createdAt: now.toISOString(), status: "open", shifts, planB: null, diff: null };
  const fixedHit = fired.filter((f) => f.action !== "none" && stays.find((s) => s.id === f.stayId && (s.locked || effectiveStatus(s, today) === "booked")));
  const fixedNote = fixedHit.length ? ` ${[...new Set(fixedHit.map((f) => f.place))].join(", ")} is booked or locked, so plan B keeps it; unlock it to let the solver move it.` : "";
  const r = await runSolve({ settings: { ...settings, pool, results: 1 }, start: today, exclude, penalise });
  if ("error" in r && !("proposals" in r)) return { ...base, note: r.error + fixedNote };
  if (!r.ok || !r.proposals.length) return { ...base, note: (r.error ?? "No legal plan B.") + fixedNote };
  const planB = r.proposals[0];
  const end = addMonthsToDate(today, Math.max(12, Math.min(18, settings.months)));
  const committed = stays.filter((s) => s.status !== "idea" && hasDates(s) && s.end! > today && s.start! < end);
  const active = committed.map((s) => ({ id: s.id, cityId: s.place.cityId, name: s.place.name, start: s.start! < today ? today : s.start!, end: s.end! > end ? end : s.end! }));
  // Score the active rotation the same way, for the before/after figures.
  let before: ReturnType<typeof impactOf> = { cost: null, schengen: null, travel: null, score: null };
  try {
    const prep = await prepareSolve({ settings: { ...settings, pool, results: 1 }, start: today }, today);
    if (!("error" in prep)) {
      const ev = evaluatePlan(prep.input, activePlan(stays, today, end), {}, false);
      if (!("error" in ev)) before = impactOf(ev);
    }
  } catch {
    // Before figures stay unknown.
  }
  const after = impactOf(planB);
  const held = active.reduce((a, s) => a + Math.max(0, (Date.parse(s.end) - Date.parse(s.start)) / 86_400_000), 0);
  const horizonNights = (Date.parse(end) - Date.parse(today)) / 86_400_000;
  const gapNote = held < horizonNights ? ` Your rotation leaves ${Math.round(horizonNights - held)} nights unplanned in this window, so its "before" figures cover only the nights it holds.` : "";
  return {
    ...base,
    planB,
    note: (fixedNote + gapNote).trim() || undefined,
    diff: {
      stays: diffStays(active, planB.stays),
      scoreBefore: before.score,
      scoreAfter: after.score,
      costBefore: before.cost,
      costAfter: after.cost,
      schengenBefore: before.schengen,
      schengenAfter: after.schengen,
      travelBefore: before.travel,
      travelAfter: after.travel,
    },
  };
}

// ── The owner's decisions ──────────────────────────────────────────────

/** Proposals newest first; a snoozed one whose snooze has passed reads as open. */
export async function listProposals(today = todayIso()): Promise<Proposal[]> {
  const d = await readSolverDoc();
  return d.proposals.map((p) => (p.status === "snoozed" && p.snoozedUntil && p.snoozedUntil <= today ? { ...p, status: "open" as const } : p));
}

export async function decideProposal(id: string, action: "accept" | "dismiss" | "snooze", opts: { days?: number; now?: Date } = {}): Promise<{ proposal: Proposal; added?: number; removed?: number } | { error: string; message: string }> {
  const now = opts.now ?? new Date();
  const today = todayIso(now);
  const doc = await readSolverDoc();
  const p = doc.proposals.find((x) => x.id === id);
  if (!p) return { error: "not_found", message: "No such proposal." };
  if (p.status !== "open" && p.status !== "snoozed") return { error: "not_open", message: `This proposal was already ${p.status}.` };
  let result: { added?: number; removed?: number } = {};
  if (action === "accept") {
    if (!p.planB) return { error: "no_plan_b", message: "This proposal has no plan B to accept." };
    // Refuse a stale plan B: a stay it kept fixed has since been changed or removed.
    const rot = stateOf(await readRotation());
    const stale = p.planB.stays.filter((s) => s.role === "fixed").find((s) => {
      const cur = rot.stays.find((x) => x.id === s.id);
      return !cur || cur.place.cityId !== s.cityId || !hasDates(cur) || cur.start! > s.start || cur.end! < s.end;
    });
    if (stale) return { error: "stale", message: `${stale.name} changed since this plan B was made. Run the check again for a fresh one.` };
    const r = await acceptPlan(planOf(p.planB), p.id.replace(/^pr-/, "rp"), now, today);
    if ("error" in r) return { error: "stale", message: r.message };
    result = { added: r.added.length, removed: r.removed.length };
  }
  const updated = await updateSolverDoc((d) => {
    const x = d.proposals.find((y) => y.id === id)!;
    x.status = action === "accept" ? "accepted" : action === "dismiss" ? "dismissed" : "snoozed";
    x.decidedAt = now.toISOString();
    if (action === "snooze") x.snoozedUntil = addDays(today, opts.days ?? 7);
    return { ...x };
  });
  return { proposal: updated, ...result };
}

registerDailyJob({
  name: "replan",
  run: async ({ now }) => {
    const r = await runReplan({ now });
    return { watched: r.watched, shifts: r.shifts, fired: r.fired, proposals: r.proposals, reminders: r.reminders };
  },
});
