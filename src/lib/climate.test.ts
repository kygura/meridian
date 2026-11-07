import { describe, it, expect } from "vitest";
import {
  describeFilter,
  greeneryOf,
  lushIndex,
  matchesFilter,
  modeStep,
  monthTraits,
  searchClimate,
  toggleCondition,
  warmthOf,
  wetnessOf,
  type ClimateMonth,
} from "./climate";

const flat = (tempC: number, precipMm: number, score = 60): ClimateMonth[] =>
  Array.from({ length: 12 }, () => ({ score, tempC, precipMm }));

describe("classes", () => {
  it("bands temperature and rain at their edges", () => {
    expect([-1, 0, 9.9, 10, 17, 23, 28].map(warmthOf)).toEqual(["freezing", "cold", "cold", "cool", "mild", "warm", "hot"]);
    expect([0, 10, 40, 100, 200].map(wetnessOf)).toEqual(["arid", "dry", "moderate", "wet", "soaked"]);
    expect([0, 20, 45, 70].map(greeneryOf)).toEqual(["barren", "sparse", "green", "lush"]);
  });
});

describe("lushIndex", () => {
  it("is high for warm, rainy places and low for deserts and frozen ones", () => {
    expect(lushIndex(flat(27, 220), 0)).toBeGreaterThanOrEqual(90);
    expect(lushIndex(flat(30, 2), 0)).toBeLessThan(10);
    expect(lushIndex(flat(-8, 60), 0)).toBe(0);
  });

  it("remembers recent rain: the first dry month after the rains stays greener than late dry season", () => {
    const months = flat(25, 5);
    months[5] = months[6] = months[7] = { score: 50, tempC: 25, precipMm: 250 };
    expect(lushIndex(months, 8)).toBeGreaterThan(lushIndex(months, 11));
  });
});

describe("monthTraits + matchesFilter", () => {
  const bangkokFeb = monthTraits(flat(28, 20, 88), 2)!;
  it("reads traits for a month", () => {
    expect(bangkokFeb.warmth).toBe("hot");
    expect(bangkokFeb.wetness).toBe("dry");
    expect(bangkokFeb.snowy).toBe(false);
    expect(monthTraits(flat(-3, 40), 1)!.snowy).toBe(true);
  });

  it("ORs within a group and ANDs across groups", () => {
    expect(matchesFilter(bangkokFeb, { conditions: ["warmth:warm", "warmth:hot"], minComfort: 0 })).toBe(true);
    expect(matchesFilter(bangkokFeb, { conditions: ["warmth:hot", "wetness:wet"], minComfort: 0 })).toBe(false);
    expect(matchesFilter(bangkokFeb, { conditions: ["warmth:hot", "wetness:dry", "wetness:wet"], minComfort: 0 })).toBe(true);
  });

  it("applies the comfort floor", () => {
    expect(matchesFilter(bangkokFeb, { conditions: [], minComfort: 90 })).toBe(false);
    expect(matchesFilter(bangkokFeb, { conditions: [], minComfort: 80 })).toBe(true);
  });
});

describe("searchClimate", () => {
  it("parses a phrase into one condition per word", () => {
    expect(searchClimate("warm and dry").parsed).toEqual(["warmth:warm", "wetness:dry"]);
    expect(searchClimate("lush, green").parsed).toEqual(["greenery:lush", "greenery:green"]);
    expect(searchClimate("snow").parsed).toEqual(["snow:snowy"]);
    expect(searchClimate("monsoon").parsed).toEqual(["wetness:soaked"]);
  });

  it("finds presets and conditions by keyword", () => {
    const r = searchClimate("beach");
    expect(r.presets.map((p) => p.id)).toContain("beach");
    expect(searchClimate("jungle").conditions.map((c) => c.id)).toContain("greenery:lush");
    expect(searchClimate("zzz").parsed).toEqual([]);
  });
});

describe("helpers", () => {
  it("toggles and describes", () => {
    expect(toggleCondition(["warmth:hot"], "warmth:hot")).toEqual([]);
    expect(describeFilter({ conditions: ["warmth:warm", "warmth:hot", "wetness:dry"], minComfort: 70 })).toBe("Warm or Hot · Dry · Comfort 70+");
  });

  it("maps modes onto ramp steps", () => {
    const t = monthTraits(flat(30, 250, 40), 1)!;
    expect(modeStep("temperature", t)).toBe(6);
    expect(modeStep("rainfall", t)).toBe(6);
    expect(modeStep("comfort", t)).toBe(3);
    expect(modeStep("temperature", monthTraits(flat(-10, 0), 1)!)).toBe(0);
  });
});
