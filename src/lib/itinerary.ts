// Itineraries: the concrete side of a Trip once it has a year (ADR 0010). Dates on
// stops, a stay, activities, and bookings recorded on legs. Pure helpers: validation,
// the day-by-day view, cost totals, and cleaning of data that arrives from a file or
// another device. No fetching, no browser imports (the server uses these too).

import { datedSpan, isMonthSpan, tripSeason } from "./season";
import { isLegMode, MODE_LABEL, OUTBOUND_LEG, RETURN_LEG, type TripLeg, type TripRoute } from "./legs";
import { isLocalDateTime, zonedToUtc } from "./zoned";
import type { LegMode, LegPlan, LegRecord, MoneyInput, Trip, TripActivity, TripLodging, TripNode } from "../types";

// ── Dates ────────────────────────────────────────────────────────────

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isClockTime(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Nights at a stop: derived from its dates, never stored. Null until both are set and ordered. */
export function stopNights(node: Pick<TripNode, "arrive" | "depart">): number | null {
  if (!isIsoDate(node.arrive) || !isIsoDate(node.depart)) return null;
  const n = daysBetween(node.arrive, node.depart);
  return n >= 0 ? n : null;
}

/** "3 nights", "1 night", "day visit". */
export function nightsText(n: number): string {
  return n === 0 ? "day visit" : `${n} ${n === 1 ? "night" : "nights"}`;
}

/** "Mon 1 Mar 2027" */
export function formatDay(iso: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", {
    weekday: opts.weekday === false ? undefined : "short",
    day: "numeric",
    month: "short",
    year: opts.year === false ? undefined : "numeric",
    timeZone: "UTC",
  });
}

/** Does the trip carry any itinerary detail at all? */
export function hasItinerary(trip: Pick<Trip, "nodes" | "homeLeg">): boolean {
  return (
    !!trip.homeLeg?.booked ||
    trip.nodes.some((n) => n.arrive || n.depart || n.lodging || n.activities?.length || n.notes || n.travel?.booked)
  );
}

/** The stops a leg runs between. The departure is not a stop, so the first and last legs have one end. */
export function legStops(trip: Pick<Trip, "nodes">, leg: Pick<TripLeg, "index">): { from?: TripNode; to?: TripNode } {
  if (leg.index === OUTBOUND_LEG) return { to: trip.nodes[0] };
  if (leg.index === RETURN_LEG) return { from: trip.nodes[trip.nodes.length - 1] };
  return { from: trip.nodes[leg.index], to: trip.nodes[leg.index + 1] };
}

/** The date a leg happens on: its recorded departure, else the day you leave the stop before it, else the day you arrive. */
export function legDate(trip: Pick<Trip, "nodes">, leg: TripLeg): string | undefined {
  const dep = leg.record?.departAt;
  if (dep && isLocalDateTime(dep)) return dep.slice(0, 10);
  const { from, to } = legStops(trip, leg);
  if (from && isIsoDate(from.depart)) return from.depart;
  if (to && isIsoDate(to.arrive)) return to.arrive;
  return undefined;
}

// ── Validation ───────────────────────────────────────────────────────

export interface ItineraryIssue {
  level: "error" | "warning";
  /** Stop index the issue is about, when it is about one. */
  stop?: number;
  /** Leg index (lib/legs) the issue is about. */
  leg?: number;
  message: string;
}

export type ZoneOf = (cityId: string) => string | undefined;

/**
 * Check that the itinerary's dates are ordered and agree with each other. Errors are
 * contradictions (leaving before arriving, two stops overlapping); warnings are things
 * that are probably a slip (an activity outside the stop's dates).
 */
export function validateItinerary(trip: Trip, route: TripRoute, zoneOf?: ZoneOf): ItineraryIssue[] {
  const out: ItineraryIssue[] = [];
  const season = tripSeason(trip);
  let lastDated: { index: number; depart: string } | null = null;

  trip.nodes.forEach((n, i) => {
    const a = isIsoDate(n.arrive) ? n.arrive : undefined;
    const d = isIsoDate(n.depart) ? n.depart : undefined;
    if (a && d && a > d) out.push({ level: "error", stop: i, message: `${n.name}: you leave (${formatDay(d)}) before you arrive (${formatDay(a)}).` });
    if (a && !d) out.push({ level: "warning", stop: i, message: `${n.name} has an arrival date but no departure date.` });
    if (d && !a) out.push({ level: "warning", stop: i, message: `${n.name} has a departure date but no arrival date.` });

    if (a && lastDated && a < lastDated.depart) {
      const prev = trip.nodes[lastDated.index];
      out.push({
        level: "error",
        stop: i,
        message: `${n.name} starts on ${formatDay(a)}, before you leave ${prev.name} on ${formatDay(lastDated.depart)}.`,
      });
    }
    const end = d ?? a;
    if (end && (!lastDated || end >= lastDated.depart)) lastDated = { index: i, depart: end };

    if (trip.year && isMonthSpan(n.months) && (a || d)) {
      const span = datedSpan(n.months, trip.year, season?.start ?? n.months.start);
      if ((a && (a < span.start || a > span.end)) || (d && (d < span.start || d > span.end))) {
        out.push({
          level: "warning",
          stop: i,
          message: `${n.name}: the dates fall outside the months you placed it in (${formatDay(span.start, { weekday: false })} to ${formatDay(span.end, { weekday: false })}).`,
        });
      }
    }

    const l = n.lodging;
    if (l) {
      const ci = isIsoDate(l.checkIn) ? l.checkIn : undefined;
      const co = isIsoDate(l.checkOut) ? l.checkOut : undefined;
      if (ci && co && ci > co) out.push({ level: "error", stop: i, message: `${l.name || "The stay"} in ${n.name}: check-out is before check-in.` });
      else if ((ci && a && ci < a) || (co && d && co > d) || (ci && d && ci > d) || (co && a && co < a)) {
        out.push({ level: "warning", stop: i, message: `${l.name || "The stay"} in ${n.name} is booked for dates outside your time there.` });
      }
    }
    for (const act of n.activities ?? []) {
      if (!isIsoDate(act.date)) continue;
      if ((a && act.date < a) || (d && act.date > d)) {
        out.push({ level: "warning", stop: i, message: `"${act.title}" is on ${formatDay(act.date)}, outside your time in ${n.name}.` });
      }
    }
  });

  for (const leg of route.all) {
    const r = leg.record;
    if (!r) continue;
    const label = `${leg.from.name} to ${leg.to.name}`;
    const dep = isLocalDateTime(r.departAt) ? r.departAt : undefined;
    const arr = isLocalDateTime(r.arriveAt) ? r.arriveAt : undefined;
    if (dep && arr) {
      const du = zonedToUtc(dep, zoneOf?.(leg.from.cityId));
      const au = zonedToUtc(arr, zoneOf?.(leg.to.cityId));
      if (du && au ? au.getTime() <= du.getTime() : !du && !au && leg.from.cityId === leg.to.cityId && arr <= dep) {
        out.push({ level: "error", leg: leg.index, message: `${label}: the recorded arrival is not after the departure.` });
      }
    }
    const { from, to } = legStops(trip, leg);
    if (dep && from && isIsoDate(from.depart) && dep.slice(0, 10) !== from.depart) {
      out.push({
        level: "warning",
        leg: leg.index,
        message: `${label} leaves on ${formatDay(dep.slice(0, 10))}, but ${from.name} ends on ${formatDay(from.depart)}.`,
      });
    }
    if (arr && to && isIsoDate(to.arrive) && arr.slice(0, 10) !== to.arrive) {
      out.push({
        level: "warning",
        leg: leg.index,
        message: `${label} arrives on ${formatDay(arr.slice(0, 10))}, but ${to.name} starts on ${formatDay(to.arrive)}.`,
      });
    }
  }
  return out;
}

// ── Day by day ───────────────────────────────────────────────────────

export interface DayItem {
  kind: "leg" | "check-in" | "check-out" | "activity";
  /** HH:MM local, when known. Items without a time sort first within their kind. */
  time?: string;
  title: string;
  detail?: string;
  mode?: LegMode;
  /** Legs and stays: a booking is recorded. */
  booked?: boolean;
  stop?: number;
  leg?: number;
}

export interface ItineraryDay {
  date: string;
  /** Where you are that day (two names on a travel day). */
  places: string[];
  items: DayItem[];
}

/** A run of days: one day with things on it, or several quiet days in the same place. */
export interface DayGroup {
  from: string;
  to: string;
  days: number;
  places: string[];
  items: DayItem[];
}

export interface DayByDay {
  groups: DayGroup[];
  /** Stops with no dates yet (indices), listed under the days. */
  undated: number[];
}

const KIND_ORDER: Record<DayItem["kind"], number> = { "check-out": 0, leg: 1, "check-in": 2, activity: 3 };

function legTitle(leg: TripLeg): string {
  const r = leg.record;
  const what = [r?.carrier, r?.number].filter(Boolean).join(" ");
  return `${MODE_LABEL[leg.mode]} to ${leg.to.name}${what ? ` · ${what}` : ""}`;
}

function clock(local: string | undefined): string | undefined {
  return isLocalDateTime(local) ? local.slice(11, 16) : undefined;
}

/** Every dated thing in the trip, one entry per day from the first date to the last. */
export function itineraryDays(trip: Trip, route: TripRoute): ItineraryDay[] {
  const byDate = new Map<string, DayItem[]>();
  const put = (date: string | undefined, item: DayItem) => {
    if (!isIsoDate(date)) return;
    const arr = byDate.get(date);
    if (arr) arr.push(item);
    else byDate.set(date, [item]);
  };

  for (const leg of route.all) {
    const r = leg.record;
    const arr = clock(r?.arriveAt);
    const arrDay = isLocalDateTime(r?.arriveAt) ? r!.arriveAt!.slice(0, 10) : undefined;
    const date = legDate(trip, leg);
    put(date, {
      kind: "leg",
      time: clock(r?.departAt),
      title: legTitle(leg),
      detail: arr ? `Arrives ${arr}${arrDay && arrDay !== date ? ` on ${formatDay(arrDay, { year: false })}` : ""}` : undefined,
      mode: leg.mode,
      booked: !!r,
      leg: leg.index,
    });
  }

  trip.nodes.forEach((n, i) => {
    const l = n.lodging;
    if (l?.name) {
      const where = l.address ? l.address : undefined;
      put(l.checkIn ?? n.arrive, { kind: "check-in", title: `Check in: ${l.name}`, detail: where, booked: !!l.bookingRef, stop: i });
      put(l.checkOut ?? n.depart, { kind: "check-out", title: `Check out: ${l.name}`, stop: i });
    }
    for (const a of n.activities ?? []) {
      put(a.date, { kind: "activity", time: isClockTime(a.time) ? a.time : undefined, title: a.title, detail: a.note, stop: i });
    }
  });

  const stays = trip.nodes
    .map((n, i) => ({ i, name: n.name, a: isIsoDate(n.arrive) ? n.arrive : undefined, d: isIsoDate(n.depart) ? n.depart : undefined }))
    .filter((s) => s.a || s.d)
    .map((s) => ({ ...s, a: (s.a ?? s.d)!, d: (s.d ?? s.a)! }))
    .filter((s) => s.a <= s.d);

  const dates = [...byDate.keys(), ...stays.flatMap((s) => [s.a, s.d])].sort();
  if (dates.length === 0) return [];
  const first = dates[0];
  const last = dates[dates.length - 1];
  // A slip in a year (2072 for 2027) must not build tens of thousands of rows.
  const span = Math.min(daysBetween(first, last), 1100);

  const out: ItineraryDay[] = [];
  for (let k = 0; k <= span; k++) {
    const date = addDays(first, k);
    const places = stays.filter((s) => s.a <= date && date <= s.d).map((s) => s.name);
    const items = (byDate.get(date) ?? []).slice().sort((x, y) => {
      if (x.time && y.time && x.time !== y.time) return x.time < y.time ? -1 : 1;
      if (KIND_ORDER[x.kind] !== KIND_ORDER[y.kind]) return KIND_ORDER[x.kind] - KIND_ORDER[y.kind];
      return x.time ? (y.time ? 0 : 1) : y.time ? -1 : 0;
    });
    out.push({ date, places: [...new Set(places)], items });
  }
  return out;
}

/** Days for display: quiet days in the same place fold into one row. */
export function dayByDay(trip: Trip, route: TripRoute): DayByDay {
  const days = itineraryDays(trip, route);
  const groups: DayGroup[] = [];
  for (const d of days) {
    const prev = groups[groups.length - 1];
    const quiet = d.items.length === 0;
    if (quiet && prev && prev.items.length === 0 && prev.places.join("|") === d.places.join("|")) {
      prev.to = d.date;
      prev.days++;
    } else {
      groups.push({ from: d.date, to: d.date, days: 1, places: d.places, items: d.items });
    }
  }
  const undated = trip.nodes.map((n, i) => (isIsoDate(n.arrive) || isIsoDate(n.depart) ? -1 : i)).filter((i) => i >= 0);
  return { groups, undated };
}

// ── Costs ────────────────────────────────────────────────────────────

/** Amounts by currency, as entered. Nothing is converted. */
export type Sums = Record<string, number>;

function addTo(sums: Sums, m: MoneyInput | undefined): void {
  if (!m || !(m.amount >= 0) || !m.currency) return;
  sums[m.currency] = (sums[m.currency] ?? 0) + m.amount;
}

export interface TripCosts {
  /** Prices recorded on legs booked elsewhere. */
  transportEntered: Sums;
  /** USD estimate for flight legs with no recorded price. */
  flightEstimate: number;
  /** USD estimate for ground and sea legs with no recorded price. */
  groundEstimate: number;
  /** Stay prices as entered. */
  lodgingEntered: Sums;
  /** Stops with nights but no stay price entered (indices). */
  lodgingMissing: number[];
  activitiesEntered: Sums;
}

export function tripCosts(trip: Trip, route: TripRoute): TripCosts {
  const c: TripCosts = {
    transportEntered: {},
    flightEstimate: 0,
    groundEstimate: 0,
    lodgingEntered: {},
    lodgingMissing: [],
    activitiesEntered: {},
  };
  for (const leg of route.all) {
    if (leg.record?.cost) addTo(c.transportEntered, leg.record.cost);
    else if (leg.mode === "flight") c.flightEstimate += leg.cost;
    else c.groundEstimate += leg.cost;
  }
  trip.nodes.forEach((n, i) => {
    if (n.lodging?.cost) addTo(c.lodgingEntered, n.lodging.cost);
    else if ((stopNights(n) ?? 0) > 0) c.lodgingMissing.push(i);
    for (const a of n.activities ?? []) addTo(c.activitiesEntered, a.cost);
  });
  return c;
}

export function sumsEmpty(s: Sums): boolean {
  return Object.keys(s).length === 0;
}

// ── Cleaning (files, other devices, old saves) ───────────────────────

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, max);
  return t || undefined;
};

/** http(s) links only: a link is opened from the trip, so no javascript: or data: URLs. */
export function cleanLink(v: unknown): string | undefined {
  const s = str(v, 2000);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function cleanMoney(v: unknown): MoneyInput | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const amount = typeof o.amount === "number" ? o.amount : NaN;
  const currency = typeof o.currency === "string" ? o.currency.trim().toUpperCase() : "";
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return { amount, currency };
}

const LODGING_KINDS = ["hotel", "apartment", "hostel", "friends", "other"] as const;

/** Drop undefined keys so cleaned objects compare and serialize the same everywhere. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

export function cleanLodging(v: unknown): TripLodging | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const name = str(o.name, 200);
  if (!name) return undefined;
  return compact<TripLodging>({
    name,
    kind: LODGING_KINDS.includes(o.kind as (typeof LODGING_KINDS)[number]) ? (o.kind as TripLodging["kind"]) : undefined,
    address: str(o.address, 300),
    checkIn: isIsoDate(o.checkIn) ? o.checkIn : undefined,
    checkOut: isIsoDate(o.checkOut) ? o.checkOut : undefined,
    cost: cleanMoney(o.cost),
    bookingRef: str(o.bookingRef, 80),
    link: cleanLink(o.link),
  });
}

export function cleanActivity(v: unknown): TripActivity | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const title = str(o.title, 200);
  const id = str(o.id, 60);
  if (!title || !id) return undefined;
  return compact<TripActivity>({
    id,
    title,
    date: isIsoDate(o.date) ? o.date : undefined,
    time: isClockTime(o.time) ? o.time : undefined,
    cost: cleanMoney(o.cost),
    link: cleanLink(o.link),
    note: str(o.note, 1000),
  });
}

export function cleanLegRecord(v: unknown): LegRecord | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const r = compact<LegRecord>({
    carrier: str(o.carrier, 100),
    number: str(o.number, 20),
    reference: str(o.reference, 80),
    cost: cleanMoney(o.cost),
    departAt: isLocalDateTime(o.departAt) ? o.departAt : undefined,
    arriveAt: isLocalDateTime(o.arriveAt) ? o.arriveAt : undefined,
  });
  return Object.keys(r).length ? r : undefined;
}

export function cleanLegPlan(v: unknown): LegPlan | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const fromCityId = str(o.fromCityId, 200);
  if (!fromCityId) return undefined;
  const plan = compact<LegPlan>({ fromCityId, mode: isLegMode(o.mode) ? o.mode : undefined, booked: cleanLegRecord(o.booked) });
  return plan.mode || plan.booked ? plan : undefined;
}

export type NodeItinerary = Pick<TripNode, "arrive" | "depart" | "lodging" | "activities" | "notes" | "travel">;

/** The itinerary fields of a stop, validated. Unknown or malformed parts are dropped, not repaired. */
export function cleanNodeItinerary(v: unknown): NodeItinerary {
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const activities = Array.isArray(o.activities)
    ? o.activities.map(cleanActivity).filter((a): a is TripActivity => !!a).slice(0, 200)
    : [];
  return compact<NodeItinerary>({
    arrive: isIsoDate(o.arrive) ? o.arrive : undefined,
    depart: isIsoDate(o.depart) ? o.depart : undefined,
    lodging: cleanLodging(o.lodging),
    activities: activities.length ? activities : undefined,
    notes: str(o.notes, 4000),
    travel: cleanLegPlan(o.travel),
  });
}

export function cleanTravellers(v: unknown): number | undefined {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 9 ? (v as number) : undefined;
}

/**
 * A stop as a reusable plan: the place, its months and how you get there, without the
 * dates, stay, activities and bookings of one particular year. Used when a trip is copied.
 */
export function planOnlyNode(n: TripNode): TripNode {
  const { arrive: _a, depart: _d, lodging: _l, activities: _x, notes: _n, travel, ...rest } = n;
  return travel?.mode ? { ...rest, travel: { fromCityId: travel.fromCityId, mode: travel.mode } } : rest;
}

export function newActivityId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
