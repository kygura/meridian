// Quick-log form model (DESIGN-journal.md §6.2): drafts <-> JourneyInput, segment
// generation from stop pairs, validation. Pure; the QuickLogSheet owns the UI.

import type {
  ExperienceKind,
  Experience,
  Journey,
  JourneyInput,
  Lodging,
  Money,
  Provenance,
  Rating,
  Segment,
  SegmentMode,
  Stop,
} from "../types";

export const MANUAL: Provenance = { source: "manual", confidence: "high" };

export interface MoneyDraft {
  amount: string;
  currency: string;
  /** Stored value on edit, with the date it was priced for: unchanged items keep their eur/rateDate. */
  base?: { money: Money; date: string };
}

export interface StopDraft {
  key: string;
  cityId: string;
  arrive: string;
  depart: string;
  rating?: Rating;
  crowd?: number;
  provenance?: Provenance;
  lodging?: { name: string; kind: Lodging["kind"] | ""; cost: MoneyDraft; provenance?: Provenance };
}

export interface SegmentDraft {
  key: string;
  fromCityId: string;
  toCityId: string;
  mode: SegmentMode;
  date: string;
  /** True while the date follows the previous stop's depart. */
  dateAuto: boolean;
  carrier: string;
  number: string;
  cost: MoneyDraft;
  /** "+ OTHER SEGMENT": free from/to, not tied to a stop pair. */
  extra: boolean;
  /** A pair segment whose stop pair went away; parked as "other" and re-attached if the pair returns. */
  orphan?: boolean;
  /** Original segment on edit: provenance, arriveAt, bookingRef, bookingId survive a save. */
  base?: Segment;
}

export interface ExperienceDraft {
  key: string;
  cityId: string;
  date: string;
  title: string;
  kind: ExperienceKind | "";
  cost: MoneyDraft;
  rating?: Rating;
  base?: Experience;
}

export interface LogForm {
  title: string;
  stops: StopDraft[];
  segments: SegmentDraft[];
  experiences: ExperienceDraft[];
  rating?: Rating;
  tags: string[];
  travellers?: number;
  notes: string;
  /** Edit mode: the journey being replaced; its status/fromTripId/bookingIds/provenance are kept. */
  base?: Journey;
}

let counter = 0;
export const newKey = (): string => `k${++counter}`;

export const emptyMoney = (currency = "EUR"): MoneyDraft => ({ amount: "", currency });

export function newStop(cityId = "", arrive = ""): StopDraft {
  return { key: newKey(), cityId, arrive, depart: "" };
}

export function emptyForm(prefillCityIds: string[] = []): LogForm {
  return {
    title: "",
    stops: (prefillCityIds.length ? prefillCityIds : [""]).map((c) => newStop(c)),
    segments: [],
    experiences: [],
    tags: [],
    notes: "",
  };
}

// ── Segments follow adjacent stop pairs ──────────────────────────────

/** One draft per adjacent stop pair. A pair that already exists keeps its mode, carrier,
 *  number and cost; reordering stops therefore does not lose them. "Other" segments pass through.
 *  `create: false` (editing an existing journey, same city chain) never invents a segment for a bare pair. */
export function syncSegments(stops: StopDraft[], existing: SegmentDraft[], create = true): SegmentDraft[] {
  const pool = existing.filter((s) => !s.extra || s.orphan);
  const out: SegmentDraft[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (!a.cityId || !b.cityId || a.cityId === b.cityId) continue;
    const at = pool.findIndex((s) => s.fromCityId === a.cityId && s.toCityId === b.cityId);
    const found = at >= 0 ? pool.splice(at, 1)[0] : undefined;
    if (!found && !create) continue;
    out.push(
      found
        ? { ...found, extra: false, orphan: false, date: found.dateAuto ? a.depart : found.date }
        : {
            key: newKey(),
            fromCityId: a.cityId,
            toCityId: b.cityId,
            mode: "flight",
            date: a.depart,
            dateAuto: true,
            carrier: "",
            number: "",
            cost: emptyMoney(),
            extra: false,
          }
    );
  }
  // A pair that went away keeps any details the user entered, parked as an "other" segment.
  const parked = pool
    .filter((s) => s.base || s.carrier.trim() || s.number.trim() || s.cost.amount.trim() || s.mode !== "flight")
    .map((s) => ({ ...s, extra: true, orphan: true }));
  return [...out, ...existing.filter((s) => s.extra && !s.orphan), ...parked];
}

export function newExtraSegment(): SegmentDraft {
  return {
    key: newKey(),
    fromCityId: "",
    toCityId: "",
    mode: "other",
    date: "",
    dateAuto: false,
    carrier: "",
    number: "",
    cost: emptyMoney(),
    extra: true,
  };
}

export function newExperience(cityId = "", date = ""): ExperienceDraft {
  return { key: newKey(), cityId, date, title: "", kind: "", cost: emptyMoney() };
}

// ── Validation (§6.2) ────────────────────────────────────────────────

/** Keys are DOM ids (`jr-f-<key>`): `stops`, `stop-<k>-city|dates`,
 *  `money-<k>-<part>`, `exp-<k>-city|date|title`, `seg-<k>-from|to`. Insertion order = focus order. */
export type LogErrors = Record<string, string>;

/** "12.5", ".5" or "12,50" (comma only as a 1-2 digit decimal). Grouped input ("1,234") is NaN, never 1.234. */
function parseAmount(raw: string): number {
  const t = raw.trim();
  if (/^(\d+|\d*\.\d+)$/.test(t)) return Number(t);
  if (/^\d+,\d{1,2}$/.test(t)) return Number(t.replace(",", "."));
  return NaN;
}

function badMoney(m: MoneyDraft): boolean {
  if (m.amount.trim() === "") return false;
  const n = parseAmount(m.amount);
  return !Number.isFinite(n) || n <= 0;
}

export function validateLog(form: LogForm): LogErrors {
  const e: LogErrors = {};
  if (!form.stops.some((s) => s.cityId)) e.stops = "ADD AT LEAST ONE STOP WITH A CITY";
  form.stops.forEach((s, i) => {
    if (!s.cityId) e[`stop-${s.key}-city`] = "PICK A CITY";
    if (!s.arrive || !s.depart) e[`stop-${s.key}-dates`] = "ARRIVE AND DEPART REQUIRED";
    else if (s.depart < s.arrive) e[`stop-${s.key}-dates`] = "DEPART IS BEFORE ARRIVE";
    else if (i > 0) {
      const prev = form.stops[i - 1];
      if (prev.depart && s.arrive < prev.depart) e[`stop-${s.key}-dates`] = "OVERLAPS PREVIOUS STOP";
    }
    if (s.lodging && badMoney(s.lodging.cost)) e[`money-${s.key}-stay`] = "AMOUNT MUST BE MORE THAN 0";
    if (s.lodging && !s.lodging.name.trim() && (s.lodging.cost.amount.trim() !== "" || s.lodging.kind))
      e[`stop-${s.key}-stay`] = "STAY NAME REQUIRED";
  });
  for (const g of form.segments) {
    if (g.extra) {
      if (!g.fromCityId) e[`seg-${g.key}-from`] = "PICK A FROM CITY";
      if (!g.toCityId) e[`seg-${g.key}-to`] = "PICK A TO CITY";
    }
    if (badMoney(g.cost)) e[`money-${g.key}-seg`] = "AMOUNT MUST BE MORE THAN 0";
  }
  for (const x of form.experiences) {
    if (!x.title.trim()) e[`exp-${x.key}-title`] = "TITLE REQUIRED";
    if (!x.cityId) e[`exp-${x.key}-city`] = "PICK A CITY";
    if (!x.date) e[`exp-${x.key}-date`] = "DATE REQUIRED";
    if (badMoney(x.cost)) e[`money-${x.key}-exp`] = "AMOUNT MUST BE MORE THAN 0";
  }
  return e;
}

// ── Draft <-> API ────────────────────────────────────────────────────

/** "Lisbon", "Lisbon & Porto", "Lisbon, Porto & Madrid", "Lisbon + 3 more". */
export function autoTitle(names: string[]): string {
  const u = [...new Set(names.filter(Boolean))];
  if (u.length <= 1) return u[0] ?? "Untitled journey";
  if (u.length === 2) return `${u[0]} & ${u[1]}`;
  if (u.length === 3) return `${u[0]}, ${u[1]} & ${u[2]}`;
  return `${u[0]} + ${u.length - 1} more`;
}

// The server fills eur/rateDate (R5); the client sends amount + currency only.
// An unchanged amount, currency and date keeps its stored eur/rateDate (the server re-prices otherwise).
const toMoney = (m: MoneyDraft, date: string): Money | undefined => {
  if (m.amount.trim() === "") return undefined;
  const amount = parseAmount(m.amount);
  const b = m.base;
  if (b && b.money.amount === amount && b.money.currency === m.currency && b.date === date.slice(0, 10)) return b.money;
  return { amount, currency: m.currency } as Money;
};

const orUndef = (s: string): string | undefined => (s.trim() === "" ? undefined : s.trim());

export function toJourneyInput(form: LogForm, nameOf: (cityId: string) => string): JourneyInput {
  const stops: Stop[] = form.stops
    .filter((s) => s.cityId)
    .map((s) => ({
      cityId: s.cityId,
      arrive: s.arrive,
      depart: s.depart,
      ...(s.rating ? { rating: s.rating } : {}),
      ...(s.crowd !== undefined ? { crowdOverride: s.crowd } : {}),
      ...(s.provenance ? { provenance: s.provenance } : {}),
      ...(s.lodging && s.lodging.name.trim()
        ? {
            lodging: {
              name: s.lodging.name.trim(),
              ...(s.lodging.kind ? { kind: s.lodging.kind } : {}),
              ...(toMoney(s.lodging.cost, s.arrive) ? { cost: toMoney(s.lodging.cost, s.arrive) } : {}),
              provenance: s.lodging.provenance ?? MANUAL,
            },
          }
        : {}),
    }));

  const segments: Segment[] = form.segments
    .filter((g) => g.fromCityId && g.toCityId)
    .map((g) => ({ ...g, departAt: g.date || stops[0]?.arrive || "" }))
    .map((g) => ({
      ...(g.base?.arriveAt ? { arriveAt: g.base.arriveAt } : {}),
      ...(g.base?.bookingRef ? { bookingRef: g.base.bookingRef } : {}),
      ...(g.base?.bookingId ? { bookingId: g.base.bookingId } : {}),
      mode: g.mode,
      fromCityId: g.fromCityId,
      toCityId: g.toCityId,
      departAt: g.departAt,
      ...(orUndef(g.carrier) ? { carrier: orUndef(g.carrier) } : {}),
      ...(orUndef(g.number) ? { number: orUndef(g.number) } : {}),
      ...(toMoney(g.cost, g.departAt) ? { cost: toMoney(g.cost, g.departAt) } : {}),
      provenance: g.base?.provenance ?? MANUAL,
    }));

  const experiences: Experience[] = form.experiences.map((x) => ({
    ...(x.base?.lat !== undefined ? { lat: x.base.lat } : {}),
    ...(x.base?.lng !== undefined ? { lng: x.base.lng } : {}),
    cityId: x.cityId,
    date: x.date,
    title: x.title.trim(),
    ...(x.kind ? { kind: x.kind } : {}),
    ...(toMoney(x.cost, x.date) ? { cost: toMoney(x.cost, x.date) } : {}),
    ...(x.rating ? { rating: x.rating } : {}),
    provenance: x.base?.provenance ?? MANUAL,
  }));

  const arrives = stops.map((s) => s.arrive).sort();
  const departs = stops.map((s) => s.depart).sort();
  const b = form.base;
  return {
    title: form.title.trim() || autoTitle(stops.map((s) => nameOf(s.cityId))),
    status: b?.status ?? "confirmed",
    startDate: arrives[0] ?? "",
    endDate: departs[departs.length - 1] ?? "",
    stops,
    segments,
    experiences,
    ...(form.rating ? { rating: form.rating } : {}),
    tags: form.tags,
    ...(orUndef(form.notes) ? { notes: form.notes } : {}),
    ...(form.travellers !== undefined ? { companions: form.travellers } : {}),
    ...(b?.fromTripId ? { fromTripId: b.fromTripId } : {}),
    bookingIds: b?.bookingIds ?? [],
    provenance: b?.provenance ?? MANUAL,
  };
}

const moneyDraft = (m: Money | undefined, date: string): MoneyDraft =>
  m ? { amount: String(m.amount), currency: m.currency, base: { money: m, date: date.slice(0, 10) } } : emptyMoney();

export function fromJourney(j: Journey): LogForm {
  const stops: StopDraft[] = j.stops.map((s) => ({
    key: newKey(),
    cityId: s.cityId,
    arrive: s.arrive,
    depart: s.depart,
    rating: s.rating,
    crowd: s.crowdOverride,
    provenance: s.provenance,
    lodging: s.lodging
      ? { name: s.lodging.name, kind: s.lodging.kind ?? "", cost: moneyDraft(s.lodging.cost, s.arrive), provenance: s.lodging.provenance }
      : undefined,
  }));
  // Segments joining consecutive stops line up with generated pairs; the rest are "other".
  const pairs = new Set(
    stops.slice(0, -1).map((s, i) => `${s.cityId}>${stops[i + 1].cityId}`)
  );
  const used = new Set<string>();
  const segments: SegmentDraft[] = j.segments.map((g) => {
    const id = `${g.fromCityId}>${g.toCityId}`;
    const extra = !pairs.has(id) || used.has(id);
    used.add(id);
    return {
      key: newKey(),
      fromCityId: g.fromCityId,
      toCityId: g.toCityId,
      mode: g.mode,
      date: g.departAt,
      dateAuto: false,
      carrier: g.carrier ?? "",
      number: g.number ?? "",
      cost: moneyDraft(g.cost, g.departAt),
      extra,
      base: g,
    };
  });
  return {
    title: j.title,
    stops,
    segments,
    experiences: j.experiences.map((x) => ({
      key: newKey(),
      cityId: x.cityId,
      date: x.date,
      title: x.title,
      kind: x.kind ?? "",
      cost: moneyDraft(x.cost, x.date),
      rating: x.rating,
      base: x,
    })),
    rating: j.rating,
    tags: j.tags,
    travellers: j.companions,
    notes: j.notes ?? "",
    base: j,
  };
}

/** True when the form differs from a pristine blank/prefilled one (discard guard). */
export function isDirty(form: LogForm, initial: LogForm): boolean {
  const norm = (f: LogForm) =>
    JSON.stringify({ ...f, base: undefined, stops: f.stops.map(({ key, ...r }) => r), segments: f.segments.map(({ key, base, ...r }) => r), experiences: f.experiences.map(({ key, base, ...r }) => r) });
  return norm(form) !== norm(initial);
}
