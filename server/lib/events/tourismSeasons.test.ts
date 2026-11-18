import { describe, it, expect, beforeAll } from "vitest";
import type { City } from "../../../src/types";
import { getCities, loadCities } from "../cities";
import { tourismSeasonEvents, PEAK_BUSYNESS, SHOULDER_COMFORT, type SeasonInputs } from "./tourismSeasons";
import { tourismSeasonSource } from "./computed";

const city = (id: string): City => ({ id, name: id, country: "Testland", lat: 0, lng: 0, population: 1 });

/** A summer-peak city: busy June to August, mild shoulder months either side, cold winter. */
const BUSY = [10, 10, 25, 45, 70, 90, 100, 95, 60, 40, 15, 10];
const COMFORT = [20, 25, 40, 62, 75, 85, 90, 88, 78, 55, 30, 20];

function inputs(over: Partial<SeasonInputs> = {}): SeasonInputs {
  return {
    cities: [city("a"), city("b")],
    busyness: (id, m) => (id === "a" ? BUSY[m - 1] : undefined),
    comfort: (id) => (id === "a" ? COMFORT : undefined),
    granularity: () => "region",
    ...over,
  };
}

describe("tourism seasons from measured busyness", () => {
  it("makes one peak season over the months at 80 or more, with kind season and the peak-season tag", () => {
    const r = tourismSeasonEvents(inputs());
    const peak = r.events.find((e) => e.id === "season-peak-a")!;
    expect(peak).toMatchObject({ title: "Peak season", kind: "season", cityIds: ["a"], month: 6, months: [6, 7, 8], recurring: true, tags: ["peak-season"], source: "meridian", feed: "tourism-seasons" });
    expect(PEAK_BUSYNESS).toBe(80);
    expect(peak.note).toContain("region level");
  });

  it("makes one shoulder season over the comfortable months next to the peak", () => {
    const shoulder = tourismSeasonEvents(inputs()).events.find((e) => e.id === "season-shoulder-a")!;
    // May (comfort 75) and September (78) touch the peak; April (62) does not touch it, October (55) is not comfortable.
    expect(shoulder).toMatchObject({ title: "Shoulder season", kind: "season", months: [5, 9], month: 5, tags: ["shoulder-season"] });
    expect(SHOULDER_COMFORT).toBe(60);
  });

  it("emits nothing for a city with no measured busyness, and counts the ones that have it", () => {
    const r = tourismSeasonEvents(inputs());
    expect(r.measuredCities).toBe(1);
    expect(r.events.every((e) => e.cityIds[0] === "a")).toBe(true);
    expect(tourismSeasonEvents(inputs({ busyness: () => undefined })).events).toEqual([]);
  });

  it("makes a peak season but no shoulder season when the climate is unknown", () => {
    const r = tourismSeasonEvents(inputs({ comfort: () => undefined }));
    expect(r.events.map((e) => e.id)).toEqual(["season-peak-a"]);
    expect(r.withShoulder).toBe(0);
  });

  it("makes no shoulder season when no month beside the peak is comfortable", () => {
    const r = tourismSeasonEvents(inputs({ comfort: () => new Array(12).fill(40) }));
    expect(r.events.map((e) => e.id)).toEqual(["season-peak-a"]);
  });

  it("wraps a winter peak across the new year", () => {
    const winter = [90, 95, 60, 30, 20, 10, 10, 10, 15, 30, 70, 100];
    const r = tourismSeasonEvents(inputs({ busyness: (id, m) => (id === "a" ? winter[m - 1] : undefined) }));
    const peak = r.events.find((e) => e.id === "season-peak-a")!;
    expect(peak.months).toEqual([12, 1, 2]);
    expect(peak.month).toBe(12);
  });

  it("makes no peak when every month is as busy as the peak or none is", () => {
    expect(tourismSeasonEvents(inputs({ busyness: () => 100 })).events).toEqual([]);
    expect(tourismSeasonEvents(inputs({ busyness: () => 50 })).events).toEqual([]);
  });

  it("does not use a comfort-curve proxy: a city with only a partial busyness curve gets nothing", () => {
    expect(tourismSeasonEvents(inputs({ busyness: (id, m) => (id === "a" && m < 12 ? BUSY[m - 1] : undefined) })).events).toEqual([]);
  });
});

describe("the real wiring over Meridian's place data", () => {
  beforeAll(() => loadCities());

  it("derives events for the cities that have measured nights and reports how many", () => {
    const r = tourismSeasonSource.compute();
    const measured = Number(r.detail.measuredCities);
    expect(measured).toBeGreaterThan(0);
    expect(measured).toBeLessThanOrEqual(getCities().length);
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.events.every((e) => e.kind === "season" && (e.tags[0] === "peak-season" || e.tags[0] === "shoulder-season"))).toBe(true);
    expect(r.events.length).toBeLessThanOrEqual(measured * 2);
  });
});
