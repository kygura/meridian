import { describe, expect, it } from "vitest";
import { countryRegions, regionAt, regionForCountry } from "./worldRegion";

describe("regionAt", () => {
  it.each([
    ["Lisbon", 38.72, -9.14, "europe"],
    ["Berlin", 52.52, 13.4, "europe"],
    ["Mexico City", 19.43, -99.13, "americas"],
    ["Buenos Aires", -34.6, -58.38, "americas"],
    ["Nairobi", -1.29, 36.82, "africa"],
    ["Lagos", 6.45, 3.4, "africa"],
    ["Cape Town", -33.92, 18.42, "africa"],
    ["Dubai", 25.2, 55.27, "middle-east"],
    ["Tokyo", 35.68, 139.69, "asia"],
    ["Bangkok", 13.75, 100.5, "asia"],
    ["Delhi", 28.61, 77.21, "asia"],
    ["Sydney", -33.87, 151.21, "oceania"],
    ["Auckland", -36.85, 174.76, "oceania"],
    ["Suva", -18.14, 178.44, "oceania"],
    ["Papeete", -17.53, -149.57, "oceania"],
  ] as const)("%s", (_name, lat, lng, region) => {
    expect(regionAt(lat, lng)).toBe(region);
  });
});

describe("regionForCountry", () => {
  it("uses overrides for countries the boxes get wrong", () => {
    expect(regionForCountry("Tunisia", 36.8, 10.18)).toBe("africa");
    expect(regionForCountry("Portugal", 37.74, -25.67)).toBe("europe");
    expect(regionForCountry("Russia", 43.1, 131.9)).toBe("europe");
    expect(regionForCountry("Israel", 32.08, 34.78)).toBe("middle-east");
  });
  it("falls back to coordinates", () => {
    expect(regionForCountry("Japan", 35.68, 139.69)).toBe("asia");
  });
});

describe("countryRegions", () => {
  it("places a country by its capital, so it never splits", () => {
    const m = countryRegions([
      { country: "United States", lat: 21.3, lng: -157.8, population: 1 },
      { country: "France", lat: -21.1, lng: 55.5, population: 5 },
      { country: "France", lat: 48.85, lng: 2.35, population: 2, capital: true },
    ]);
    expect(m.get("France")).toBe("europe");
    expect(m.get("United States")).toBe("americas");
  });
});
