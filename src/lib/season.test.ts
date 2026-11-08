import { describe, expect, it } from "vitest";
import type { Trip, TripNode } from "../types";
import {
  datedSpan,
  legDepartureHint,
  seasonText,
  spanLabel,
  spanMonths,
  stopComfort,
  stopDates,
  stopEvents,
  tripSeason,
  upcomingYears,
  withMonths,
  type SeasonEvent,
} from "./season";

const node = (cityId: string, start?: number, end = start): TripNode => ({
  cityId,
  name: cityId,
  lat: 0,
  lng: 0,
  ...(start ? { months: { start, end: end! } } : {}),
});
const trip = (nodes: TripNode[], extra: Partial<Trip> = {}): Trip => ({
  id: "t",
  name: "T",
  color: "#000",
  status: "draft",
  nodes,
  ...extra,
});

describe("spans", () => {
  it("lists months in travel order, wrapping the new year", () => {
    expect(spanMonths({ start: 2, end: 4 })).toEqual([2, 3, 4]);
    expect(spanMonths({ start: 11, end: 2 })).toEqual([11, 12, 1, 2]);
    expect(spanMonths({ start: 5, end: 5 })).toEqual([5]);
  });

  it("labels spans", () => {
    expect(spanLabel({ start: 2, end: 7 })).toBe("Feb–Jul");
    expect(spanLabel({ start: 11, end: 2 }, "long")).toBe("November to February");
    expect(spanLabel({ start: 8, end: 8 })).toBe("Aug");
  });
});

describe("trip season", () => {
  it("runs from the first placed stop to the last", () => {
    const t = trip([node("a", 2), node("b"), node("c", 6, 7)]);
    expect(tripSeason(t)).toEqual({ start: 2, end: 7 });
  });

  it("falls back to the trip's own season, then null", () => {
    expect(tripSeason(trip([node("a")], { season: { start: 7, end: 8 } }))).toEqual({ start: 7, end: 8 });
    expect(tripSeason(trip([node("a")]))).toBeNull();
  });

  it("describes itself with or without a year", () => {
    const t = trip([node("a", 2), node("b", 7)]);
    expect(seasonText(t)).toBe("Feb–Jul · any year");
    expect(seasonText({ ...t, year: 2027 })).toBe("Feb–Jul 2027");
    expect(seasonText(trip([node("a", 11), node("b", 2)], { year: 2027 }))).toBe("Nov 2027 – Feb 2028");
  });
});

describe("dates for a year", () => {
  it("dates a span, ending on the month's last day (leap years too)", () => {
    expect(datedSpan({ start: 2, end: 2 }, 2028)).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(datedSpan({ start: 11, end: 2 }, 2027)).toEqual({ start: "2027-11-01", end: "2028-02-29" });
  });

  it("puts stops after the new year into the following year", () => {
    const t = trip([node("a", 11), node("b", 12, 1), node("c", 2), node("d")]);
    expect(stopDates(t, 2027)).toEqual([
      { start: "2027-11-01", end: "2027-11-30" },
      { start: "2027-12-01", end: "2028-01-31" },
      { start: "2028-02-01", end: "2028-02-29" },
      null,
    ]);
  });

  it("hints a leg's departure from the next stop's first day, only with a year", () => {
    const t = trip([node("a", 2), node("b", 3), node("c")]);
    expect(legDepartureHint(t, 0)).toBeUndefined();
    expect(legDepartureHint({ ...t, year: 2027 }, 0)).toBe("2027-03-01");
    expect(legDepartureHint({ ...t, year: 2027 }, 1)).toBeUndefined();
  });

  it("offers the next years the season can still start", () => {
    const now = new Date("2026-11-07T00:00:00Z");
    expect(upcomingYears({ start: 2, end: 7 }, now)).toEqual([2027, 2028, 2029]);
    expect(upcomingYears({ start: 12, end: 2 }, now)).toEqual([2026, 2027, 2028]);
    expect(upcomingYears({ start: 11, end: 2 }, now, 2)).toEqual([2027, 2028]);
  });
});

describe("comfort and events", () => {
  const scores = Array.from({ length: 12 }, (_, i) => ({ score: (i + 1) * 5 }));

  it("averages comfort over a stop's months", () => {
    expect(stopComfort({ start: 2, end: 3 }, scores)).toBe(13); // (10 + 15) / 2, rounded
    expect(stopComfort(undefined, scores)).toBeNull();
    expect(stopComfort({ start: 2, end: 2 }, null)).toBeNull();
  });

  it("matches recurring events by month and dated ones by the chosen year's dates", () => {
    const events: SeasonEvent[] = [
      { id: "songkran", title: "Songkran", kind: "festival", cityIds: ["bkk"], month: 4, recurring: true },
      { id: "tet-2027", title: "Tết", kind: "festival", cityIds: ["han"], month: 2, date: "2027-02-06", recurring: false },
      { id: "tet-2028", title: "Tết", kind: "festival", cityIds: ["han"], month: 1, date: "2028-01-26", recurring: false },
    ];
    expect(stopEvents(node("bkk", 4), events, null).map((e) => e.id)).toEqual(["songkran"]);
    expect(stopEvents(node("bkk", 5), events, null)).toEqual([]);
    const han = node("han", 2);
    expect(stopEvents(han, events, null)).toEqual([]);
    expect(stopEvents(han, events, datedSpan(han.months!, 2027)).map((e) => e.id)).toEqual(["tet-2027"]);
    expect(stopEvents(han, events, datedSpan(han.months!, 2028))).toEqual([]);
  });

  it("sets and clears a node's months", () => {
    const n = withMonths(node("a"), { start: 3, end: 4 });
    expect(n.months).toEqual({ start: 3, end: 4 });
    expect("months" in withMonths(n, undefined)).toBe(false);
  });
});
