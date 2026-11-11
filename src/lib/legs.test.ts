import { describe, expect, it } from "vitest";
import {
  buildLeg,
  defaultLegMode,
  estimateGroundLeg,
  GROUND_DETOUR,
  legPlanSlot,
  OUTBOUND_LEG,
  RETURN_LEG,
  tripLegs,
  tripRoute,
  tripTotals,
} from "./legs";
import { haversineKm } from "./geo";
import type { Trip, TripNode } from "../types";

const LPA: TripNode = { cityId: "lpa", name: "Las Palmas", iata: "LPA", lat: 28.1, lng: -15.43 };
const TFN: TripNode = { cityId: "tfn", name: "Santa Cruz de Tenerife", iata: "TFN", lat: 28.47, lng: -16.25 };
const LIS: TripNode = { cityId: "lis", name: "Lisbon", iata: "LIS", lat: 38.72, lng: -9.14 };
const OPO: TripNode = { cityId: "opo", name: "Porto", iata: "OPO", lat: 41.15, lng: -8.61 };
const SIN: TripNode = { cityId: "sin", name: "Sintra", lat: 38.8, lng: -9.39 };
const BER: TripNode = { cityId: "ber", name: "Berlin", iata: "BER", lat: 52.52, lng: 13.4 };
const VIL: TripNode = { cityId: "vil", name: "Village", lat: 47, lng: 8 };

// Iberia and Berlin share a landmass; the two Canary Islands are each their own.
const LAND: Record<string, number> = { lis: 4, opo: 4, sin: 4, ber: 4, vil: 4, lpa: 100, tfn: 101 };
const landmassOf = (id: string) => LAND[id];
const km = (a: TripNode, b: TripNode) => haversineKm([a.lng, a.lat], [b.lng, b.lat]);

describe("defaultLegMode", () => {
  it("picks ground transport by distance on one landmass", () => {
    expect(defaultLegMode(LIS, SIN, km(LIS, SIN), landmassOf).mode).toBe("drive");
    expect(defaultLegMode(LIS, OPO, km(LIS, OPO), landmassOf).mode).toBe("train");
    expect(defaultLegMode(LIS, { ...OPO, lat: 40.2, lng: -8.4 }, 170, landmassOf).mode).toBe("bus");
  });

  it("flies when the ground would take more than a day, or the sea is wide", () => {
    expect(defaultLegMode(LIS, BER, km(LIS, BER), landmassOf).mode).toBe("flight");
    expect(defaultLegMode(LPA, LIS, km(LPA, LIS), landmassOf)).toEqual({ mode: "flight", reason: "sea crossing" });
  });

  it("takes a ferry across a short stretch of sea, never a road", () => {
    const c = defaultLegMode(LPA, TFN, km(LPA, TFN), landmassOf);
    expect(c.mode).toBe("ferry");
    expect(c.reason).toMatch(/sea/);
  });

  it("stays on the ground when a far city has no airport", () => {
    expect(defaultLegMode(LIS, VIL, km(LIS, VIL), landmassOf).mode).toBe("train");
  });

  it("without landmass data only assumes ground when the cities are close", () => {
    expect(defaultLegMode(LIS, OPO, km(LIS, OPO)).mode).toBe("train");
    expect(defaultLegMode(LIS, BER, km(LIS, BER)).mode).toBe("flight");
  });
});

describe("estimateGroundLeg", () => {
  it("states its method and applies the detour factor", () => {
    const e = estimateGroundLeg("train", 200);
    expect(e.km).toBe(200 * GROUND_DETOUR);
    expect(e.hours).toBeCloseTo(0.5 + 250 / 80);
    expect(e.cost).toBe(25);
    expect(e.method).toMatch(/Rough estimate/);
    expect(e.method).toMatch(/200 km in a straight line × 1.25/);
    expect(e.method).toMatch(/80 km\/h/);
    expect(e.method).toMatch(/\$0\.10 per km/);
  });

  it("prices a car per car, not per person", () => {
    expect(estimateGroundLeg("drive", 80).method).toMatch(/per car/);
  });
});

describe("buildLeg", () => {
  it("lets the traveller override the default mode", () => {
    const def = buildLeg(0, LIS, OPO, [], undefined, landmassOf);
    expect(def).toMatchObject({ mode: "train", modeIsDefault: true, bookable: false });
    const flown = buildLeg(0, LIS, OPO, [], { fromCityId: "lis", mode: "flight" }, landmassOf);
    expect(flown).toMatchObject({ mode: "flight", modeIsDefault: false, bookable: true });
    expect(flown.km).toBeLessThan(def.km); // great circle, no detour
  });

  it("only non-flight legs are kept out of flight search", () => {
    expect(buildLeg(0, LPA, LIS, [], undefined, landmassOf).bookable).toBe(true);
    expect(buildLeg(0, LPA, TFN, [], undefined, landmassOf).bookable).toBe(false);
    expect(buildLeg(0, LIS, VIL, [], { fromCityId: "lis", mode: "flight" }, landmassOf).bookable).toBe(false);
  });

  it("ignores a plan written for a different origin (the route was reordered)", () => {
    const leg = buildLeg(0, LIS, OPO, [], { fromCityId: "mad", mode: "bus", booked: { reference: "X1" } }, landmassOf);
    expect(leg.mode).toBe("train");
    expect(leg.record).toBeUndefined();
  });

  it("carries a recorded booking", () => {
    const leg = buildLeg(0, LIS, OPO, [], { fromCityId: "lis", booked: { carrier: "CP", reference: "ABC123" } }, landmassOf);
    expect(leg.record).toEqual({ carrier: "CP", reference: "ABC123" });
    expect(buildLeg(0, LIS, OPO, [], { fromCityId: "lis", booked: {} }).record).toBeUndefined();
  });
});

describe("tripRoute / tripTotals", () => {
  const trip: Pick<Trip, "nodes" | "departure" | "returnHome" | "homeLeg"> = {
    nodes: [LIS, { ...OPO, travel: { fromCityId: "lis", mode: "bus" } }],
    homeLeg: { fromCityId: "opo", booked: { number: "TP1" } },
  };

  it("reads each leg's plan from the stop it arrives at, and the way home from the trip", () => {
    const r = tripRoute(trip, LPA, [], landmassOf);
    expect(r.all.map((l) => l.index)).toEqual([OUTBOUND_LEG, 0, RETURN_LEG]);
    expect(r.outbound?.mode).toBe("flight");
    expect(r.legs[0].mode).toBe("bus");
    expect(r.inbound?.record).toEqual({ number: "TP1" });
  });

  it("splits totals into flights and ground", () => {
    const r = tripRoute(trip, LPA, [], landmassOf);
    const t = tripTotals(r.all);
    expect(t).toMatchObject({ legs: 3, flights: 2, groundLegs: 1 });
    expect(t.flightCost + t.groundCost).toBe(t.cost);
    expect(t.groundCost).toBe(r.legs[0].cost);
    expect(t.flightHours + t.groundHours).toBeCloseTo(t.hours);
  });

  it("old trips with no itinerary fields still route", () => {
    const legs = tripLegs([LPA, LIS, BER]);
    expect(legs.map((l) => l.mode)).toEqual(["flight", "flight"]);
    expect(legs.every((l) => l.modeIsDefault && !l.record)).toBe(true);
  });

  it("maps a leg to where its plan is stored", () => {
    expect(legPlanSlot(OUTBOUND_LEG)).toBe(0);
    expect(legPlanSlot(0)).toBe(1);
    expect(legPlanSlot(RETURN_LEG)).toBe("home");
  });
});
