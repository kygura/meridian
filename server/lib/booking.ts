// Booking module — the single public seam for the flight-booking pipeline.
//
// Design (ADR 0001 / spec §4.1): a Booking is a server-side, self-contained
// aggregate. It snapshots everything it needs (leg, passengers, offer terms,
// order reference) and only *references* tripId/legIndex; trips stay in the
// browser. Offers are ephemeral and are NEVER persisted — checkout books from a
// fresh offer in one session, so the client hands the chosen offer back as a
// `searchSnapshot` at create time.
//
// Provider strategy: with DUFFEL_API_KEY set, we go against Duffel in TEST mode
// (source "duffel-test"). Without a key we serve deterministic, clearly-labeled
// mock offers/orders (source "mock") so the whole flow is exercisable locally
// with zero credentials and zero risk of a real charge.

import { readFileSync, writeFileSync } from "fs";
import { ensureDataDir, getDataPath } from "./paths.js";
import {
  hasDuffelKey,
  searchBookingOffers,
  createOrder,
  cancelOrder,
  DuffelOfferExpiredError,
  type DuffelPassengerInput,
} from "./providers/duffel.js";

// ── Public types ────────────────────────────────────────────────────

export type OfferSource = "duffel-test" | "mock";

export interface OfferSegment {
  originIata?: string;
  destinationIata?: string;
  departingAt?: string;
  arrivingAt?: string;
  carrier: string;
  carrierIata?: string;
}

export interface BookingOffer {
  id: string;
  source: OfferSource;
  priceAmount: number;
  currency: string;
  carrier: string;
  carrierIata?: string;
  segments: OfferSegment[];
  durationMinutes?: number;
  stops: number;
  /** ISO 8601; after this the offer can no longer be booked (must re-search). */
  expiresAt: string;
  departingAt?: string;
  arrivingAt?: string;
}

/** Only the passenger fields the booking aggregate needs (spec §4.1). */
export interface Passenger {
  title: string;
  givenName: string;
  familyName: string;
  bornOn: string; // YYYY-MM-DD
  gender: string;
  email: string;
  phoneNumber: string;
}

export interface BookingLeg {
  originIata: string;
  destinationIata: string;
  departureDate: string;
  returnDate?: string;
}

export interface Booking {
  id: string;
  createdAt: string;
  status: "booked" | "cancelled";
  source: OfferSource;
  bookingReference: string;
  tripId?: string;
  legIndex?: number;
  passengers: Passenger[];
  leg: BookingLeg;
  totalAmount: number;
  totalCurrency: string;
  /** Duffel order id, present only for real (duffel-test) bookings. */
  orderId?: string;
  offerSnapshot: {
    carrier: string;
    segments: OfferSegment[];
    duration?: number; // minutes
  };
  cancelledAt?: string;
}

/** The offer the client chose, handed back at create time. Offers aren't
 *  persisted server-side, so the client re-supplies the live offer + its leg. */
export interface SearchSnapshot {
  offer: BookingOffer;
  leg: BookingLeg;
}

export interface SearchParams {
  originIata: string;
  destinationIata: string;
  departureDate: string;
  returnDate?: string;
  passengers: number;
}

export interface CreateBookingParams {
  offerId: string;
  tripId?: string;
  legIndex?: number;
  passengers: Passenger[];
  searchSnapshot: SearchSnapshot;
}

// ── Typed errors ────────────────────────────────────────────────────

/** Offer is expired — the caller must re-search, not retry. Maps to HTTP 409. */
export class OfferExpiredError extends Error {
  constructor(message = "Offer has expired; please re-search") {
    super(message);
    this.name = "OfferExpiredError";
  }
}

/** Bad input the zod layer can't catch on its own (e.g. offerId/snapshot
 *  mismatch, unroutable offer). Maps to HTTP 400. */
export class BookingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingValidationError";
  }
}

// ── Persistence (flat-file JSON, same pattern as shortlist) ──────────

const MOCK_OFFER_PREFIX = "mock_off_";

ensureDataDir();

function bookingsPath(): string {
  return getDataPath("bookings.json");
}

function readBookings(): Booking[] {
  try {
    return JSON.parse(readFileSync(bookingsPath(), "utf-8")) as Booking[];
  } catch {
    return [];
  }
}

function writeBookings(bookings: Booking[]): void {
  writeFileSync(bookingsPath(), JSON.stringify(bookings, null, 2));
}

// ── Deterministic mock generation ───────────────────────────────────

// Same seeded-hash approach as routes/agent.ts, so mock output is stable for a
// given route (same params -> same offers) — important for a testable seam.
function seededRand(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000;
}

const MOCK_CARRIERS: Array<{ name: string; iata: string }> = [
  { name: "Aurora Air", iata: "AU" },
  { name: "Meridian Airways", iata: "Mv" },
  { name: "Northwind", iata: "NW" },
  { name: "Solstice", iata: "SO" },
  { name: "Cardinal Jet", iata: "CJ" },
];

function routeKey(p: SearchParams): string {
  return `${p.originIata}-${p.destinationIata}-${p.departureDate}-${p.returnDate ?? ""}-${p.passengers}`;
}

function mockOffers(p: SearchParams): BookingOffer[] {
  const base = routeKey(p);
  const count = 3 + Math.floor(seededRand(base + ":count") * 3); // 3–5 offers
  const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString(); // ~20 min out

  return Array.from({ length: count }, (_, i): BookingOffer => {
    const s = (field: string) => seededRand(`${base}:${i}:${field}`);
    const carrier = MOCK_CARRIERS[Math.floor(s("carrier") * MOCK_CARRIERS.length)]!;
    // Realistic-ish economy fare: 80–1080 USD, rounded to nearest 5.
    const priceAmount = Math.round((80 + s("price") * 1000) / 5) * 5;
    const durationMinutes = 90 + Math.floor(s("dur") * 690); // 1.5h–13h
    const stops = s("stops") < 0.55 ? 0 : s("stops") < 0.9 ? 1 : 2;

    const outbound: OfferSegment = {
      originIata: p.originIata,
      destinationIata: p.destinationIata,
      departingAt: `${p.departureDate}T${String(6 + Math.floor(s("dep") * 14)).padStart(2, "0")}:00:00Z`,
      carrier: carrier.name,
      carrierIata: carrier.iata,
    };
    const segments: OfferSegment[] = [outbound];
    if (p.returnDate) {
      segments.push({
        originIata: p.destinationIata,
        destinationIata: p.originIata,
        departingAt: `${p.returnDate}T${String(6 + Math.floor(s("ret") * 14)).padStart(2, "0")}:00:00Z`,
        carrier: carrier.name,
        carrierIata: carrier.iata,
      });
    }

    return {
      id: `${MOCK_OFFER_PREFIX}${seededRandHex(`${base}:${i}`)}`,
      source: "mock",
      priceAmount,
      currency: "USD",
      carrier: carrier.name,
      carrierIata: carrier.iata,
      segments,
      durationMinutes,
      stops,
      expiresAt,
      departingAt: outbound.departingAt,
    };
  }).sort((a, b) => a.priceAmount - b.priceAmount);
}

function seededRandHex(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Deterministic 6-char PNR-style reference for a mock order. */
function mockBookingReference(offerId: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let out = "";
  for (let i = 0; i < 6; i++) {
    const r = seededRand(`${offerId}:ref:${i}`);
    out += alphabet[Math.floor(r * alphabet.length)];
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────

export async function searchOffers(
  params: SearchParams,
): Promise<{ offers: BookingOffer[]; source: OfferSource }> {
  if (hasDuffelKey()) {
    const raw = await searchBookingOffers({
      origin: params.originIata,
      destination: params.destinationIata,
      departureDate: params.departureDate,
      returnDate: params.returnDate,
      passengers: params.passengers,
    });
    const offers: BookingOffer[] = raw.map((o) => ({ ...o, source: "duffel-test" as const }));
    return { offers, source: "duffel-test" };
  }
  return { offers: mockOffers(params), source: "mock" };
}

export async function createBooking(params: CreateBookingParams): Promise<Booking> {
  const { offerId, searchSnapshot, passengers, tripId, legIndex } = params;
  const offer = searchSnapshot.offer;

  // The offerId being booked must be the offer captured in the snapshot.
  if (offer.id !== offerId) {
    throw new BookingValidationError("offerId does not match the supplied searchSnapshot offer");
  }
  if (passengers.length === 0) {
    throw new BookingValidationError("at least one passenger is required");
  }

  // Proactive expiry guard for both paths (Duffel best practice; also the only
  // expiry check the mock path has).
  if (offer.expiresAt && new Date(offer.expiresAt).getTime() <= Date.now()) {
    throw new OfferExpiredError();
  }

  const leg = searchSnapshot.leg;
  const isMock = offerId.startsWith(MOCK_OFFER_PREFIX);

  let source: OfferSource;
  let bookingReference: string;
  let orderId: string | undefined;
  let totalAmount: number;
  let totalCurrency: string;

  if (hasDuffelKey() && !isMock) {
    // Real Duffel (test-mode) order. NOTE: only runtime-verifiable with a
    // DUFFEL_API_KEY present; code-complete per docs/research-apis.md otherwise.
    try {
      const duffelPassengers: DuffelPassengerInput[] = passengers.map((p) => ({ ...p }));
      const order = await createOrder({
        offerId,
        passengers: duffelPassengers,
        amount: String(offer.priceAmount),
        currency: offer.currency,
      });
      source = "duffel-test";
      bookingReference = order.bookingReference;
      orderId = order.id;
      totalAmount = Number(order.totalAmount);
      totalCurrency = order.totalCurrency;
    } catch (err) {
      if (err instanceof DuffelOfferExpiredError) throw new OfferExpiredError();
      throw err;
    }
  } else if (isMock) {
    // Deterministic mock order — no provider call, no money, clearly labeled.
    source = "mock";
    bookingReference = mockBookingReference(offerId);
    totalAmount = offer.priceAmount;
    totalCurrency = offer.currency;
  } else {
    // A non-mock offer id but no Duffel key: nothing can book it.
    throw new BookingValidationError(
      "cannot book this offer: no Duffel key configured and offer id is not a mock offer",
    );
  }

  const booking: Booking = {
    id: `bkg_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    status: "booked",
    source,
    bookingReference,
    tripId,
    legIndex,
    passengers,
    leg,
    totalAmount,
    totalCurrency,
    orderId,
    offerSnapshot: {
      carrier: offer.carrier,
      segments: offer.segments,
      duration: offer.durationMinutes,
    },
  };

  const all = readBookings();
  all.push(booking);
  writeBookings(all);
  return booking;
}

export function listBookings(): Booking[] {
  return readBookings();
}

export function getBooking(id: string): Booking | undefined {
  return readBookings().find((b) => b.id === id);
}

export async function cancelBooking(id: string): Promise<Booking | null> {
  const all = readBookings();
  const idx = all.findIndex((b) => b.id === id);
  if (idx === -1) return null;

  const booking = all[idx]!;
  // Idempotent: cancelling an already-cancelled booking is a no-op success.
  if (booking.status === "cancelled") return booking;

  // Real orders: attempt provider cancellation (best-effort). If Duffel refuses,
  // surface the error rather than lying about the state.
  if (booking.source === "duffel-test" && booking.orderId && hasDuffelKey()) {
    await cancelOrder(booking.orderId);
  }

  booking.status = "cancelled";
  booking.cancelledAt = new Date().toISOString();
  all[idx] = booking;
  writeBookings(all);
  return booking;
}
