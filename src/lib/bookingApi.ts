// Booking module — frontend types, fetch helpers, and pure logic shared by the
// booking/* components. Mirrors server shapes verbatim (server/lib/booking.ts,
// server/routes/bookings.ts) since offers/bookings are NOT in src/types.ts —
// they never touch the trips domain that file owns.
//
// Offers are ephemeral (spec A2): nothing here persists an Offer to storage.
// Bookings are server-persisted; the Zustand cache (store.ts) is fed by the
// list/create/cancel helpers below.

import { apiCredentials, apiUrl } from "./api";
import { isSignedIn, noteUnauthorized } from "./session";
import type { TripNode } from "../types";

// ── Server-mirrored types ───────────────────────────────────────────

export type OfferSource = "duffel-test" | "mock";

export interface OfferSegment {
  originIata?: string;
  destinationIata?: string;
  departingAt?: string;
  arrivingAt?: string;
  carrier: string;
  carrierIata?: string;
}

export interface Offer {
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

/** The 7 Duffel fields the booking aggregate needs (spec §4.1). */
export interface Passenger {
  title: string;
  givenName: string;
  familyName: string;
  bornOn: string; // YYYY-MM-DD
  gender: string; // "female" | "male" (mapped to Duffel m/f server-side... actually client sends as-is)
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
  orderId?: string;
  offerSnapshot: {
    carrier: string;
    segments: OfferSegment[];
    duration?: number;
  };
  cancelledAt?: string;
}

/** The offer the client chose, handed back at create time — offers aren't
 *  persisted server-side (A2), so the client re-supplies the live offer + leg. */
export interface SearchSnapshot {
  offer: Offer;
  leg: BookingLeg;
}

export interface SearchOffersParams {
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

/** Zustand booking-modal target (DESIGN-booking.md §7.3). */
export interface BookingTarget {
  tripId?: string;
  legIndex?: number;
  origin?: TripNode;
  dest: TripNode;
  departureDateHint?: string;
}

// ── Typed client errors ─────────────────────────────────────────────

export class BookingNetworkError extends Error {
  constructor(message = "Couldn't reach the booking service") {
    super(message);
    this.name = "BookingNetworkError";
  }
}

/** Mirrors the server's 409 offer_expired. */
export class OfferExpiredApiError extends Error {
  constructor(message = "This offer has expired. Please re-search.") {
    super(message);
    this.name = "OfferExpiredApiError";
  }
}

/** Mirrors the server's 400 zod-issue response. */
export class BookingApiValidationError extends Error {
  issues: unknown;
  constructor(message: string, issues?: unknown) {
    super(message);
    this.name = "BookingApiValidationError";
    this.issues = issues;
  }
}

// ── Fetch helpers (live server contract — see server/routes/bookings.ts) ────

/** 401: bookings (and flight search, once it spends a provider key) need the owner's session (ADR 0009). */
export class BookingLockedError extends Error {
  constructor() {
    super("Sign in to see and make bookings");
    this.name = "BookingLockedError";
  }
}

/** Throws BookingLockedError on 401, after telling the session it has ended. */
function checkLocked(status: number, data: any): void {
  if (status !== 401) return;
  const notConfigured = data?.reason === "token_not_configured";
  if (isSignedIn() || notConfigured) noteUnauthorized(notConfigured ? "token_not_configured" : undefined);
  throw new BookingLockedError();
}

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, credentials: apiCredentials });
  } catch {
    throw new BookingNetworkError();
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // no body / non-JSON — leave data null
  }
  checkLocked(res.status, data);
  return { status: res.status, data };
}

function postJson(path: string, body: unknown): Promise<{ status: number; data: any }> {
  return request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export async function searchOffers(
  params: SearchOffersParams
): Promise<{ offers: Offer[]; source: OfferSource }> {
  const { status, data } = await postJson("/api/bookings/search", params);
  if (status !== 200) {
    throw new BookingNetworkError(data?.message ?? "Couldn't search for offers");
  }
  return { offers: (data?.offers ?? []) as Offer[], source: data?.source as OfferSource };
}

export async function createBooking(params: CreateBookingParams): Promise<Booking> {
  const { status, data } = await postJson("/api/bookings", params);
  if (status === 201) return data.booking as Booking;
  if (status === 409 && data?.error === "offer_expired") {
    throw new OfferExpiredApiError(data?.message);
  }
  if (status === 400) {
    throw new BookingApiValidationError(data?.message ?? "Invalid booking request", data?.issues);
  }
  throw new BookingNetworkError(data?.message ?? "Could not create the booking");
}

/** Signed out: no request is made (the list is owner-only). */
export async function listBookings(): Promise<Booking[]> {
  if (!isSignedIn()) throw new BookingLockedError();
  const { status, data } = await request("/api/bookings");
  if (status !== 200) throw new BookingNetworkError("Couldn't load bookings");
  return (data?.bookings ?? []) as Booking[];
}

export async function getBookingById(id: string): Promise<Booking | null> {
  const { status, data } = await request(`/api/bookings/${id}`);
  if (status === 404) return null;
  if (status !== 200) throw new BookingNetworkError("Couldn't load booking");
  return (data?.booking ?? null) as Booking | null;
}

export async function cancelBooking(id: string): Promise<Booking> {
  const { status, data } = await request(`/api/bookings/${id}`, { method: "DELETE" });
  if (status !== 200) throw new BookingNetworkError("Could not cancel the booking");
  return data.booking as Booking;
}

// ── Pure logic: expiry countdown (§7.2) ─────────────────────────────

export const EXPIRY_WARN_THRESHOLD_MS = 2 * 60_000;

/** Milliseconds remaining until `expiresAt`, clamped to >= 0. */
export function remainingMs(expiresAt: string, now: number = Date.now()): number {
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t - now);
}

/** "mm:ss", clamped — never negative, reads "EXPIRED" at/after zero. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "EXPIRED";
  const totalSeconds = Math.ceil(ms / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** True under the 2:00 warn threshold (and not yet expired). */
export function isExpiryUrgent(ms: number): boolean {
  return ms > 0 && ms <= EXPIRY_WARN_THRESHOLD_MS;
}

export function isExpired(ms: number): boolean {
  return ms <= 0;
}

// ── Pure logic: offer formatting ────────────────────────────────────

export function formatDurationMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** "NONSTOP" / "N STOP(S)". The live server contract (BookingOffer.segments)
 *  never carries intermediate connection-airport codes — only origin/destination
 *  per segment — so unlike the design brief's illustrative wireframe (which shows
 *  a connection IATA, e.g. "1 STOP DXB"), we render the count only. */
export function formatStops(stops: number): string {
  if (stops <= 0) return "NONSTOP";
  return `${stops} STOP${stops > 1 ? "S" : ""}`;
}

export interface OfferTimesLabel {
  departLabel: string;
  /** Present only when the offer carries an arrival time (mock offers omit it). */
  arriveLabel?: string;
}

/** Formats the "depart HH:MM → arrive HH:MM +Nd" secondary line. Degrades
 *  gracefully when arrivingAt is absent (the mock provider never sets it). */
export function formatOfferTimes(departingAt?: string, arrivingAt?: string): OfferTimesLabel {
  const fmtTime = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };
  const departLabel = departingAt ? fmtTime(departingAt) : "—";
  if (!arrivingAt) return { departLabel };

  let dayOffset = "";
  const arr = new Date(arrivingAt);
  if (departingAt && !Number.isNaN(arr.getTime())) {
    const dep = new Date(departingAt);
    const depDay = Date.UTC(dep.getUTCFullYear(), dep.getUTCMonth(), dep.getUTCDate());
    const arrDay = Date.UTC(arr.getUTCFullYear(), arr.getUTCMonth(), arr.getUTCDate());
    const diffDays = Math.round((arrDay - depDay) / 86_400_000);
    if (diffDays > 0) dayOffset = ` +${diffDays}`;
  }
  return { departLabel, arriveLabel: `${fmtTime(arrivingAt)}${dayOffset}` };
}

export type OfferSortKey = "price" | "duration" | "depart";

export function sortOffers(offers: Offer[], key: OfferSortKey): Offer[] {
  const copy = [...offers];
  switch (key) {
    case "price":
      return copy.sort((a, b) => a.priceAmount - b.priceAmount);
    case "duration":
      return copy.sort(
        (a, b) => (a.durationMinutes ?? Number.POSITIVE_INFINITY) - (b.durationMinutes ?? Number.POSITIVE_INFINITY)
      );
    case "depart":
      return copy.sort((a, b) => (a.departingAt ?? "").localeCompare(b.departingAt ?? ""));
    default:
      return copy;
  }
}

// ── Pure logic: passenger form validation (§4.3) ────────────────────

export interface PassengerDraft {
  title: string;
  givenName: string;
  familyName: string;
  bornOn: string;
  gender: "" | "female" | "male";
  email: string;
  phoneNumber: string;
}

export function emptyPassengerDraft(): PassengerDraft {
  return {
    title: "MR",
    givenName: "",
    familyName: "",
    bornOn: "",
    gender: "",
    email: "",
    phoneNumber: "",
  };
}

export type PassengerErrors = Partial<Record<keyof PassengerDraft, string>>;

const NAME_RE = /^[A-Za-z\s'-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_DIGITS_RE = /^\+\d[\d\s-]{6,}$/;

/** Validates the exact-copy error messages from DESIGN-booking.md §4.3. */
export function validatePassengerDraft(draft: PassengerDraft, today: Date = new Date()): PassengerErrors {
  const errors: PassengerErrors = {};

  if (!draft.title.trim()) errors.title = "REQUIRED";

  if (!draft.givenName.trim() || !NAME_RE.test(draft.givenName.trim())) {
    errors.givenName = "REQUIRED";
  }
  if (!draft.familyName.trim() || !NAME_RE.test(draft.familyName.trim())) {
    errors.familyName = "REQUIRED";
  }

  if (!draft.bornOn) {
    errors.bornOn = "REQUIRED";
  } else {
    const born = new Date(`${draft.bornOn}T00:00:00`);
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (Number.isNaN(born.getTime()) || born >= todayStart) {
      errors.bornOn = "DATE MUST BE IN THE PAST";
    }
  }

  if (!draft.gender) errors.gender = "REQUIRED";

  if (!draft.email.trim()) {
    errors.email = "REQUIRED";
  } else if (!EMAIL_RE.test(draft.email.trim())) {
    errors.email = "ENTER A VALID EMAIL";
  }

  if (!draft.phoneNumber.trim()) {
    errors.phoneNumber = "REQUIRED";
  } else if (!draft.phoneNumber.trim().startsWith("+") || !PHONE_DIGITS_RE.test(draft.phoneNumber.trim())) {
    errors.phoneNumber = "INCLUDE COUNTRY CODE";
  }

  return errors;
}

export function isPassengerDraftValid(draft: PassengerDraft, today?: Date): boolean {
  return Object.keys(validatePassengerDraft(draft, today)).length === 0;
}

export function passengerDraftToPassenger(draft: PassengerDraft): Passenger {
  return {
    title: draft.title,
    givenName: draft.givenName.trim(),
    familyName: draft.familyName.trim(),
    bornOn: draft.bornOn,
    gender: draft.gender,
    email: draft.email.trim(),
    phoneNumber: draft.phoneNumber.trim(),
  };
}

// ── Pure logic: date gate (CONFIRM step) ────────────────────────────

/** YYYY-MM-DD for "today", used as the DEPART min= and validation floor. */
export function todayIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isDepartureDateValid(departureDate: string, today: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) return false;
  return departureDate >= todayIsoDate(today);
}

export function isReturnDateValid(returnDate: string, departureDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) return false;
  return returnDate >= departureDate;
}

// ── Pure logic: booking badge matching (§6) ─────────────────────────

/** Most recent booking for a trip leg, preferring a non-cancelled one, so the
 *  leg badge always reflects the latest live booking (or the latest cancelled
 *  one if that's all there is). */
export function findLegBooking(bookings: Booking[], tripId: string, legIndex: number): Booking | undefined {
  const matches = bookings.filter((b) => b.tripId === tripId && b.legIndex === legIndex);
  if (matches.length === 0) return undefined;
  const active = matches.filter((b) => b.status === "booked");
  const pool = active.length > 0 ? active : matches;
  return pool.reduce((newest, b) => (new Date(b.createdAt) > new Date(newest.createdAt) ? b : newest));
}

export function countActiveBookings(bookings: Booking[]): number {
  return bookings.filter((b) => b.status === "booked").length;
}
