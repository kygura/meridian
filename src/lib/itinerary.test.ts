import { describe, expect, it } from "vitest";
import {
  addDays,
  cleanLegPlan,
  cleanLink,
  cleanLodging,
  cleanNodeItinerary,
  dayByDay,
  daysBetween,
  hasItinerary,
  itineraryDays,
  legDate,
  nightsText,
  planOnlyNode,
  stopNights,
  tripCosts,
  validateItinerary,
} from "./itinerary";
import { tripRoute } from "./legs";
import type { Trip, TripNode } from "../types";

const HOME: TripNode = { cityId: "lpa", name: "Las Palmas", iata: "LPA", lat: 28.1, lng: -15.43 };
const LIS: TripNode = { cityId: "lis", name: "Lisbon", iata: "LIS", lat: 38.72, lng: -9.14 };
const OPO: TripNode = { cityId: "opo", name: "Porto", iata: "OPO", lat: 41.15, lng: -8.61 };
const ZONES: Record<string, string> = { lpa: "Atlantic/Canary", lis: "Europe/Lisbon", opo: "Europe/Lisbon", nyc: "America/New_York" };
const zoneOf = (id: string) => ZONES[id];

const trip = (nodes: TripNode[], extra: Partial<Trip> = {}): Trip => ({
  id: "t1",
  name: "Portugal",
  color: "#0f766e",
  status: "draft",
  nodes,
  year: 2027,
  ...extra,
});
const route = (t: Trip) => tripRoute(t, HOME);
const messages = (t: Trip) => validateItinerary(t, route(t), zoneOf).map((i) => `${i.level}: ${i.message}`);

describe("dates", () => {
  it("derives nights from the dates", () => {
    expect(stopNights({ arrive: "2027-03-01", depart: "2027-03-08" })).toBe(7);
    expect(stopNights({ arrive: "2027-03-01", depart: "2027-03-01" })).toBe(0);
    expect(stopNights({ arrive: "2027-03-08", depart: "2027-03-01" })).toBeNull();
    expect(stopNights({ arrive: "2027-03-01" })).toBeNull();
    expect(stopNights({ arrive: "2027-02-30", depart: "2027-03-01" })).toBeNull();
    expect(nightsText(1)).toBe("1 night");
    expect(nightsText(0)).toBe("day visit");
  });

  it("adds days across months and leap years", () => {
    expect(addDays("2028-02-28", 2)).toBe("2028-03-01");
    expect(daysBetween("2027-12-30", "2028-01-02")).toBe(3);
  });
});

describe("validateItinerary", () => {
  it("accepts an ordered itinerary, and a trip with no dates at all", () => {
    const ok = trip([
      { ...LIS, arrive: "2027-03-01", depart: "2027-03-05" },
      { ...OPO, arrive: "2027-03-05", depart: "2027-03-09" },
    ]);
    expect(messages(ok)).toEqual([]);
    expect(messages(trip([LIS, OPO]))).toEqual([]);
    expect(messages(trip([LIS, OPO], { year: undefined }))).toEqual([]);
  });

  it("flags leaving before arriving", () => {
    expect(messages(trip([{ ...LIS, arrive: "2027-03-05", depart: "2027-03-01" }]))[0]).toMatch(/^error: Lisbon: you leave .* before you arrive/);
  });

  it("flags stops that overlap, even across an undated stop", () => {
    const t = trip([{ ...LIS, arrive: "2027-03-01", depart: "2027-03-10" }, { ...HOME, cityId: "x", name: "Coimbra" }, { ...OPO, arrive: "2027-03-08", depart: "2027-03-12" }]);
    expect(messages(t)).toEqual([expect.stringMatching(/^error: Porto starts on .*8 Mar 2027, before you leave Lisbon on .*10 Mar 2027/)]);
  });

  it("warns about half-set dates and dates outside the stop's months", () => {
    expect(messages(trip([{ ...LIS, arrive: "2027-03-01" }]))).toEqual(["warning: Lisbon has an arrival date but no departure date."]);
    const off = trip([{ ...LIS, months: { start: 3, end: 3 }, arrive: "2027-04-02", depart: "2027-04-05" }]);
    expect(messages(off)[0]).toMatch(/^warning: Lisbon: the dates fall outside the months/);
  });

  it("checks the stay and activities against the stop", () => {
    const t = trip([
      {
        ...LIS,
        arrive: "2027-03-01",
        depart: "2027-03-05",
        lodging: { name: "Casa", checkIn: "2027-02-27", checkOut: "2027-03-05" },
        activities: [
          { id: "a", title: "Fado night", date: "2027-03-03" },
          { id: "b", title: "Late tour", date: "2027-03-09" },
        ],
      },
    ]);
    expect(messages(t)).toEqual([
      "warning: Casa in Lisbon is booked for dates outside your time there.",
      expect.stringMatching(/^warning: "Late tour" is on .*9 Mar 2027, outside your time in Lisbon/),
    ]);
    const bad = trip([{ ...LIS, lodging: { name: "Casa", checkIn: "2027-03-05", checkOut: "2027-03-01" } }]);
    expect(messages(bad)).toEqual(["error: Casa in Lisbon: check-out is before check-in."]);
  });

  it("compares a recorded leg's times as instants, across time zones", () => {
    const nyc: TripNode = { cityId: "nyc", name: "New York", iata: "JFK", lat: 40.7, lng: -74 };
    // Leaves Lisbon 17:00, lands New York 20:00 local: 8 hours later, not 3.
    const fine = trip([LIS, { ...nyc, travel: { fromCityId: "lis", booked: { departAt: "2027-03-05T17:00", arriveAt: "2027-03-05T20:00" } } }]);
    expect(messages(fine)).toEqual([]);
    // Eastbound the clock runs ahead: "arrives 12:30 after leaving 13:00" is impossible.
    const bad = trip([nyc, { ...LIS, travel: { fromCityId: "nyc", booked: { departAt: "2027-03-05T13:00", arriveAt: "2027-03-05T12:30" } } }]);
    expect(messages(bad)).toEqual(["error: New York to Lisbon: the recorded arrival is not after the departure."]);
  });

  it("warns when a recorded leg doesn't match the stop dates", () => {
    const t = trip([
      { ...LIS, arrive: "2027-03-01", depart: "2027-03-05" },
      { ...OPO, arrive: "2027-03-05", depart: "2027-03-09", travel: { fromCityId: "lis", booked: { departAt: "2027-03-06T09:00", arriveAt: "2027-03-06T12:00" } } },
    ]);
    expect(messages(t)).toEqual([
      expect.stringMatching(/^warning: Lisbon to Porto leaves on .*6 Mar 2027, but Lisbon ends on .*5 Mar 2027/),
      expect.stringMatching(/^warning: Lisbon to Porto arrives on .*6 Mar 2027, but Porto starts on .*5 Mar 2027/),
    ]);
  });
});

describe("day by day", () => {
  const t = trip([
    {
      ...LIS,
      arrive: "2027-03-01",
      depart: "2027-03-06",
      lodging: { name: "Casa do Bairro", address: "Rua A 1", bookingRef: "HX9" },
      activities: [
        { id: "b", title: "Dinner", date: "2027-03-02", time: "20:00" },
        { id: "a", title: "Tram 28", date: "2027-03-02", time: "10:30" },
      ],
      travel: { fromCityId: "lpa", booked: { carrier: "TAP", number: "TP1117", departAt: "2027-03-01T07:10", arriveAt: "2027-03-01T10:25" } },
    },
    { ...OPO, arrive: "2027-03-06", depart: "2027-03-08" },
  ]);

  it("puts legs, check-ins and activities on their days, in time order", () => {
    const days = itineraryDays(t, route(t));
    expect(days[0]).toMatchObject({ date: "2027-03-01", places: ["Lisbon"] });
    expect(days[0].items.map((i) => `${i.time ?? ""} ${i.title}`)).toEqual(["07:10 Flight to Lisbon · TAP TP1117", " Check in: Casa do Bairro"]);
    expect(days[0].items[0]).toMatchObject({ booked: true, detail: "Arrives 10:25" });
    expect(days[1].items.map((i) => i.title)).toEqual(["Tram 28", "Dinner"]);
    // The travel day belongs to both places.
    const travel = days.find((d) => d.date === "2027-03-06")!;
    expect(travel.places).toEqual(["Lisbon", "Porto"]);
    expect(travel.items.map((i) => i.title)).toEqual(["Check out: Casa do Bairro", "Train to Porto"]);
    expect(travel.items[1].booked).toBe(false);
    expect(days[days.length - 1].date).toBe("2027-03-08");
  });

  it("folds quiet days in one place into a single row", () => {
    const { groups, undated } = dayByDay(t, route(t));
    expect(undated).toEqual([]);
    const quiet = groups.find((g) => g.days > 1)!;
    expect(quiet).toMatchObject({ from: "2027-03-03", to: "2027-03-05", days: 3, places: ["Lisbon"], items: [] });
  });

  it("lists stops without dates and survives a trip with none", () => {
    const none = trip([LIS, OPO]);
    expect(dayByDay(none, route(none))).toEqual({ groups: [], undated: [0, 1] });
    expect(hasItinerary(none)).toBe(false);
    expect(hasItinerary(t)).toBe(true);
  });

  it("dates a leg from its record, else from the stops", () => {
    const r = route(t);
    expect(legDate(t, r.outbound!)).toBe("2027-03-01");
    expect(legDate(t, r.legs[0])).toBe("2027-03-06");
    expect(legDate(t, r.inbound!)).toBe("2027-03-08");
  });
});

describe("tripCosts", () => {
  it("keeps entered prices per currency and estimates only what has none", () => {
    const t = trip([
      { ...LIS, arrive: "2027-03-01", depart: "2027-03-05", lodging: { name: "Casa", cost: { amount: 400, currency: "EUR" } }, travel: { fromCityId: "lpa", booked: { cost: { amount: 120, currency: "EUR" } } } },
      { ...OPO, arrive: "2027-03-05", depart: "2027-03-09", activities: [{ id: "a", title: "Port tasting", cost: { amount: 30, currency: "USD" } }] },
    ]);
    const r = route(t);
    const c = tripCosts(t, r);
    expect(c.transportEntered).toEqual({ EUR: 120 });
    expect(c.flightEstimate).toBe(r.inbound!.cost);
    expect(c.groundEstimate).toBe(r.legs[0].cost);
    expect(c.lodgingEntered).toEqual({ EUR: 400 });
    expect(c.lodgingMissing).toEqual([1]);
    expect(c.activitiesEntered).toEqual({ USD: 30 });
  });
});

describe("cleaning", () => {
  it("keeps valid itinerary fields and drops malformed ones", () => {
    const clean = cleanNodeItinerary({
      arrive: "2027-03-01",
      depart: "nope",
      lodging: { name: " Casa ", cost: { amount: 400, currency: "eur" }, link: "javascript:alert(1)", checkIn: "2027-13-01" },
      activities: [{ id: "a", title: "Tour", time: "25:00" }, { title: "no id" }, "junk"],
      notes: "  ",
      travel: { fromCityId: "lpa", mode: "rocket", booked: { reference: "ABC", departAt: "2027-03-01 07:10" } },
    });
    expect(clean).toEqual({
      arrive: "2027-03-01",
      lodging: { name: "Casa", cost: { amount: 400, currency: "EUR" } },
      activities: [{ id: "a", title: "Tour" }],
      travel: { fromCityId: "lpa", booked: { reference: "ABC" } },
    });
  });

  it("returns nothing for an old stop with no itinerary", () => {
    expect(cleanNodeItinerary({ cityId: "lis", name: "Lisbon", lat: 1, lng: 2, months: { start: 2, end: 3 } })).toEqual({});
    expect(cleanLodging({ address: "no name" })).toBeUndefined();
    expect(cleanLegPlan({ fromCityId: "lis" })).toBeUndefined();
  });

  it("only lets http(s) links through", () => {
    expect(cleanLink("https://example.com/x?y=1")).toBe("https://example.com/x?y=1");
    expect(cleanLink("data:text/html,hi")).toBeUndefined();
    expect(cleanLink("example.com")).toBeUndefined();
  });

  it("copies a stop as a plan: place, months and mode, without one year's bookings", () => {
    const n: TripNode = {
      ...LIS,
      months: { start: 3, end: 3 },
      arrive: "2027-03-01",
      depart: "2027-03-05",
      lodging: { name: "Casa", bookingRef: "HX9" },
      activities: [{ id: "a", title: "Tour" }],
      notes: "door code 1234",
      travel: { fromCityId: "lpa", mode: "ferry", booked: { reference: "ABC" } },
    };
    expect(planOnlyNode(n)).toEqual({ ...LIS, months: { start: 3, end: 3 }, travel: { fromCityId: "lpa", mode: "ferry" } });
    expect(planOnlyNode({ ...LIS, travel: { fromCityId: "lpa", booked: { reference: "ABC" } } })).toEqual(LIS);
  });
});
