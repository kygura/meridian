import { describe, expect, it } from "vitest";
import type { Booking } from "../../../lib/bookingApi";
import {
  adultsText,
  countdownText,
  dateText,
  durationText,
  passengerErrorText,
  passengerName,
  priceText,
  sortBookings,
  stopsText,
} from "./flightText";

describe("flightText", () => {
  it("words stops and adults", () => {
    expect(stopsText(0)).toBe("Nonstop");
    expect(stopsText(1)).toBe("1 stop");
    expect(stopsText(2)).toBe("2 stops");
    expect(adultsText(1)).toBe("1 adult");
    expect(adultsText(3)).toBe("3 adults");
  });

  it("formats durations", () => {
    expect(durationText(45)).toBe("45 min");
    expect(durationText(120)).toBe("2 h");
    expect(durationText(125)).toBe("2 h 5 min");
  });

  it("formats dates without timezone drift", () => {
    expect(dateText("2026-08-14")).toBe("Fri 14 Aug 2026");
    expect(dateText("2026-08-14", { year: false })).toBe("Fri 14 Aug");
    expect(dateText("2026-01-01", { weekday: false })).toBe("1 Jan 2026");
    expect(dateText("")).toBe("");
  });

  it("formats prices", () => {
    expect(priceText(1240, "USD")).toBe("$1,240");
    expect(priceText(312.5, "EUR")).toBe("€312.50");
    expect(priceText(10, "NOPE")).toBe("10 NOPE");
  });

  it("formats the countdown", () => {
    expect(countdownText(0)).toBe("Expired");
    expect(countdownText(-5)).toBe("Expired");
    expect(countdownText(245_000)).toBe("4:05");
    expect(countdownText(500)).toBe("0:01");
  });

  it("turns validator codes into sentences", () => {
    expect(passengerErrorText("email", "REQUIRED")).toBe("Enter an email address");
    expect(passengerErrorText("givenName", "REQUIRED")).toMatch(/letters only/);
    expect(passengerErrorText("gender", "REQUIRED")).toBe("Choose one");
    expect(passengerErrorText("bornOn", "DATE MUST BE IN THE PAST")).toBe("Date of birth must be in the past");
    expect(passengerErrorText("phoneNumber", "INCLUDE COUNTRY CODE")).toMatch(/^Start with the country code/);
    expect(passengerErrorText("email", undefined)).toBeUndefined();
  });

  it("names passengers", () => {
    expect(passengerName({ title: "DR", givenName: "Ada", familyName: "Lovelace" })).toBe("Dr Ada Lovelace");
    expect(passengerName(undefined)).toBe("");
  });

  it("sorts live bookings by date, cancelled last", () => {
    const mk = (id: string, date: string, status: Booking["status"]): Booking =>
      ({ id, status, createdAt: "2026-01-01T00:00:00Z", leg: { departureDate: date } }) as unknown as Booking;
    const out = sortBookings([mk("a", "2026-09-01", "cancelled"), mk("b", "2026-12-01", "booked"), mk("c", "2026-10-01", "booked")]);
    expect(out.map((b) => b.id)).toEqual(["c", "b", "a"]);
  });
});
