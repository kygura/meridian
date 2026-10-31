import { describe, it, expect } from "vitest";
import { searchCities } from "./citySearch";
import type { City } from "../types";

const city = (id: string, name: string, country: string, population: number, iata?: string, airportName?: string): City => ({
  id,
  name,
  country,
  population,
  lat: 0,
  lng: 0,
  iata,
  airportName,
});

const cities = [
  city("lis", "Lisbon", "Portugal", 500_000, "LIS", "Humberto Delgado Airport"),
  city("por", "Porto", "Portugal", 230_000, "OPO"),
  city("big", "Portland", "United States", 650_000),
  city("ams", "Amsterdam", "Netherlands", 900_000, "AMS", "Schiphol"),
];

describe("searchCities", () => {
  it("needs two characters", () => {
    expect(searchCities(cities, "l")).toEqual([]);
  });
  it("ranks airport cities first, then by population", () => {
    expect(searchCities(cities, "port").map((c) => c.id)).toEqual(["lis", "por", "big"]);
  });
  it("matches exact IATA and airport names", () => {
    expect(searchCities(cities, "opo").map((c) => c.id)).toEqual(["por"]);
    expect(searchCities(cities, "schiphol").map((c) => c.id)).toEqual(["ams"]);
  });
  it("skips excluded ids", () => {
    expect(searchCities(cities, "port", 8, new Set(["lis"])).map((c) => c.id)).toEqual(["por", "big"]);
  });
});
