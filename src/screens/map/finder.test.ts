import { describe, it, expect } from "vitest";
import { conflictCountries, metricColours, newsAnomalyData, runFinder, seedAnomalyData } from "./finder";
import type { ClimateMonth } from "../../lib/climate";
import type { City, MapAnomaly } from "../../types";

const city = (id: string, country: string, population = 1000, capital = false): City => ({
  id,
  name: id,
  country,
  lat: 0,
  lng: 0,
  population,
  capital,
});
const flat = (tempC: number, precipMm: number, score: number): ClimateMonth[] =>
  Array.from({ length: 12 }, () => ({ score, tempC, precipMm }));

const cities = [city("hot-dry", "Spain", 500), city("hot-dry-2", "Ukraine", 900), city("cold-wet", "Norway"), city("no-data", "Spain")];
const climateData = { "hot-dry": flat(29, 5, 70), "hot-dry-2": flat(29, 5, 80), "cold-wet": flat(3, 150, 20) };
const base = { cities, month: 7, climateData, thresholds: [], metricIndex: {}, excluded: null };

describe("runFinder", () => {
  it("is idle with no filter", () => {
    const r = runFinder({ ...base, climate: { conditions: [], minComfort: 0 } });
    expect(r.filtering).toBe(false);
    expect(r.matches.size).toBe(0);
  });

  it("matches climate conditions and ranks by comfort", () => {
    const r = runFinder({ ...base, climate: { conditions: ["warmth:hot", "wetness:arid"], minComfort: 0 } });
    expect(r.ranked.map((h) => h.city.id)).toEqual(["hot-dry-2", "hot-dry"]);
  });

  it("waits for climate data before matching", () => {
    const r = runFinder({ ...base, climateData: null, climate: { conditions: ["warmth:hot"], minComfort: 0 } });
    expect(r.pending).toBe(true);
    expect(r.matches.size).toBe(0);
  });

  it("drops excluded countries and applies metric thresholds", () => {
    const metricIndex = { stability: new Map([["hot-dry", 90], ["hot-dry-2", 95], ["cold-wet", 40]]) };
    const r = runFinder({
      ...base,
      climate: null,
      thresholds: [["stability", 60]],
      metricIndex,
      excluded: new Set(["ukraine"]),
    });
    expect([...r.matches]).toEqual(["hot-dry"]);
  });
});

describe("anomaly feeds", () => {
  const items: MapAnomaly[] = [
    { id: "c", kind: "conflict", label: "War", country: "Ukraine", lat: 1, lng: 2, severity: 3 },
    { id: "h", kind: "hazard", label: "Storms", lat: 1, lng: 2, severity: 2, months: [8, 9, 10], peak: [9] },
  ];

  it("labels seed items and flags peak months", () => {
    const [c, h] = seedAnomalyData(items, 9);
    expect(c.source).toBe("conflict");
    expect(h.sub).toBe("Seasonal hazard · Aug–Oct · peak now");
    expect(h.peak).toBe(true);
    expect(conflictCountries(items).has("ukraine")).toBe(true);
  });

  it("places alert headlines on the capital, one marker per country", () => {
    const caps = [city("kyiv", "Ukraine", 1, true), city("tokyo", "Japan", 1, true)];
    const out = newsAnomalyData(
      [
        { glyph: "alert", location: "UKRAINE", text: "a", time: "1m" },
        { glyph: "hazard", location: "UKRAINE", text: "b", time: "2m" },
        { glyph: "info", location: "JAPAN", text: "c", time: "3m" },
        { glyph: "alert", location: "WORLD", text: "d", time: "4m" },
      ],
      caps
    );
    expect(out).toHaveLength(1);
    expect(out[0].cityId).toBe("kyiv");
    expect(out[0].severity).toBe(2);
    expect(out[0].sub).toContain("2 headlines");
  });
});

describe("metricColours", () => {
  it("inverts crowds so higher is always better", () => {
    const idx = { tourism: new Map([["a", 80]]) };
    expect(metricColours(idx, "tourism")!.get("a")).toBe(20);
    expect(metricColours(idx, "none")).toBeNull();
  });
});
