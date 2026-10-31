import { describe, it, expect } from "vitest";
import { buildJourneyArcs, emphasis, journeyYears, scrubArcs, type ArcCity } from "./journeyArcs";
import type { Journey } from "../types";

const CITIES: Record<string, ArcCity> = {
  lis: { name: "Lisbon", iata: "LIS", lat: 38.77, lng: -9.13 },
  opo: { name: "Porto", iata: "OPO", lat: 41.24, lng: -8.68 },
  mad: { name: "Madrid", iata: "MAD", lat: 40.49, lng: -3.57 },
};
const cityOf = (id: string) => CITIES[id];
const prov = { source: "manual" as const, confidence: "high" as const };

function journey(id: string, over: Partial<Journey>): Journey {
  return {
    id,
    title: id,
    status: "confirmed",
    startDate: "2024-05-14",
    endDate: "2024-05-20",
    stops: [],
    segments: [],
    experiences: [],
    tags: [],
    bookingIds: [],
    provenance: prov,
    createdAt: "",
    updatedAt: "",
    ...over,
  } as Journey;
}

const j24 = journey("a", {
  segments: [{ mode: "flight", fromCityId: "lis", toCityId: "opo", departAt: "2024-05-14T09:00", number: "TP1023", provenance: prov }],
  stops: [{ cityId: "opo", arrive: "2024-05-14", depart: "2024-05-20" }],
});
const j25 = journey("b", {
  startDate: "2025-12-30",
  segments: [{ mode: "train", fromCityId: "opo", toCityId: "mad", departAt: "2025-12-30", provenance: prov }],
  stops: [{ cityId: "mad", arrive: "2025-12-30", depart: "2026-01-03" }],
});

describe("buildJourneyArcs", () => {
  it("builds one arc per segment with 1-based month and year", () => {
    const { arcs } = buildJourneyArcs([j24, j25], cityOf);
    expect(arcs).toHaveLength(2);
    expect(arcs[0]).toMatchObject({ journeyId: "a", mode: "flight", fromName: "Lisbon", toName: "Porto", year: 2024, month: 5, date: "2024-05-14", number: "TP1023" });
    expect(arcs[1]).toMatchObject({ mode: "train", year: 2025, month: 12 });
    expect(arcs[1].paths).toHaveLength(1);
  });

  it("skips drafts and segments with unknown cities", () => {
    const bad = journey("c", { segments: [{ mode: "bus", fromCityId: "lis", toCityId: "nowhere", departAt: "2024-01-01", provenance: prov }] });
    const set = buildJourneyArcs([bad, { ...j24, status: "draft" }], cityOf);
    expect(set.arcs).toHaveLength(0);
    expect(set.stops).toHaveLength(0);
  });

  it("falls back to the journey start date when departAt is not a date", () => {
    const j = journey("d", { startDate: "2024-03-02", segments: [{ mode: "car", fromCityId: "lis", toCityId: "opo", departAt: "", provenance: prov }] });
    expect(buildJourneyArcs([j], cityOf).arcs[0]).toMatchObject({ date: "2024-03-02", month: 3 });
  });

  it("folds a stay across months and years", () => {
    const { stops } = buildJourneyArcs([j25], cityOf);
    expect(stops[0]).toMatchObject({ label: "MAD", year: 2025, months: [12, 1] });
  });
});

describe("emphasis / scrubArcs", () => {
  it("chrono: ALL, current year, earlier faded, later hidden", () => {
    expect(emphasis(2024, [5], { mode: "chrono" })).toBe("normal");
    expect(emphasis(2024, [5], { mode: "chrono", year: 2024 })).toBe("hi");
    expect(emphasis(2023, [5], { mode: "chrono", year: 2024 })).toBe("faded");
    expect(emphasis(2025, [5], { mode: "chrono", year: 2024 })).toBeNull();
  });

  it("season: folds all years, only the month draws", () => {
    expect(emphasis(2019, [5], { mode: "season", month: 5 })).toBe("hi");
    expect(emphasis(2024, [5], { mode: "season", month: 6 })).toBeNull();
    expect(emphasis(2024, [5], { mode: "season" })).toBe("normal");
  });

  it("filters a built set", () => {
    const set = buildJourneyArcs([j24, j25], cityOf);
    expect(scrubArcs(set, { mode: "chrono", year: 2024 }).arcs.map((a) => a.journeyId)).toEqual(["a"]);
    expect(scrubArcs(set, { mode: "season", month: 1 }).arcs).toHaveLength(0);
    expect(scrubArcs(set, { mode: "season", month: 1 }).stops.map((s) => s.label)).toEqual(["MAD"]);
  });
});

describe("journeyYears", () => {
  it("lists distinct confirmed years ascending", () => {
    expect(journeyYears([j25, j24, { ...j24, status: "draft", segments: [{ ...j24.segments[0], departAt: "2019-01-01" }] }])).toEqual([2024, 2025]);
  });
});
