import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point persistence at a throwaway dir BEFORE any booking function runs.
// paths.ts resolves DATA_DIR lazily, so setting it here is enough — no dynamic
// import gymnastics required.
let TMP_DATA: string;

import {
  searchOffers,
  createBooking,
  listBookings,
  getBooking,
  cancelBooking,
  OfferExpiredError,
  BookingValidationError,
  type SearchSnapshot,
  type Passenger,
} from "./booking";

const PASSENGER: Passenger = {
  title: "mr",
  givenName: "Ada",
  familyName: "Lovelace",
  bornOn: "1990-12-10",
  gender: "f",
  email: "ada@example.com",
  phoneNumber: "+442071234567",
};

function snapshotFor(offer: Awaited<ReturnType<typeof searchOffers>>["offers"][number]): SearchSnapshot {
  return {
    offer,
    leg: {
      originIata: "LHR",
      destinationIata: "JFK",
      departureDate: "2026-09-01",
    },
  };
}

beforeAll(() => {
  TMP_DATA = mkdtempSync(join(tmpdir(), "meridian-booking-test-"));
  process.env.DATA_DIR = TMP_DATA;
  delete process.env.DUFFEL_API_KEY; // force the deterministic mock path
});

afterAll(() => {
  rmSync(TMP_DATA, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  // Fresh store per test: re-point DATA_DIR at a clean temp dir.
  TMP_DATA = mkdtempSync(join(tmpdir(), "meridian-booking-test-"));
  process.env.DATA_DIR = TMP_DATA;
});

describe("searchOffers — deterministic mock path", () => {
  it("labels offers as mock and returns bookable-looking shapes", async () => {
    const { offers, source } = await searchOffers({
      originIata: "LHR",
      destinationIata: "JFK",
      departureDate: "2026-09-01",
      passengers: 1,
    });
    expect(source).toBe("mock");
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.id.startsWith("mock_off_")).toBe(true);
      expect(o.source).toBe("mock");
      expect(o.priceAmount).toBeGreaterThan(0);
      expect(o.currency).toBe("USD");
      expect(o.carrier).toBeTruthy();
      expect(o.segments.length).toBeGreaterThan(0);
      // expiresAt ~20min out
      const ms = new Date(o.expiresAt).getTime() - Date.now();
      expect(ms).toBeGreaterThan(15 * 60_000);
      expect(ms).toBeLessThanOrEqual(21 * 60_000);
    }
  });

  it("same params produce the same offers (ignoring the time-based expiresAt)", async () => {
    const a = await searchOffers({
      originIata: "LHR",
      destinationIata: "JFK",
      departureDate: "2026-09-01",
      passengers: 2,
    });
    const b = await searchOffers({
      originIata: "LHR",
      destinationIata: "JFK",
      departureDate: "2026-09-01",
      passengers: 2,
    });
    const strip = (offers: typeof a.offers) => offers.map((o) => ({ ...o, expiresAt: "" }));
    expect(strip(a.offers)).toEqual(strip(b.offers));
  });

  it("different routes produce different offers", async () => {
    const a = await searchOffers({ originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    const b = await searchOffers({ originIata: "CDG", destinationIata: "NRT", departureDate: "2026-09-01", passengers: 1 });
    expect(a.offers[0]!.id).not.toBe(b.offers[0]!.id);
    expect(a.offers[0]!.priceAmount).not.toBe(b.offers[0]!.priceAmount);
  });

  it("adds a return segment when returnDate is present", async () => {
    const { offers } = await searchOffers({
      originIata: "LHR",
      destinationIata: "JFK",
      departureDate: "2026-09-01",
      returnDate: "2026-09-10",
      passengers: 1,
    });
    expect(offers[0]!.segments.length).toBe(2);
  });
});

describe("createBooking — persistence + reference", () => {
  it("persists a booked aggregate and returns a booking reference", async () => {
    const { offers } = await searchOffers({ originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    const booking = await createBooking({
      offerId: offers[0]!.id,
      tripId: "trip-1",
      legIndex: 0,
      passengers: [PASSENGER],
      searchSnapshot: snapshotFor(offers[0]!),
    });

    expect(booking.status).toBe("booked");
    expect(booking.source).toBe("mock");
    expect(booking.bookingReference).toMatch(/^[A-Z0-9]{6}$/);
    expect(booking.tripId).toBe("trip-1");
    expect(booking.legIndex).toBe(0);
    expect(booking.totalAmount).toBe(offers[0]!.priceAmount);
    expect(booking.leg.originIata).toBe("LHR");
    expect(booking.offerSnapshot.carrier).toBe(offers[0]!.carrier);
    // persisted + retrievable
    expect((await getBooking(booking.id))?.id).toBe(booking.id);
    expect((await listBookings()).some((b) => b.id === booking.id)).toBe(true);
  });

  it("only stores the passenger fields the aggregate needs", async () => {
    const { offers } = await searchOffers({ originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    const booking = await createBooking({
      offerId: offers[0]!.id,
      passengers: [PASSENGER],
      searchSnapshot: snapshotFor(offers[0]!),
    });
    expect(booking.passengers[0]).toEqual(PASSENGER);
  });

  it("rejects an offerId that does not match the snapshot", async () => {
    const { offers } = await searchOffers({ originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    await expect(
      createBooking({
        offerId: "mock_off_does_not_exist",
        passengers: [PASSENGER],
        searchSnapshot: snapshotFor(offers[0]!),
      }),
    ).rejects.toBeInstanceOf(BookingValidationError);
  });

  it("rejects an unknown/unroutable offerId (no duffel key, not a mock id)", async () => {
    const { offers } = await searchOffers({ originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    const snap = snapshotFor({ ...offers[0]!, id: "off_realish_123" });
    await expect(
      createBooking({ offerId: "off_realish_123", passengers: [PASSENGER], searchSnapshot: snap }),
    ).rejects.toBeInstanceOf(BookingValidationError);
  });

  it("throws OfferExpiredError when the snapshot offer has already expired", async () => {
    const { offers } = await searchOffers({ originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    const expired = { ...offers[0]!, expiresAt: new Date(Date.now() - 60_000).toISOString() };
    await expect(
      createBooking({ offerId: expired.id, passengers: [PASSENGER], searchSnapshot: snapshotFor(expired) }),
    ).rejects.toBeInstanceOf(OfferExpiredError);
  });
});

describe("cancelBooking — state transitions", () => {
  async function makeBooking() {
    const { offers } = await searchOffers({ originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    return createBooking({ offerId: offers[0]!.id, passengers: [PASSENGER], searchSnapshot: snapshotFor(offers[0]!) });
  }

  it("transitions booked -> cancelled", async () => {
    const booking = await makeBooking();
    const cancelled = await cancelBooking(booking.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelledAt).toBeTruthy();
    expect((await getBooking(booking.id))?.status).toBe("cancelled");
  });

  it("double-cancel is idempotent, not an error", async () => {
    const booking = await makeBooking();
    await cancelBooking(booking.id);
    const again = await cancelBooking(booking.id);
    expect(again?.status).toBe("cancelled");
  });

  it("returns null for a missing id", async () => {
    expect(await cancelBooking("nope")).toBeNull();
  });
});
