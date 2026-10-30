// Import review queue (spec-journal §7, D6, R4): data/imports.json → { version: 1, candidates }.
//
// Everything ingestion produces lands here as a `pending` ImportCandidate and only
// becomes a Journey through an explicit review action (accept / merge / cluster
// accept). Accepting from the queue IS the user's confirmation (D6), so created
// journeys are "confirmed". Journeys are always built through journal.ts, so its
// validation (ordering, date range, known cityIds, Money normalization) applies.
//
// State changes are claim-then-act: the candidates are flipped out of `pending` in
// one serialized store.update (409 if any was already reviewed), the journey is
// written, and the claim is released again if that write fails.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type {
  City,
  Confidence,
  Experience,
  ImportCandidate,
  ImportCluster,
  ImportQueue,
  ImportReport,
  ImportState,
  Journey,
  Provenance,
  ProvenanceSource,
  Segment,
  Stop,
} from "../../src/types.js";
import { listBookings, type Booking } from "./booking.js";
import { haversineKm } from "../../src/lib/geo.js";
import { getCities, getCityById } from "./cities.js";
import { JournalConflictError, createJourney, getJourney, getSettings, updateJourney } from "./journal.js";
import {
  experienceSchema,
  isoDateOrDateTimeSchema,
  isoDateSchema,
  lodgingSchema,
  provenanceSchema,
  segmentSchema,
  stopSchema,
  type JourneyInputRaw,
} from "./journalSchemas.js";
import { createJsonStore } from "./jsonStore.js";

export const MAX_BATCH = 500;
const CLUSTER_GAP_DAYS = 2;
/** A trip that left home stays one cluster across quiet stretches up to this long, until it returns. */
const AWAY_GAP_DAYS = 60;

interface ImportsFile {
  version: 1;
  candidates: ImportCandidate[];
}

const store = createJsonStore<ImportsFile>("imports.json", () => ({ version: 1, candidates: [] }));

/** Expected failure with an HTTP status and JSON body for the route layer. */
export class ImportError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 413,
    public readonly body: { error: string; [k: string]: unknown },
  ) {
    super(body.error);
    this.name = "ImportError";
  }
}

// ── Input schema (trust boundary) ───────────────────────────────────

const text = (max: number) => z.string().trim().min(1).max(max);
const hints = {
  cityHint: text(200).optional(),
  iataHint: text(10).optional(),
  toCityHint: text(200).optional(),
  toIataHint: text(10).optional(),
};
const orderedDates = (p: { arrive?: string; depart?: string }) => !p.depart || !p.arrive || p.depart >= p.arrive;
const orderedMsg = { message: "depart is before arrive", path: ["depart"] };

// Payloads reuse the journal pieces made partial (candidates are often incomplete);
// only what clustering/dedupe/review cannot work without is required again.
const lodgingPayload = lodgingSchema.omit({ provenance: true });
const payloadSchemas = {
  segment: segmentSchema.omit({ provenance: true }).partial().extend({ departAt: isoDateOrDateTimeSchema, ...hints }),
  stop: stopSchema.omit({ lodging: true }).partial().extend({ arrive: isoDateSchema, lodging: lodgingPayload.optional(), ...hints }).refine(orderedDates, orderedMsg),
  lodging: lodgingPayload
    .partial()
    .extend({ name: text(300), cityId: text(200).optional(), arrive: isoDateSchema, depart: isoDateSchema.optional(), ...hints })
    .refine(orderedDates, orderedMsg),
  experience: experienceSchema.omit({ provenance: true }).partial().extend({ date: isoDateSchema, title: text(300), ...hints }),
};

const importProvenanceSchema = provenanceSchema.extend({ sourceRef: z.string().min(1).max(500) });
const candidateBase = { id: text(600).optional(), provenance: importProvenanceSchema };

/** Server-owned fields (state, createdAt, clusterId, flags) are stripped, not trusted. */
export const importCandidateInputSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...candidateBase, kind: z.literal("segment"), payload: payloadSchemas.segment }),
    z.object({ ...candidateBase, kind: z.literal("stop"), payload: payloadSchemas.stop }),
    z.object({ ...candidateBase, kind: z.literal("lodging"), payload: payloadSchemas.lodging }),
    z.object({ ...candidateBase, kind: z.literal("experience"), payload: payloadSchemas.experience }),
  ])
  // "booking" candidates are minted by the server from real bookings (R4); an external POST
  // must not impersonate one or squat on their ids.
  .superRefine((c, ctx) => {
    if (c.provenance.source === "booking") ctx.addIssue({ code: "custom", path: ["provenance", "source"], message: 'source "booking" is reserved for server-promoted bookings' });
    if (c.id?.startsWith("booking:")) ctx.addIssue({ code: "custom", path: ["id"], message: 'ids starting with "booking:" are reserved' });
  });

// ── City resolution ─────────────────────────────────────────────────

const fold1 = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

let nameIndex: { src: unknown; map: Map<string, City[]> } | undefined;
function citiesNamed(name: string): City[] {
  const all = getCities();
  if (nameIndex?.src !== all) {
    const map = new Map<string, City[]>();
    for (const c of all) {
      const k = fold1(c.name);
      map.set(k, [...(map.get(k) ?? []), c]);
    }
    nameIndex = { src: all, map };
  }
  return nameIndex.map.get(fold1(name)) ?? [];
}

/** A city must dominate same-named rivals by this population factor to be picked without a country hint. */
const DOMINANCE = 3;

/**
 * Exact (accent/case-insensitive) name only; "Name, Country" narrows by country. A hint that
 * matches nothing, or stays ambiguous between similarly sized cities, is unresolved —
 * guessing a fuzzy match would silently misplace the candidate.
 */
function byName(hint: string): City | undefined {
  const [name, ...rest] = hint.split(",").map((s) => s.trim()).filter(Boolean);
  if (!name) return undefined;
  let pool = citiesNamed(name);
  const country = rest.at(-1) && fold1(rest.at(-1)!);
  if (country) pool = pool.filter((c) => fold1(c.country).includes(country));
  pool = [...pool].sort((a, b) => b.population - a.population);
  if (pool.length > 1 && pool[0].population < DOMINANCE * pool[1].population) return undefined;
  return pool[0];
}

let airportIndex: Map<string, { lat: number; lng: number }> | undefined;
function airport(code: string) {
  if (!airportIndex) {
    airportIndex = new Map();
    try {
      const list = JSON.parse(readFileSync(join(process.cwd(), "data/airports.json"), "utf-8")) as { iata: string; lat: number; lng: number }[];
      for (const a of list) airportIndex.set(a.iata, a);
    } catch {
      /* no airport data: fall back to cities sharing the code */
    }
  }
  return airportIndex.get(code);
}

const AIRPORT_RADIUS_KM = 60;
const iataCache = new Map<string, string | undefined>();
let iataCacheSrc: unknown;

/**
 * cities.ts gives every city its nearest airport, so many cities share one code. Pick the most
 * populous city within 60 km of the airport (CDG → Paris, not a placeholder); a small
 * airport falls back to the biggest city that carries the code.
 */
function cityForIata(code: string): string | undefined {
  const all = getCities();
  if (iataCacheSrc !== all) {
    iataCache.clear();
    iataCacheSrc = all;
  }
  if (iataCache.has(code)) return iataCache.get(code);
  const biggest = (xs: City[]) => xs.reduce<City | undefined>((m, c) => (!m || c.population > m.population ? c : m), undefined);
  const sharing = biggest(all.filter((c) => c.iata === code));
  const ap = airport(code);
  const near = ap ? biggest(all.filter((c) => haversineKm([ap.lng, ap.lat], [c.lng, c.lat]) <= AIRPORT_RADIUS_KM)) : undefined;
  const best = near && near.population >= (sharing?.population ?? 0) ? near : sharing;
  iataCache.set(code, best?.id);
  return best?.id;
}

/** cityId if valid → city with that IATA → exact name. */
function resolveCity(id?: string, iata?: string, name?: string): string | undefined {
  if (id && getCityById(id)) return id;
  if (iata) {
    const hit = cityForIata(iata.trim().toUpperCase());
    if (hit) return hit;
  }
  return name ? byName(name)?.id : undefined;
}

type Payload = ImportCandidate["payload"];

/** Fills resolved city ids into `payload`; true when every required city resolved. */
function resolveCities(kind: ImportCandidate["kind"], p: Payload): boolean {
  if (kind === "segment") {
    const from = resolveCity(p.fromCityId, p.iataHint, p.cityHint);
    const to = resolveCity(p.toCityId, p.toIataHint, p.toCityHint);
    if (from) p.fromCityId = from;
    if (to) p.toCityId = to;
    return !!from && !!to;
  }
  const city = resolveCity(p.cityId, p.iataHint, p.cityHint);
  if (city) p.cityId = city;
  return !!city;
}

function hasResolvedCities(c: ImportCandidate): boolean {
  const p = c.payload;
  const ok = (id?: string) => !!id && !!getCityById(id);
  return c.kind === "segment" ? ok(p.fromCityId) && ok(p.toCityId) : ok(p.cityId);
}

function makeCandidate(
  id: string,
  kind: ImportCandidate["kind"],
  payload: Payload,
  provenance: Provenance,
  now: Date,
  extraFlags: string[] = [],
): ImportCandidate {
  const resolved = resolveCities(kind, payload);
  const flags = [...(resolved ? [] : ["unresolved-city"]), ...extraFlags];
  return {
    id,
    kind,
    payload,
    provenance: flags.length ? { ...provenance, confidence: "low" } : provenance,
    ...(flags.length ? { flags } : {}),
    state: "pending",
    createdAt: now.toISOString(),
  };
}

// ── Dedupe keys ─────────────────────────────────────────────────────

const refKey = (c: Pick<ImportCandidate, "provenance">) => `${c.provenance.source}\u0000${c.provenance.sourceRef}`;

/** Flight number without airline designator or leading zeros: "TP1023", "TP 01023" and "1023" agree. */
function flightDigits(number: string): string {
  const n = number.toUpperCase().replace(/\s+/g, "");
  const m = n.match(/^(?:[A-Z][A-Z0-9]|[0-9][A-Z])(\d{1,5}[A-Z]?)$/);
  return (m?.[1] ?? n).replace(/^0+(?=\d)/, "");
}

/**
 * Same flight, however it was reported: (flight number, route, departure day), and
 * (booking reference, route, departure day) — the latter links an e-mail confirmation to the
 * Meridian booking it confirms, which carries no flight number.
 */
function segmentKeys(c: Pick<ImportCandidate, "kind" | "payload">): string[] {
  const p = c.payload;
  if (c.kind !== "segment" || !p.departAt) return [];
  const route = `${p.fromCityId ?? p.iataHint ?? p.cityHint}>${p.toCityId ?? p.toIataHint ?? p.toCityHint}@${p.departAt.slice(0, 10)}`.toUpperCase();
  return [
    ...(p.number ? [`no:${flightDigits(p.number)}|${route}`] : []),
    ...(p.bookingRef ? [`ref:${p.bookingRef.toUpperCase().replace(/\s+/g, "")}|${route}`] : []),
  ];
}

// ── Add ─────────────────────────────────────────────────────────────

export async function addCandidates(raw: unknown[], now: Date = new Date()): Promise<ImportReport> {
  if (raw.length > MAX_BATCH) throw new ImportError(413, { error: "too_many", max: MAX_BATCH });
  const errors: string[] = [];
  let added = 0;
  let duplicates = 0;

  await store.update((file) => {
    const ids = new Set(file.candidates.map((c) => c.id));
    const refs = new Set(file.candidates.map(refKey));
    const segs = new Set(file.candidates.flatMap(segmentKeys));

    raw.forEach((item, i) => {
      const parsed = importCandidateInputSchema.safeParse(item);
      if (!parsed.success) {
        const msg = parsed.error.issues.slice(0, 3).map((x) => `${x.path.join(".") || "(item)"}: ${x.message}`);
        errors.push(`#${i}: ${msg.join("; ")}`);
        return;
      }
      const { kind, payload, provenance, id: given } = parsed.data;
      const id = given ?? `${provenance.source}:${provenance.sourceRef}`;
      const cand = makeCandidate(id, kind, payload as Payload, provenance, now);
      const keys = segmentKeys(cand);
      if (ids.has(id) || refs.has(refKey(cand)) || keys.some((k) => segs.has(k))) {
        duplicates++;
        return;
      }
      ids.add(id);
      refs.add(refKey(cand));
      for (const k of keys) segs.add(k);
      file.candidates.push(cand);
      added++;
    });
  });

  return { received: raw.length, added, duplicates, ...(errors.length ? { errors } : {}) };
}

// ── Booking promotion (R4) ──────────────────────────────────────────

interface Leg {
  from: string;
  to: string;
  departAt: string;
  arriveAt?: string;
  carrier?: string;
}

function bookingLegs(b: Booking): Leg[] {
  const snap = b.offerSnapshot.segments;
  if (snap.length && snap.every((s) => s.originIata && s.destinationIata)) {
    return snap.map((s, i) => ({
      from: s.originIata!,
      to: s.destinationIata!,
      departAt: s.departingAt ?? (i === 0 ? b.leg.departureDate : (b.leg.returnDate ?? b.leg.departureDate)),
      ...(s.arrivingAt ? { arriveAt: s.arrivingAt } : {}),
      carrier: s.carrier,
    }));
  }
  const { originIata, destinationIata, departureDate, returnDate } = b.leg;
  return [
    { from: originIata, to: destinationIata, departAt: departureDate, carrier: b.offerSnapshot.carrier },
    ...(returnDate ? [{ from: destinationIata, to: originIata, departAt: returnDate, carrier: b.offerSnapshot.carrier }] : []),
  ];
}

/**
 * Adds one segment candidate per leg of every past `booked` booking not yet seen (any state).
 * POST /api/bookings is ungated, so bookings are untrusted input: every leg goes through the
 * same payload schema as an external candidate (an invalid booking is skipped whole), mock
 * bookings are flagged low confidence, and legs already reported by another source are skipped.
 */
function promoteBookings(file: ImportsFile, now: Date): void {
  const today = now.toISOString().slice(0, 10);
  const seen = new Set(file.candidates.filter((c) => c.provenance.source === "booking").map((c) => c.provenance.sourceRef));
  const ids = new Set(file.candidates.map((c) => c.id));
  const keys = new Set(file.candidates.flatMap(segmentKeys));
  for (const b of listBookings()) {
    if (b.status !== "booked" || seen.has(b.id)) continue;
    const legs = bookingLegs(b).sort((x, y) => x.departAt.localeCompare(y.departAt));
    if (!legs.length || legs[0].departAt.slice(0, 10) >= today) continue;
    const payloads = legs.map((leg, k) =>
      payloadSchemas.segment.safeParse({
        mode: "flight",
        iataHint: leg.from,
        toIataHint: leg.to,
        departAt: leg.departAt,
        ...(leg.arriveAt ? { arriveAt: leg.arriveAt } : {}),
        ...(leg.carrier ? { carrier: leg.carrier } : {}),
        bookingId: b.id,
        bookingRef: b.bookingReference,
        // Whole fare on the first leg; the booking has no per-leg price.
        ...(k === 0 ? { cost: { amount: b.totalAmount, currency: b.totalCurrency } } : {}),
      }),
    );
    if (payloads.some((r) => !r.success)) continue;
    const prov: Provenance = { source: "booking", sourceRef: b.id, confidence: "high", importedAt: now.toISOString() };
    payloads.forEach((r, k) => {
      const id = k === 0 ? `booking:${b.id}` : `booking:${b.id}:${k}`;
      const cand = makeCandidate(id, "segment", r.data as Payload, prov, now, b.source === "mock" ? ["mock-booking"] : []);
      const legKeys = segmentKeys(cand);
      if (ids.has(id) || legKeys.some((x) => keys.has(x))) return;
      ids.add(id);
      for (const x of legKeys) keys.add(x);
      file.candidates.push(cand);
    });
  }
}

// ── Clustering (pure) ───────────────────────────────────────────────

interface Item {
  c: ImportCandidate;
  start: string;
  end: string;
  /** Same-day sort order: leave home, everything else, return home. */
  rank: number;
  departsHome: boolean;
  arrivesHome: boolean;
}

const day = (s: string | undefined) => s?.slice(0, 10);
const dayDiff = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

function span(c: ImportCandidate): { start: string; end: string } {
  const p = c.payload;
  const start = day(c.kind === "segment" ? p.departAt : c.kind === "experience" ? p.date : p.arrive) ?? c.createdAt.slice(0, 10);
  const end = day(c.kind === "segment" ? p.arriveAt : c.kind === "experience" ? p.date : p.depart) ?? start;
  return { start, end: end < start ? start : end };
}

function toItems(cands: ImportCandidate[], home?: string): Item[] {
  const items = cands.map((c) => {
    const departsHome = !!home && c.kind === "segment" && c.payload.fromCityId === home;
    const arrivesHome = !!home && c.kind === "segment" && c.payload.toCityId === home;
    return { c, ...span(c), rank: departsHome ? 0 : arrivesHome ? 2 : 1, departsHome, arrivesHome };
  });
  // Home return at 08:00 and a new departure at 18:00 on the same day: the return closes the old trip.
  const timeOf = (i: Item) => (i.c.payload.departAt?.length ?? 0) > 10 ? i.c.payload.departAt!.slice(11, 16) : undefined;
  for (const back of items) {
    const t = back.arrivesHome && !back.departsHome ? timeOf(back) : undefined;
    if (t && items.some((o) => o.departsHome && o.start === back.start && (timeOf(o) ?? "") > t)) back.rank = -1;
  }
  return items.sort((a, b) => a.start.localeCompare(b.start) || a.rank - b.rank || a.end.localeCompare(b.end) || a.c.id.localeCompare(b.c.id));
}

/** Explicit home, else the origin of the first segment when the last segment returns there. */
function effectiveHome(segs: { fromCityId?: string; toCityId?: string }[], home?: string): string | undefined {
  if (home) return home;
  const first = segs[0]?.fromCityId;
  return first && segs.at(-1)?.toCityId === first ? first : undefined;
}

function awayCities(items: Item[], home?: string): string[] {
  const h = effectiveHome(items.filter((i) => i.c.kind === "segment").map((i) => i.c.payload), home);
  const ids = items.map((i) => (i.c.kind === "segment" ? i.c.payload.toCityId : i.c.payload.cityId));
  return [...new Set(ids.filter((id): id is string => !!id && id !== h))];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function clusterTitle(cityIds: string[], start: string): string {
  const names = cityIds.map((id) => getCityById(id)?.name ?? id);
  const when = `${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;
  const where =
    names.length === 0 ? "Trip" : names.length === 1 ? names[0] : names.length <= 3 ? `${names.slice(0, -1).join(", ")} & ${names.at(-1)}` : `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
  return `${where}, ${when}`;
}

/**
 * Groups pending candidates into suggested journeys: a new cluster starts when the gap to
 * everything so far exceeds 2 days; a segment arriving at home closes a cluster and one
 * departing home opens one. Ids are stable (hash of the sorted member ids).
 */
export function clusterCandidates(pending: ImportCandidate[], homeCityId?: string): ImportCluster[] {
  const groups: Item[][] = [];
  let cur: Item[] = [];
  let curEnd = "";
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
    curEnd = "";
  };
  for (const it of toItems(pending, homeCityId)) {
    if (cur.length) {
      const gap = dayDiff(curEnd, it.start);
      const bookingId = it.c.payload.bookingId;
      // One booking is one trip; a trip that left home stays open until it returns.
      const together = (!!bookingId && cur.some((i) => i.c.payload.bookingId === bookingId)) || (cur[0].departsHome && gap <= AWAY_GAP_DAYS);
      if (it.departsHome || (gap > CLUSTER_GAP_DAYS && !together)) flush();
    }
    cur.push(it);
    if (it.end > curEnd) curEnd = it.end;
    if (it.arrivesHome) flush();
  }
  flush();

  return groups.map((g) => {
    const candidateIds = g.map((i) => i.c.id);
    const startDate = g.reduce((m, i) => (i.start < m ? i.start : m), g[0].start);
    const endDate = g.reduce((m, i) => (i.end > m ? i.end : m), g[0].end);
    const cityIds = awayCities(g, homeCityId);
    return {
      id: "cl_" + createHash("sha1").update([...candidateIds].sort().join("\n")).digest("hex").slice(0, 12),
      title: clusterTitle(cityIds, startDate),
      startDate,
      endDate,
      candidateIds,
      cityIds,
      lowConfidence: g.some((i) => i.c.provenance.confidence === "low"),
    };
  });
}

// ── Queue ───────────────────────────────────────────────────────────

/** Promotes past bookings (R4), then returns pending candidates (with clusterId) and clusters. */
export async function getQueue(now: Date = new Date()): Promise<ImportQueue> {
  await store.update((file) => promoteBookings(file, now));
  const { candidates } = await store.read();
  const pending = candidates.filter((c) => c.state === "pending");
  const clusters = clusterCandidates(pending, (await getSettings()).homeCityId);
  const clusterOf = new Map(clusters.flatMap((cl) => cl.candidateIds.map((id) => [id, cl.id] as const)));
  const order = new Map(clusters.flatMap((cl) => cl.candidateIds).map((id, i) => [id, i] as const));
  return {
    candidates: pending
      .map((c) => ({ ...c, clusterId: clusterOf.get(c.id) }))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
    clusters,
  };
}

// ── State changes ───────────────────────────────────────────────────

/** Atomically moves candidates out of `pending`. 404 unknown, 409 already reviewed or (optionally) unresolved. */
async function claim(ids: string[], to: ImportState, requireResolved: boolean): Promise<ImportCandidate[]> {
  return store.update((file) => {
    const found = ids.map((id) => file.candidates.find((c) => c.id === id));
    if (found.some((c) => !c)) throw new ImportError(404, { error: "not_found", message: "Import candidate not found" });
    const cands = found as ImportCandidate[];
    const reviewed = cands.filter((c) => c.state !== "pending");
    if (reviewed.length) throw new ImportError(409, { error: "not_pending", candidateIds: reviewed.map((c) => c.id) });
    const unresolved = cands.filter((c) => !hasResolvedCities(c));
    if (requireResolved && unresolved.length) throw new ImportError(409, { error: "unresolved", candidateIds: unresolved.map((c) => c.id) });
    for (const c of cands) c.state = to;
    return cands.map((c) => ({ ...c }));
  });
}

async function release(ids: string[], from: ImportState): Promise<void> {
  await store.update((file) => {
    for (const c of file.candidates) if (ids.includes(c.id) && c.state === from) c.state = "pending";
  });
}

/** claim → write → release on failure. */
async function reviewed<T>(ids: string[], to: ImportState, act: (members: ImportCandidate[]) => Promise<T>): Promise<T> {
  const members = await claim(ids, to, true);
  try {
    return await act(members);
  } catch (err) {
    await release(ids, to);
    throw err;
  }
}

export async function discard(id: string): Promise<ImportCandidate> {
  return (await claim([id], "discarded", false))[0];
}

// ── Journey assembly ────────────────────────────────────────────────

type RawStop = JourneyInputRaw["stops"][number];
type RawSegment = NonNullable<JourneyInputRaw["segments"]>[number];
type RawExperience = NonNullable<JourneyInputRaw["experiences"]>[number];

interface Parts {
  stops: RawStop[];
  segments: RawSegment[];
  experiences: RawExperience[];
}

const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const provOf = (c: ImportCandidate): Provenance => ({ ...c.provenance, importedAt: c.createdAt });

function toSegment(c: ImportCandidate): RawSegment {
  const p = c.payload;
  return compact({
    mode: p.mode ?? "other",
    fromCityId: p.fromCityId!,
    toCityId: p.toCityId!,
    departAt: p.departAt!,
    arriveAt: p.arriveAt,
    carrier: p.carrier,
    number: p.number,
    cost: p.cost,
    bookingRef: p.bookingRef,
    bookingId: p.bookingId,
    provenance: provOf(c),
  });
}

/** Adds members to `parts`: stops from stop candidates, lodging onto the stop that covers it, else a new stop. */
function fold(parts: Parts, members: ImportCandidate[]): void {
  for (const c of members) {
    const p = c.payload;
    if (c.kind === "segment") parts.segments.push(toSegment(c));
    else if (c.kind === "experience") {
      parts.experiences.push(
        compact({ cityId: p.cityId!, date: p.date!, title: p.title!, kind: p.kind, cost: p.cost, rating: p.rating, lat: p.lat, lng: p.lng, provenance: provOf(c) }),
      );
    } else if (c.kind === "stop") {
      const lodging = p.lodging && compact({ ...p.lodging, provenance: provOf(c) });
      parts.stops.push(compact({ cityId: p.cityId!, arrive: p.arrive!, depart: p.depart ?? p.arrive!, lodging, rating: p.rating, crowdOverride: p.crowdOverride }));
    }
  }
  for (const c of members.filter((m) => m.kind === "lodging")) {
    const p = c.payload;
    const lodging = compact({ name: p.name!, kind: p.kind, cost: p.cost, provenance: provOf(c) });
    const host = parts.stops.find((s) => s.cityId === p.cityId && s.arrive <= p.arrive! && p.arrive! <= s.depart && !s.lodging);
    if (host) host.lodging = lodging;
    else parts.stops.push({ cityId: p.cityId!, arrive: p.arrive!, depart: p.depart ?? p.arrive!, lodging });
  }
}

/**
 * Stops implied by the segments (arrival cities, excluding home); only when there are none at all
 * and `parts` has no stops either, fall back to experiences, then to origins.
 */
function deriveStops(parts: Parts, home?: string): RawStop[] {
  const segs = [...parts.segments].sort((a, b) => a.departAt.localeCompare(b.departAt));
  const h = effectiveHome(segs, home);
  const stops: RawStop[] = [];
  segs.forEach((s, i) => {
    if (s.toCityId === h) return;
    const arrive = (s.arriveAt ?? s.departAt).slice(0, 10);
    const next = segs[i + 1];
    const nextDay = next && next.fromCityId === s.toCityId ? next.departAt.slice(0, 10) : arrive;
    stops.push({ cityId: s.toCityId, arrive, depart: nextDay < arrive ? arrive : nextDay });
  });
  if (stops.length || parts.stops.length) return stops;
  if (parts.experiences.length) {
    for (const e of [...parts.experiences].sort((a, b) => a.date.localeCompare(b.date))) {
      const last = stops.at(-1);
      if (last && last.cityId === e.cityId) last.depart = e.date;
      else stops.push({ cityId: e.cityId, arrive: e.date, depart: e.date });
    }
  }
  if (!stops.length) {
    for (const s of segs) {
      const from = s.fromCityId;
      if (from !== h) stops.push({ cityId: from, arrive: s.departAt.slice(0, 10), depart: s.departAt.slice(0, 10) });
    }
  }
  return stops;
}

function dateRange(parts: Parts): [string, string] {
  const ds = [
    ...parts.stops.flatMap((s) => [s.arrive, s.depart]),
    ...parts.segments.flatMap((s) => [s.departAt.slice(0, 10), s.arriveAt?.slice(0, 10)]),
    ...parts.experiences.map((e) => e.date),
  ].filter((d): d is string => !!d);
  return [ds.reduce((a, b) => (b < a ? b : a)), ds.reduce((a, b) => (b > a ? b : a))];
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function journeyProvenance(members: ImportCandidate[], now: Date): Provenance {
  const counts = new Map<ProvenanceSource, number>();
  for (const m of members) counts.set(m.provenance.source, (counts.get(m.provenance.source) ?? 0) + 1);
  const source = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const confidence = members.reduce<Confidence>((low, m) => (RANK[m.provenance.confidence] < RANK[low] ? m.provenance.confidence : low), "high");
  return { source, confidence, importedAt: now.toISOString() };
}

async function createFrom(members: ImportCandidate[], now: Date): Promise<Journey> {
  const home = (await getSettings()).homeCityId;
  const parts: Parts = { stops: [], segments: [], experiences: [] };
  fold(parts, members);
  // Cities reached only by a segment still get a stop, unless an explicit stop/lodging already covers them.
  for (const d of deriveStops(parts, home)) {
    const covered = parts.stops.some((s) => (s.arrive < d.depart && d.arrive < s.depart) || (s.cityId === d.cityId && s.arrive <= d.depart && d.arrive <= s.depart));
    if (!covered) parts.stops.push(d);
  }
  if (!parts.stops.length) throw new ImportError(409, { error: "no_stops", message: "Could not derive a stop from these candidates", candidateIds: members.map((m) => m.id) });
  parts.stops.sort((a, b) => a.arrive.localeCompare(b.arrive) || a.depart.localeCompare(b.depart));
  const [startDate, endDate] = dateRange(parts);
  const cityIds = awayCities(toItems(members, home), home);
  return createJourney({
    title: clusterTitle(cityIds, startDate),
    status: "confirmed",
    startDate,
    endDate,
    ...parts,
    bookingIds: [...new Set(parts.segments.map((s) => s.bookingId).filter((b): b is string => !!b))],
    provenance: journeyProvenance(members, now),
  });
}

// ── Public review actions ───────────────────────────────────────────

/** Per-journey queue so concurrent merges apply one after the other instead of overwriting each other. */
const journeyLocks = new Map<string, Promise<unknown>>();
function withJourneyLock<T>(journeyId: string, task: () => Promise<T>): Promise<T> {
  const next = (journeyLocks.get(journeyId) ?? Promise.resolve()).then(task, task);
  const settled = next.catch(() => undefined);
  journeyLocks.set(journeyId, settled);
  void settled.then(() => journeyLocks.get(journeyId) === settled && journeyLocks.delete(journeyId));
  return next;
}

const journeyNotFound = () => new ImportError(404, { error: "journey_not_found", message: "Journey not found" });

/**
 * Appends one candidate into an existing journey, extending its dates as needed. The journey is
 * re-read under the lock after the claim, and the write is refused (409 `journey_changed`) if
 * someone else saved it in between.
 */
export async function merge(id: string, journeyId: string): Promise<Journey> {
  if (!(await getJourney(journeyId))) throw journeyNotFound();
  return reviewed([id], "merged", (members) =>
    withJourneyLock(journeyId, async () => {
      const journey = await getJourney(journeyId);
      if (!journey) throw journeyNotFound();
      const parts: Parts = { stops: [...journey.stops], segments: [...journey.segments], experiences: [...journey.experiences] };
      fold(parts, members);
      parts.stops.sort((a, b) => a.arrive.localeCompare(b.arrive));
      const [lo, hi] = dateRange(parts);
      const { id: _id, createdAt: _c, updatedAt: _u, fingerprint: _f, ...rest } = journey;
      try {
        const updated = await updateJourney(
          journeyId,
          {
            ...rest,
            ...parts,
            bookingIds: [...new Set([...journey.bookingIds, ...parts.segments.map((s) => s.bookingId).filter((b): b is string => !!b)])],
            startDate: lo < journey.startDate ? lo : journey.startDate,
            endDate: hi > journey.endDate ? hi : journey.endDate,
          },
          { ifUpdatedAt: journey.updatedAt },
        );
        if (!updated) throw journeyNotFound();
        return updated;
      } catch (err) {
        if (err instanceof JournalConflictError) throw new ImportError(409, { error: "journey_changed", message: "The journey was modified meanwhile; try again" });
        throw err;
      }
    }),
  );
}

/** Without journeyId: a new confirmed journey from this one candidate. With journeyId: same as merge. */
export async function accept(id: string, journeyId?: string, now: Date = new Date()): Promise<Journey> {
  if (journeyId) return merge(id, journeyId);
  return reviewed([id], "accepted", (members) => createFrom(members, now));
}

/** One confirmed journey from every member of a suggested cluster (409 `unresolved` if any city is unresolved). */
export async function acceptCluster(clusterId: string, now: Date = new Date()): Promise<Journey> {
  const { candidates } = await store.read();
  const home = (await getSettings()).homeCityId;
  const cluster = clusterCandidates(
    candidates.filter((c) => c.state === "pending"),
    home,
  ).find((cl) => cl.id === clusterId);
  if (!cluster) throw new ImportError(404, { error: "cluster_not_found", message: "Cluster not found (the queue may have changed)" });
  return reviewed(cluster.candidateIds, "accepted", (members) => createFrom(members, now));
}
