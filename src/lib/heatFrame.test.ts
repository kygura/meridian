import { describe, expect, it } from "vitest";
import {
  columnOfMonth,
  columnsInWindow,
  formatMetric,
  frameValues,
  monthValues,
  monthsInRange,
  windowLabel,
  windowScore,
} from "./heatFrame";

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

describe("time window", () => {
  it("lists the months a range touches, across the new year", () => {
    expect(monthsInRange("2026-12-20", "2027-01-05")).toEqual([11, 0]);
    expect(monthsInRange("2026-11-10", "2026-11-24")).toEqual([10]);
    expect(monthsInRange("2026-03-01", "2027-05-01")).toHaveLength(12);
  });

  it("rejects backwards or broken ranges", () => {
    expect(monthsInRange("2026-05-02", "2026-05-01")).toBeNull();
    expect(monthsInRange("", "2026-05-01")).toBeNull();
  });

  it("scores a window by mean comfort", () => {
    const m = year((i) => ({ score: i * 10 }));
    expect(windowScore(m, [1, 2, 3])).toBe(20);
    expect(windowScore([{ score: 50 }], [0, 1])).toBeNull();
  });

  it("finds the season columns a window overlaps and labels it", () => {
    expect(columnsInWindow("seasons", [11, 0])).toEqual([0]);
    expect(columnsInWindow("seasons", [4, 5])).toEqual([1, 2]);
    expect(columnsInWindow("months", [3])).toEqual([3]);
    expect(windowLabel([11, 0])).toBe("Dec–Jan");
    expect(windowLabel([10])).toBe("Nov");
  });
});

it("maps months to season columns and formats values", () => {
  expect(columnOfMonth("seasons", 11)).toBe(0);
  expect(columnOfMonth("seasons", 6)).toBe(2);
  expect(formatMetric("temperature", 23.6)).toBe("24°");
  expect(formatMetric("rainfall", 84.2)).toBe("84");
});
