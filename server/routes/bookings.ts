import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  searchOffers,
  createBooking,
  listBookings,
  getBooking,
  cancelBooking,
  OfferExpiredError,
  BookingValidationError,
  type SearchSnapshot,
} from "../lib/booking.js";

const bookings = new Hono();

// ── zod schemas (v3) ────────────────────────────────────────────────

const iata = z.string().trim().min(2).max(4);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const searchSchema = z.object({
  originIata: iata,
  destinationIata: iata,
  departureDate: isoDate,
  returnDate: isoDate.optional(),
  passengers: z.number().int().min(1).max(9),
});

const passengerSchema = z.object({
  title: z.string().min(1),
  givenName: z.string().min(1),
  familyName: z.string().min(1),
  bornOn: isoDate,
  gender: z.string().min(1),
  email: z.string().email(),
  phoneNumber: z.string().min(1),
});

const offerSegmentSchema = z.object({
  originIata: z.string().optional(),
  destinationIata: z.string().optional(),
  departingAt: z.string().optional(),
  arrivingAt: z.string().optional(),
  carrier: z.string(),
  carrierIata: z.string().optional(),
});

const offerSchema = z.object({
  id: z.string(),
  source: z.enum(["duffel-test", "mock"]),
  priceAmount: z.number(),
  currency: z.string(),
  carrier: z.string(),
  carrierIata: z.string().optional(),
  segments: z.array(offerSegmentSchema),
  durationMinutes: z.number().optional(),
  stops: z.number(),
  expiresAt: z.string(),
  departingAt: z.string().optional(),
  arrivingAt: z.string().optional(),
});

const snapshotSchema = z.object({
  offer: offerSchema,
  leg: z.object({
    originIata: iata,
    destinationIata: iata,
    departureDate: isoDate,
    returnDate: isoDate.optional(),
  }),
});

const createSchema = z.object({
  offerId: z.string().min(1),
  tripId: z.string().optional(),
  legIndex: z.number().int().min(0).optional(),
  passengers: z.array(passengerSchema).min(1),
  // Offers aren't persisted server-side; the client hands the chosen offer back.
  searchSnapshot: snapshotSchema,
});

function badRequest(c: Context, issues: unknown) {
  return c.json({ error: "Invalid request", issues }, 400);
}

// ── POST /search ────────────────────────────────────────────────────

bookings.post("/search", async (c) => {
  const parsed = searchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return badRequest(c, parsed.error.issues);

  const { offers, source } = await searchOffers(parsed.data);
  return c.json({ offers, source });
});

// ── POST / (create booking) ─────────────────────────────────────────

bookings.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return badRequest(c, parsed.error.issues);

  try {
    const booking = await createBooking({
      offerId: parsed.data.offerId,
      tripId: parsed.data.tripId,
      legIndex: parsed.data.legIndex,
      passengers: parsed.data.passengers,
      searchSnapshot: parsed.data.searchSnapshot as SearchSnapshot,
    });
    return c.json({ booking }, 201);
  } catch (err) {
    if (err instanceof OfferExpiredError) {
      return c.json(
        { error: "offer_expired", message: "This offer has expired. Please re-search for fresh offers and try again." },
        409,
      );
    }
    if (err instanceof BookingValidationError) {
      return c.json({ error: "invalid_offer", message: err.message }, 400);
    }
    console.error("[bookings] createBooking error:", err);
    return c.json({ error: "booking_failed", message: "Could not create the booking." }, 500);
  }
});

// ── GET / (list) ────────────────────────────────────────────────────

bookings.get("/", (c) => {
  return c.json({ bookings: listBookings() });
});

// ── GET /:id ────────────────────────────────────────────────────────

bookings.get("/:id", (c) => {
  const booking = getBooking(c.req.param("id"));
  if (!booking) return c.json({ error: "not_found", message: "Booking not found" }, 404);
  return c.json({ booking });
});

// ── DELETE /:id (cancel) ────────────────────────────────────────────

bookings.delete("/:id", async (c) => {
  try {
    const booking = await cancelBooking(c.req.param("id"));
    if (!booking) return c.json({ error: "not_found", message: "Booking not found" }, 404);
    return c.json({ booking });
  } catch (err) {
    console.error("[bookings] cancelBooking error:", err);
    return c.json({ error: "cancel_failed", message: "Could not cancel the booking." }, 500);
  }
});

export default bookings;
