import { describe, expect, it } from "vitest";
import {
  bookedLegCount,
  canReturnToStart,
  copyTripName,
  displayTripName,
  dropIndex,
  formatFlightTime,
  nextTripName,
  stopChain,
  stopKeys,
  tripDateRange,
  tripDays,
  tripLegs,
  tripTotals,
} from "./tripPlan";
import type { Booking } from "./bookingApi";
import type { Trip, TripNode } from "../types";

const LIS: TripNode = { cityId: "lis", name: "Lisbon", iata: "LIS", lat: 38.72, lng: -9.14 };
const OPO: TripNode = { cityId: "opo", name: "Porto", iata: "OPO", lat: 41.15, lng: -8.61 };
const MAD: TripNode = { cityId: "mad", name: "Madrid", iata: "MAD", lat: 40.42, lng: -3.7 };
const TOWN: TripNode = { cityId: "town", name: "Smalltown", lat: 40, lng: -4 };

const trip = (nodes: TripNode[], extra: Partial<Trip> = {}): Trip => ({
  id: "t1",
  name: "Iberia",
  color: "#0f766e",
  status: "draft",
  nodes,
  ...extra,
});

const booking = (legIndex: number, status: Booking["status"], createdAt = "2026-01-01T00:00:00Z"): Booking =>
  ({ id: `b${legIndex}${status}`, tripId: "t1", legIndex, status, createdAt, bookingReference: "ABC" }) as Booking;

describe("tripLegs / tripTotals", () => {
  it("builds one leg per consecutive pair with estimates", () => {
    const legs = tripLegs([LIS, OPO, MAD]);
    expect(legs).toHaveLength(2);
    expect(legs[0].from.cityId).toBe("lis");
    expect(legs[0].to.cityId).toBe("opo");
    expect(legs[0].km).toBeGreaterThan(250);
    expect(legs[0].km).toBeLessThan(300);
    expect(legs[0].cost).toBeGreaterThan(45);
    expect(legs[0].bookable).toBe(true);
    const totals = tripTotals(legs);
    expect(totals.legs).toBe(2);
    expect(totals.cost).toBe(legs[0].cost + legs[1].cost);
  });

  it("marks legs without an airport as not bookable", () => {
    expect(tripLegs([LIS, TOWN])[0].bookable).toBe(false);
  });

  it("returns no legs for zero or one stop", () => {
    expect(tripLegs([])).toEqual([]);
    expect(tripLegs([LIS])).toEqual([]);
  });
});

describe("bookedLegCount", () => {
  it("counts only legs with a live booking", () => {
    const t = trip([LIS, OPO, MAD]);
    expect(bookedLegCount(t, [])).toBe(0);
    expect(bookedLegCount(t, [booking(0, "booked"), booking(1, "cancelled")])).toBe(1);
    // A leg index past the end of the trip doesn't count.
    expect(bookedLegCount(t, [booking(5, "booked")])).toBe(0);
  });
});

describe("stopChain", () => {
  it("joins names with arrows", () => {
    expect(stopChain([LIS, OPO, MAD])).toBe("Lisbon → Porto → Madrid");
  });
  it("collapses long chains", () => {
    const nodes = ["A", "B", "C", "D", "E", "F"].map((n) => ({ ...LIS, cityId: n, name: n }));
    expect(stopChain(nodes)).toBe("A → B → 3 more → F");
  });
});

describe("dates", () => {
  it("returns null without an estimate", () => {
    expect(tripDays(trip([LIS]))).toBeNull();
    expect(tripDateRange(trip([LIS]))).toBeNull();
  });
  it("computes days and a range", () => {
    const t = trip([LIS], {
      estimate: { priceEstimate: 300, currency: "USD", dateRange: { start: "2026-03-04", end: "2026-03-12" } },
    });
    expect(tripDays(t)).toBe(8);
    expect(tripDateRange(t, "en-US")).toBe("Mar 4 – Mar 12");
  });
});

describe("names", () => {
  it("shows store-generated names in sentence case", () => {
    expect(displayTripName("TRIP 3")).toBe("Trip 3");
    expect(displayTripName("TRIP 3 COPY")).toBe("Trip 3 (copy)");
    expect(displayTripName("  ")).toBe("Untitled trip");
    expect(displayTripName("NYC weekend")).toBe("NYC weekend");
  });
  it("picks the next free trip number", () => {
    expect(nextTripName([])).toBe("Trip 1");
    expect(nextTripName([{ name: "TRIP 2" }])).toBe("Trip 3");
    expect(nextTripName([{ name: "x" }, { name: "Trip 3" }])).toBe("Trip 4");
  });
  it("names copies once", () => {
    expect(copyTripName("Iberia")).toBe("Iberia (copy)");
    expect(copyTripName("Iberia (copy)")).toBe("Iberia (copy)");
  });
});

describe("stops", () => {
  it("offers a return leg only when the trip doesn't end at the start", () => {
    expect(canReturnToStart([LIS])).toBe(false);
    expect(canReturnToStart([LIS, OPO])).toBe(true);
    expect(canReturnToStart([LIS, OPO, LIS])).toBe(false);
  });
  it("keeps keys unique when a city repeats", () => {
    expect(stopKeys([LIS, OPO, LIS])).toEqual(["lis#0", "opo#0", "lis#1"]);
  });
});

describe("formatFlightTime", () => {
  it("uses plain hours and minutes", () => {
    expect(formatFlightTime(0.75)).toBe("45m");
    expect(formatFlightTime(2)).toBe("2h");
    expect(formatFlightTime(2.25)).toBe("2h 15m");
  });
});

describe("dropIndex", () => {
  const mids = [10, 30, 50, 70];
  it("moves down past rows whose middle is above the pointer", () => {
    expect(dropIndex(55, mids, 0)).toBe(2);
    expect(dropIndex(95, mids, 0)).toBe(3);
  });
  it("moves up", () => {
    expect(dropIndex(5, mids, 3)).toBe(0);
    expect(dropIndex(35, mids, 3)).toBe(2);
  });
  it("stays put near its own row", () => {
    expect(dropIndex(32, mids, 1)).toBe(1);
  });
});
