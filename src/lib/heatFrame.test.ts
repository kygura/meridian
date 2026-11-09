import { describe, expect, it } from "vitest";
import { bestRun, bestRunLabel, columnOfMonth, formatMetric, frameValues, monthValues } from "./heatFrame";

const year = (f: (i: number) => { score: number; tempC?: number; precipMm?: number }) =>
  Array.from({ length: 12 }, (_, i) => f(i));

describe("frameValues", () => {
  it("passes months through", () => {
    const m = year((i) => ({ score: i * 5, tempC: i, precipMm: 10 }));
    expect(frameValues(m, "comfort", "months")).toEqual(m.map((x) => x.score));
    expect(frameValues(m, "temperature", "months")[3]).toBe(3);
  });

  it("averages seasons, Dec–Feb first", () => {
    const m = year((i) => ({ score: 0, tempC: i, precipMm: i * 10 }));
    expect(frameValues(m, "temperature", "seasons")).toEqual([(11 + 0 + 1) / 3, 3, 6, 9]);
    expect(frameValues(m, "rainfall", "seasons")[1]).toBe(30);
  });

  it("leaves a column empty when a month is missing", () => {
    const m = year(() => ({ score: 50 }));
    expect(frameValues(m, "temperature", "seasons")).toEqual([null, null, null, null]);
    expect(frameValues(m, "comfort", "seasons")).toEqual([50, 50, 50, 50]);
  });

  it("needs a whole year of temperature and rain for greenery", () => {
    expect(monthValues(year(() => ({ score: 1, tempC: 20 })), "greenery").every((v) => v === null)).toBe(true);
    const wet = monthValues(year(() => ({ score: 1, tempC: 20, precipMm: 150 })), "greenery");
    expect(wet.every((v) => typeof v === "number" && v > 50)).toBe(true);
  });
});

describe("bestRun", () => {
  it("finds a run across the year seam", () => {
    const s = [90, 88, 40, 30, 30, 30, 30, 30, 30, 30, 40, 85];
    const r = bestRun(s)!;
    expect(r.cols).toEqual([11, 0, 1]);
    expect(r.peak).toBe(0);
    expect(bestRunLabel(r, "months")).toBe("Dec–Feb");
  });

  it("covers the whole frame when everything is close", () => {
    expect(bestRunLabel(bestRun([80, 82, 79, 81]), "seasons")).toBe("All year");
  });

  it("labels a season run by its months", () => {
    expect(bestRunLabel(bestRun([20, 70, 75, 30]), "seasons")).toBe("Mar–Aug");
  });

  it("gives nothing for missing data", () => {
    expect(bestRun([1, null, 3])).toBeNull();
  });
});

it("maps months to season columns and formats values", () => {
  expect(columnOfMonth("seasons", 11)).toBe(0);
  expect(columnOfMonth("seasons", 6)).toBe(2);
  expect(formatMetric("temperature", 23.6)).toBe("24°");
  expect(formatMetric("rainfall", 84.2)).toBe("84");
});
