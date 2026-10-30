// Journal store (spec-journal D1/§4): data/journal.json → { version: 1, journeys }.
//
// The server owns id, createdAt/updatedAt and fingerprint. Every input is
// re-validated here (not only in the route) because import/agent code calls
// these functions directly. All Money is normalized through fx (D7/R5); an
// unavailable rate surfaces as FxUnavailableError and nothing is stored.
//
// Extension point: `onJourneySaved` listeners run on every create/update after
// the journey is fully built and before it is persisted. They may mutate it
// (e.g. set `fingerprint`, stop fingerprints/observed). A throwing listener is
// logged and ignored — a save never fails because a derived field could not be
// computed. On update the previous fingerprint is carried over unless a
// listener replaces it.

import { randomUUID } from "crypto";
import type { Experience, JournalSettings, Journey, Lodging, Segment, Stop } from "../../src/types.js";
import { getCityById } from "./cities.js";
import { normalizeMoney } from "./fx.js";
import { createJsonStore } from "./jsonStore.js";
import {
  journalSettingsSchema,
  journeyInputSchema,
  type JourneyInputRaw,
  type MoneyInputBody,
} from "./journalSchemas.js";

export interface JournalFile {
  version: 1;
  journeys: Journey[];
}

const journalStore = createJsonStore<JournalFile>("journal.json", () => ({ version: 1, journeys: [] }));
const settingsStore = createJsonStore<JournalSettings>("settings.json", () => ({}));

export interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

/** Semantically invalid input (dates out of order, unknown city). Maps to HTTP 400. */
export class JournalValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    this.name = "JournalValidationError";
  }
}

// ── onJourneySaved hook ─────────────────────────────────────────────

export type JourneySavedListener = (journey: Journey, previous: Journey | undefined) => void | Promise<void>;

const listeners: JourneySavedListener[] = [];

/** Register a listener; returns an unsubscribe function. */
export function onJourneySaved(listener: JourneySavedListener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

async function runListeners(journey: Journey, previous: Journey | undefined): Promise<void> {
  for (const l of listeners) {
    try {
      await l(journey, previous);
    } catch (err) {
      console.error("[journal] onJourneySaved listener failed:", err);
    }
  }
}

// ── Validation + normalization ──────────────────────────────────────

function validateSemantics(input: ReturnType<typeof journeyInputSchema.parse>): void {
  const issues: ValidationIssue[] = [];
  const city = (id: string, path: (string | number)[]) => {
    if (!getCityById(id)) issues.push({ path, message: `unknown cityId "${id}"` });
  };

  if (input.startDate > input.endDate) issues.push({ path: ["endDate"], message: "endDate is before startDate" });

  input.stops.forEach((s, i) => {
    city(s.cityId, ["stops", i, "cityId"]);
    if (s.arrive > s.depart) issues.push({ path: ["stops", i, "depart"], message: "depart is before arrive" });
    if (s.arrive < input.startDate || s.depart > input.endDate) {
      issues.push({ path: ["stops", i], message: "stop falls outside the journey's startDate..endDate" });
    }
    const prev = input.stops[i - 1];
    if (prev && s.arrive < prev.depart) {
      issues.push({ path: ["stops", i, "arrive"], message: "stops must be in order: arrive is before the previous stop's depart" });
    }
  });
  input.segments.forEach((s, i) => {
    city(s.fromCityId, ["segments", i, "fromCityId"]);
    city(s.toCityId, ["segments", i, "toCityId"]);
    if (s.arriveAt && arrivesBeforeDeparture(s.departAt, s.arriveAt)) {
      issues.push({ path: ["segments", i, "arriveAt"], message: "arriveAt is before departAt" });
    }
  });
  input.experiences.forEach((e, i) => city(e.cityId, ["experiences", i, "cityId"]));

  if (issues.length) throw new JournalValidationError(issues);
}

/** Epoch ms for a datetime carrying a UTC offset (Z, ±HH:MM, ±HHMM); undefined otherwise. */
function instant(v: string): number | undefined {
  return /T.*(Z|[+-]\d{2}:?\d{2})$/.test(v) ? Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : undefined;
}

/**
 * With offsets on both sides compare instants (an eastbound date-line flight lands on an
 * earlier local date); otherwise only local calendar dates are comparable.
 */
function arrivesBeforeDeparture(departAt: string, arriveAt: string): boolean {
  const a = instant(arriveAt);
  const d = instant(departAt);
  return a !== undefined && d !== undefined ? a < d : arriveAt.slice(0, 10) < departAt.slice(0, 10);
}

async function money(m: MoneyInputBody | undefined, date: string) {
  return m ? normalizeMoney(m, date) : undefined;
}

type Built = Omit<Journey, "id" | "createdAt" | "updatedAt" | "fingerprint">;

/** Parse (throws ZodError), validate (throws JournalValidationError), normalize Money (may throw FxUnavailableError). */
async function build(raw: JourneyInputRaw): Promise<Built> {
  const input = journeyInputSchema.parse(raw);
  validateSemantics(input);

  const stops: Stop[] = await Promise.all(
    input.stops.map(async ({ lodging, ...s }) => {
      const stop: Stop = { ...s };
      if (lodging) {
        const { cost, ...rest } = lodging;
        const l: Lodging = { ...rest };
        const c = await money(cost, s.arrive);
        if (c) l.cost = c;
        stop.lodging = l;
      }
      return stop;
    }),
  );
  const segments: Segment[] = await Promise.all(
    input.segments.map(async ({ cost, ...s }) => {
      const seg: Segment = { ...s };
      const c = await money(cost, s.departAt);
      if (c) seg.cost = c;
      return seg;
    }),
  );
  const experiences: Experience[] = await Promise.all(
    input.experiences.map(async ({ cost, ...e }) => {
      const exp: Experience = { ...e };
      const c = await money(cost, e.date);
      if (c) exp.cost = c;
      return exp;
    }),
  );

  return {
    ...input,
    // D6: anything not hand-entered lands as a draft unless stated otherwise.
    status: input.status ?? (input.provenance.source === "manual" ? "confirmed" : "draft"),
    stops,
    segments,
    experiences,
  };
}

// ── Public API ──────────────────────────────────────────────────────

export interface JourneyFilter {
  /** Journeys overlapping this calendar year. */
  year?: number;
  tag?: string;
}

/** Newest first (by startDate). */
export async function listJourneys(filter: JourneyFilter = {}): Promise<Journey[]> {
  const { journeys } = await journalStore.read();
  return journeys
    .filter((j) => {
      if (filter.year !== undefined) {
        const y = String(filter.year);
        if (j.startDate.slice(0, 4) > y || j.endDate.slice(0, 4) < y) return false;
      }
      if (filter.tag !== undefined && !j.tags.includes(filter.tag)) return false;
      return true;
    })
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export async function getJourney(id: string): Promise<Journey | undefined> {
  return (await journalStore.read()).journeys.find((j) => j.id === id);
}

export async function createJourney(input: JourneyInputRaw): Promise<Journey> {
  const built = await build(input);
  const now = new Date().toISOString();
  const journey: Journey = { ...built, id: randomUUID(), createdAt: now, updatedAt: now };
  await runListeners(journey, undefined);
  await journalStore.update((file) => {
    file.journeys.push(journey);
  });
  return journey;
}

/** Thrown by updateJourney when `ifUpdatedAt` no longer matches the stored journey. */
export class JournalConflictError extends Error {
  constructor() {
    super("journey was modified concurrently");
    this.name = "JournalConflictError";
  }
}

/**
 * Full replacement of the user-owned fields. Returns undefined for an unknown id.
 * With `ifUpdatedAt`, the write is refused (JournalConflictError) unless the stored journey
 * still has that updatedAt — optimistic concurrency for read-modify-write callers.
 */
export async function updateJourney(id: string, input: JourneyInputRaw, opts: { ifUpdatedAt?: string } = {}): Promise<Journey | undefined> {
  const previous = await getJourney(id);
  if (!previous) return undefined;
  const built = await build(input);
  const journey: Journey = {
    ...built,
    id,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
    ...(previous.fingerprint ? { fingerprint: previous.fingerprint } : {}),
  };
  await runListeners(journey, previous);
  return journalStore.update((file) => {
    const i = file.journeys.findIndex((j) => j.id === id);
    if (i < 0) return undefined; // deleted while we were building
    if (opts.ifUpdatedAt !== undefined && file.journeys[i]!.updatedAt !== opts.ifUpdatedAt) throw new JournalConflictError();
    file.journeys[i] = journey;
    return journey;
  });
}

/**
 * Serialized read-modify-write of one stored journey for server-derived fields
 * (e.g. a recomputed fingerprint). No re-validation, no listeners, updatedAt
 * untouched. `fn` returns the replacement, or undefined to leave it as is.
 */
export async function mutateJourney(id: string, fn: (current: Journey) => Journey | undefined): Promise<Journey | undefined> {
  return journalStore.update((file) => {
    const i = file.journeys.findIndex((j) => j.id === id);
    if (i < 0) return undefined;
    const next = fn(file.journeys[i]!);
    if (next) file.journeys[i] = next;
    return file.journeys[i];
  });
}

/** Returns true if a journey was removed. */
export async function deleteJourney(id: string): Promise<boolean> {
  return journalStore.update((file) => {
    const before = file.journeys.length;
    file.journeys = file.journeys.filter((j) => j.id !== id);
    return file.journeys.length < before;
  });
}

export async function getSettings(): Promise<JournalSettings> {
  return settingsStore.read();
}

export async function saveSettings(raw: JournalSettings): Promise<JournalSettings> {
  const settings = journalSettingsSchema.parse(raw);
  if (settings.homeCityId && !getCityById(settings.homeCityId)) {
    throw new JournalValidationError([{ path: ["homeCityId"], message: `unknown cityId "${settings.homeCityId}"` }]);
  }
  await settingsStore.write(settings);
  return settings;
}
