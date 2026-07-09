import { describe, it, expect } from "vitest";
import {
  remainingMs,
  formatCountdown,
  isExpiryUrgent,
  isExpired,
  formatDurationMinutes,
  formatStops,
  formatOfferTimes,
  sortOffers,
  validatePassengerDraft,
  isPassengerDraftValid,
  emptyPassengerDraft,
  isDepartureDateValid,
  isReturnDateValid,
  todayIsoDate,
  findLegBooking,
  countActiveBookings,
  type Offer,
  type Booking,
  type PassengerDraft,
} from "./bookingApi";

describe("expiry countdown", () => {
  it("computes remaining ms clamped to zero", () => {
    const now = Date.parse("2026-07-09T12:00:00Z");
    expect(remainingMs(new Date(now + 5000).toISOString(), now)).toBe(5000);
    expect(remainingMs(new Date(now - 5000).toISOString(), now)).toBe(0);
  });

  it("formats mm:ss and clamps to EXPIRED", () => {
    expect(formatCountdown(0)).toBe("EXPIRED");
    expect(formatCountdown(-100)).toBe("EXPIRED");
    expect(formatCountdown(1000)).toBe("00:01");
    expect(formatCountdown(61_000)).toBe("01:01");
    expect(formatCountdown(3_723_000)).toBe("62:03");
  });

  it("flags urgency only inside the 2:00 warn window and while still alive", () => {
    expect(isExpiryUrgent(120_000)).toBe(true);
    expect(isExpiryUrgent(120_001)).toBe(false);
    expect(isExpiryUrgent(0)).toBe(false);
    expect(isExpired(0)).toBe(true);
    expect(isExpired(1)).toBe(false);
  });
});

describe("offer formatting", () => {
  it("formats duration minutes", () => {
    expect(formatDurationMinutes(860)).toBe("14h 20m");
    expect(formatDurationMinutes(60)).toBe("1h 00m");
    expect(formatDurationMinutes(5)).toBe("0h 05m");
  });

  it("formats stops without fabricating connection airports", () => {
    expect(formatStops(0)).toBe("NONSTOP");
    expect(formatStops(1)).toBe("1 STOP");
    expect(formatStops(2)).toBe("2 STOPS");
  });

  it("formats offer times, degrading gracefully without an arrival time", () => {
    expect(formatOfferTimes(undefined, undefined)).toEqual({ departLabel: "—" });
    expect(formatOfferTimes("2026-08-14T22:10:00Z", undefined)).toEqual({
      departLabel: "22:10",
    });
    expect(formatOfferTimes("2026-08-14T22:10:00Z", "2026-08-15T19:30:00Z")).toEqual({
      departLabel: "22:10",
      arriveLabel: "19:30 +1",
    });
    expect(formatOfferTimes("2026-08-14T22:10:00Z", "2026-08-14T23:00:00Z")).toEqual({
      departLabel: "22:10",
      arriveLabel: "23:00",
    });
  });

  it("sorts offers by price, duration, and departure", () => {
    const offers: Offer[] = [
      mkOffer({ id: "a", priceAmount: 900, durationMinutes: 300, departingAt: "2026-08-14T09:00:00Z" }),
      mkOffer({ id: "b", priceAmount: 500, durationMinutes: 600, departingAt: "2026-08-14T22:00:00Z" }),
      mkOffer({ id: "c", priceAmount: 700, durationMinutes: 100, departingAt: "2026-08-14T05:00:00Z" }),
    ];
    expect(sortOffers(offers, "price").map((o) => o.id)).toEqual(["b", "c", "a"]);
    expect(sortOffers(offers, "duration").map((o) => o.id)).toEqual(["c", "a", "b"]);
    expect(sortOffers(offers, "depart").map((o) => o.id)).toEqual(["c", "a", "b"]);
  });
});

describe("passenger form validation predicate", () => {
  const today = new Date("2026-07-09T00:00:00");

  it("flags every required field as REQUIRED when empty", () => {
    const errors = validatePassengerDraft(emptyPassengerDraft(), today);
    expect(errors.givenName).toBe("REQUIRED");
    expect(errors.familyName).toBe("REQUIRED");
    expect(errors.bornOn).toBe("REQUIRED");
    expect(errors.gender).toBe("REQUIRED");
    expect(errors.email).toBe("REQUIRED");
    expect(errors.phoneNumber).toBe("REQUIRED");
  });

  it("rejects an invalid email with the exact copy", () => {
    const draft = validDraft();
    draft.email = "not-an-email";
    expect(validatePassengerDraft(draft, today).email).toBe("ENTER A VALID EMAIL");
  });

  it("requires a country code on phone", () => {
    const draft = validDraft();
    draft.phoneNumber = "4155550142";
    expect(validatePassengerDraft(draft, today).phoneNumber).toBe("INCLUDE COUNTRY CODE");
  });

  it("rejects a birth date that isn't in the past", () => {
    const draft = validDraft();
    draft.bornOn = "2026-07-09"; // == today
    expect(validatePassengerDraft(draft, today).bornOn).toBe("DATE MUST BE IN THE PAST");
    draft.bornOn = "2099-01-01";
    expect(validatePassengerDraft(draft, today).bornOn).toBe("DATE MUST BE IN THE PAST");
  });

  it("accepts a fully valid draft", () => {
    expect(isPassengerDraftValid(validDraft(), today)).toBe(true);
  });

  function validDraft(): PassengerDraft {
    return {
      title: "MR",
      givenName: "Aisha",
      familyName: "Rahman",
      bornOn: "1990-04-12",
      gender: "female",
      email: "aisha@example.com",
      phoneNumber: "+1 415 555 0142",
    };
  }
});

describe("departure/return date gate", () => {
  const today = new Date("2026-07-09T00:00:00");

  it("computes today's ISO date", () => {
    expect(todayIsoDate(today)).toBe("2026-07-09");
  });

  it("requires departure date to be today or later", () => {
    expect(isDepartureDateValid("2026-07-08", today)).toBe(false);
    expect(isDepartureDateValid("2026-07-09", today)).toBe(true);
    expect(isDepartureDateValid("2026-08-14", today)).toBe(true);
    expect(isDepartureDateValid("not-a-date", today)).toBe(false);
  });

  it("requires return date to be on/after departure", () => {
    expect(isReturnDateValid("2026-08-13", "2026-08-14")).toBe(false);
    expect(isReturnDateValid("2026-08-14", "2026-08-14")).toBe(true);
    expect(isReturnDateValid("2026-08-20", "2026-08-14")).toBe(true);
  });
});

describe("leg booking badge matching (§6)", () => {
  it("prefers the newest booked booking for a leg", () => {
    const bookings: Booking[] = [
      mkBooking({ id: "old", tripId: "t1", legIndex: 0, status: "booked", createdAt: "2026-01-01T00:00:00Z" }),
      mkBooking({ id: "new", tripId: "t1", legIndex: 0, status: "booked", createdAt: "2026-02-01T00:00:00Z" }),
    ];
    expect(findLegBooking(bookings, "t1", 0)?.id).toBe("new");
  });

  it("falls back to the most recent cancelled booking when none are active", () => {
    const bookings: Booking[] = [
      mkBooking({ id: "c1", tripId: "t1", legIndex: 0, status: "cancelled", createdAt: "2026-01-01T00:00:00Z" }),
      mkBooking({ id: "c2", tripId: "t1", legIndex: 0, status: "cancelled", createdAt: "2026-02-01T00:00:00Z" }),
    ];
    expect(findLegBooking(bookings, "t1", 0)?.id).toBe("c2");
  });

  it("prefers a booked booking over a newer cancelled one for the same leg", () => {
    const bookings: Booking[] = [
      mkBooking({ id: "booked", tripId: "t1", legIndex: 0, status: "booked", createdAt: "2026-01-01T00:00:00Z" }),
      mkBooking({ id: "cancelled", tripId: "t1", legIndex: 0, status: "cancelled", createdAt: "2026-03-01T00:00:00Z" }),
    ];
    expect(findLegBooking(bookings, "t1", 0)?.id).toBe("booked");
  });

  it("returns undefined when no booking matches the leg", () => {
    expect(findLegBooking([], "t1", 0)).toBeUndefined();
  });

  it("counts only booked (non-cancelled) bookings", () => {
    const bookings: Booking[] = [
      mkBooking({ id: "a", status: "booked" }),
      mkBooking({ id: "b", status: "cancelled" }),
      mkBooking({ id: "c", status: "booked" }),
    ];
    expect(countActiveBookings(bookings)).toBe(2);
  });
});

// ── fixtures ──────────────────────────────────────────────────────

function mkOffer(patch: Partial<Offer>): Offer {
  return {
    id: "off_1",
    source: "mock",
    priceAmount: 500,
    currency: "USD",
    carrier: "Test Air",
    segments: [],
    stops: 0,
    expiresAt: "2026-08-14T12:00:00Z",
    ...patch,
  };
}

function mkBooking(patch: Partial<Booking>): Booking {
  return {
    id: "bkg_1",
    createdAt: "2026-01-01T00:00:00Z",
    status: "booked",
    source: "mock",
    bookingReference: "X7K9Q2",
    passengers: [],
    leg: { originIata: "JFK", destinationIata: "DXB", departureDate: "2026-08-14" },
    totalAmount: 842,
    totalCurrency: "USD",
    offerSnapshot: { carrier: "Test Air", segments: [] },
    ...patch,
  };
}
