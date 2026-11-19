import { describe, it, expect } from "vitest";
import type { City } from "../../../src/types";
import { climateSeasonEvents, longestRun, type MonthNormal } from "./climateSeasons";

const city = (id: string): City => ({ id, name: id, country: "X", lat: 0, lng: 0, population: 1, iata: "AAA" }) as unknown as City;
const normals = (temps: number[], precip: number[]): MonthNormal[] => temps.map((t, i) => ({ tempC: t, precipMm: precip[i]! }));
const flat = (v: number) => new Array(12).fill(v) as number[];

describe("longestRun", () => {
  const f = (...months: number[]) => Array.from({ length: 12 }, (_, i) => months.includes(i + 1));
  it("finds a run that wraps the year", () => {
    expect(longestRun(f(11, 12, 1, 2), flat(1))).toEqual([11, 12, 1, 2]);
  });
  it("takes the longest of several runs, and the heavier one on a tie", () => {
    expect(longestRun(f(1, 2, 6, 7, 8), flat(1))).toEqual([6, 7, 8]);
    expect(longestRun(f(2, 3, 8, 9), [0, 1, 1, 0, 0, 0, 0, 5, 5, 0, 0, 0])).toEqual([8, 9]);
  });
  it("is undefined for no month and for every month", () => {
    expect(longestRun(f(), flat(1))).toBeUndefined();
    expect(longestRun(f(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), flat(1))).toBeUndefined();
  });
});

describe("climateSeasonEvents", () => {
  it("makes a rainy and a dry season for a monsoon climate, wrapping nothing", () => {
    // Mean 125 mm: June to September are at or above 225 mm (1.8x), January to March at or under 37 mm (0.3x).
    const precip = [10, 10, 15, 50, 120, 300, 320, 310, 250, 100, 20, 15];
    const r = climateSeasonEvents({ cities: [city("a")], normals: () => normals(flat(25), precip) });
    expect(r).toMatchObject({ citiesWithNormals: 1, rainy: 1, dry: 1, snow: 0 });
    const rainy = r.events.find((e) => e.id === "climate-rainy-a")!;
    expect(rainy).toMatchObject({ title: "Rainy season", kind: "season", month: 6, months: [6, 7, 8, 9], recurring: true, source: "meridian", feed: "climate-seasons" });
    const dry = r.events.find((e) => e.id === "climate-dry-a")!;
    expect(dry).toMatchObject({ title: "Dry season", months: [11, 12, 1, 2, 3] });
  });

  it("needs 120 mm as well as 1.8 times the mean: a dry climate gets no rainy season", () => {
    const precip = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 30, 30];
    const r = climateSeasonEvents({ cities: [city("a")], normals: () => normals(flat(20), precip) });
    expect(r.events).toHaveLength(0);
  });

  it("makes no dry season where there is no rainy season", () => {
    const precip = [50, 50, 50, 50, 5, 5, 5, 5, 50, 50, 50, 50];
    const r = climateSeasonEvents({ cities: [city("a")], normals: () => normals(flat(15), precip) });
    expect(r.events).toHaveLength(0);
  });

  it("makes a snow season over the cold wet months, across the new year", () => {
    const temps = [-4, -2, 3, 9, 14, 18, 20, 19, 14, 8, 2, -1];
    const precip = [30, 25, 40, 50, 60, 70, 70, 60, 50, 45, 40, 35];
    const r = climateSeasonEvents({ cities: [city("a")], normals: () => normals(temps, precip) });
    expect(r.events.map((e) => e.id)).toEqual(["climate-snow-a"]);
    expect(r.events[0]).toMatchObject({ title: "Snow season", month: 12, months: [12, 1, 2] });
  });

  it("leaves out a cold month with under 20 mm of precipitation, and keeps the wetter of two separate runs", () => {
    // Cold months: Jan, Feb, Mar, Nov, Dec. Only March (25 mm) and November (30 mm) reach 20 mm.
    const temps = [-10, -8, 0, 8, 14, 18, 20, 19, 14, 8, 0, -8];
    const precip = [10, 12, 25, 40, 60, 70, 70, 60, 50, 40, 30, 15];
    const r = climateSeasonEvents({ cities: [city("a")], normals: () => normals(temps, precip) });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ id: "climate-snow-a", month: 11 });
    expect(r.events[0]!.months).toBeUndefined();
  });

  it("skips cities without twelve normals and counts the ones it tested", () => {
    const r = climateSeasonEvents({ cities: [city("a"), city("b"), city("c")], normals: (id) => (id === "a" ? undefined : id === "b" ? normals(flat(20), flat(60)).slice(0, 11) : normals(flat(20), flat(60))) });
    expect(r).toMatchObject({ citiesWithNormals: 1, events: [] });
  });
});
