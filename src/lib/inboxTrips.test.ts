import { describe, expect, it } from "vitest";
import { bookingDay, isFutureBooking, tripOffers } from "./inboxTrips";
import type { City, ImportCandidate, Trip, TripNode } from "../types";

const city = (id: string, iata: string): City => ({ id, name: id[0].toUpperCase() + id.slice(1), iata, country: "PT", lat: 1, lng: 2, population: 1 }) as City;
const cities = new Map([city("lisbon", "LIS"), city("porto", "OPO"), city("las-palmas", "LPA")].map((c) => [c.id, c]));
const node = (id: string, extra: Partial<TripNode> = {}): TripNode => ({ cityId: id, name: id, lat: 0, lng: 0, ...extra });
const home = node("las-palmas");
const trip = (over: Partial<Trip> = {}): Trip => ({ id: "t1", name: "Iberia", color: "#000", status: "draft", nodes: [node("lisbon"), node("porto")], year: 2027, ...over });
const base = { id: "c", provenance: { source: "gmail", confidence: "medium" }, state: "pending", createdAt: "2026-11-01T00:00:00Z" } as const;
const stay = (over = {}): ImportCandidate => ({ ...base, kind: "lodging", payload: { name: "Hotel X", cityId: "lisbon", arrive: "2027-03-10", depart: "2027-03-14", cost: { amount: 400, currency: "EUR" }, ...over } }) as ImportCandidate;
const flight = (over = {}): ImportCandidate =>
  ({ ...base, kind: "segment", payload: { mode: "flight", fromCityId: "las-palmas", toCityId: "lisbon", carrier: "TAP", number: "TP1", bookingRef: "ABC123", departAt: "2027-03-10T09:05:00+00:00", arriveAt: "2027-03-10T12:35:00+00:00", ...over } }) as ImportCandidate;
const TODAY = "2026-11-10";

describe("future bookings", () => {
  it("only pending bookings dated today or later are offered", () => {
    expect(bookingDay(stay())).toBe("2027-03-10");
    expect(isFutureBooking(stay(), TODAY)).toBe(true);
    expect(isFutureBooking(stay({ arrive: "2026-10-01" }), TODAY)).toBe(false);
    expect(isFutureBooking({ ...stay(), state: "accepted" }, TODAY)).toBe(false);
    expect(tripOffers({ ...base, kind: "experience", payload: { title: "x", date: "2027-01-01", cityId: "lisbon" } } as ImportCandidate, [trip()], cities, TODAY, home)).toEqual([]);
  });
});

describe("stays", () => {
  it("offers the stop in that city of a trip planned for that year, and a new trip", () => {
    const offers = tripOffers(stay(), [trip(), trip({ id: "t2", year: 2028 })], cities, TODAY, home);
    expect(offers.map((o) => o.type)).toEqual(["stay", "stay-new"]);
    const s = offers[0];
    if (s.type !== "stay") throw new Error();
    expect(s).toMatchObject({ tripId: "t1", stopIndex: 0 });
    expect(s.patch).toEqual({ arrive: "2027-03-10", depart: "2027-03-14", lodging: { name: "Hotel X", checkIn: "2027-03-10", checkOut: "2027-03-14", cost: { amount: 400, currency: "EUR" } } });
    const n = offers[1];
    if (n.type !== "stay-new") throw new Error();
    expect(n).toMatchObject({ year: 2027, months: { start: 3, end: 3 }, node: { cityId: "lisbon", iata: "LIS" } });
  });
  it("does not overwrite a stop that already has a stay", () => {
    const t = trip({ nodes: [node("lisbon", { lodging: { name: "Mine" } }), node("porto")] });
    expect(tripOffers(stay(), [t], cities, TODAY, home).map((o) => o.type)).toEqual(["stay-new"]);
  });
  it("offers nothing for an unresolved city", () => {
    expect(tripOffers(stay({ cityId: undefined, cityHint: "Nowhere" }), [trip()], cities, TODAY, home)).toEqual([]);
  });
});

describe("transport", () => {
  it("records the booking on the leg from the departure to the first stop, with local times", () => {
    const [o] = tripOffers(flight(), [trip()], cities, TODAY, home);
    expect(o).toMatchObject({ type: "leg", tripId: "t1", slot: 0, plan: { fromCityId: "las-palmas", mode: "flight", booked: { carrier: "TAP", number: "TP1", reference: "ABC123", departAt: "2027-03-10T09:05", arriveAt: "2027-03-10T12:35" } } });
  });
  it("only fits a leg that really runs between those cities, and not one already booked", () => {
    expect(tripOffers(flight({ fromCityId: "porto" }), [trip()], cities, TODAY, home)).toEqual([]);
    expect(tripOffers(flight({ fromCityId: "lisbon", toCityId: "porto" }), [trip()], cities, TODAY, home)).toHaveLength(1);
    const booked = trip({ nodes: [node("lisbon", { travel: { fromCityId: "las-palmas", booked: { number: "X" } } }), node("porto")] });
    expect(tripOffers(flight(), [booked], cities, TODAY, home)).toEqual([]);
  });
  it("maps car to drive and skips modes a leg cannot hold", () => {
    expect(tripOffers(flight({ mode: "car" }), [trip()], cities, TODAY, home)[0]).toMatchObject({ plan: { mode: "drive" } });
    expect(tripOffers(flight({ mode: "other" }), [trip()], cities, TODAY, home)).toEqual([]);
  });
});
