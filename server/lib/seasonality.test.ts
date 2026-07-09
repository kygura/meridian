import { describe, it, expect } from "vitest";
import { comfortScore, aggregateDailyToMonthly } from "./seasonality";

describe("comfortScore — temperature band", () => {
  it("scores 100 at the low edge of the comfort band (18C, no rain)", () => {
    expect(comfortScore(18, 0)).toBe(100);
  });
  it("scores 100 at the high edge of the comfort band (26C, no rain)", () => {
    expect(comfortScore(26, 0)).toBe(100);
  });
  it("scores 100 anywhere inside the band (22C, no rain)", () => {
    expect(comfortScore(22, 0)).toBe(100);
  });
  it("falls off linearly below the band (12C, no rain)", () => {
    // 100 * (12 - (-5)) / (18 - (-5)) = 100 * 17/23 = 73.913... -> 74
    expect(comfortScore(12, 0)).toBe(74);
  });
  it("falls off linearly above the band (33C, no rain)", () => {
    // 100 * (40 - 33) / (40 - 26) = 100 * 7/14 = 50
    expect(comfortScore(33, 0)).toBe(50);
  });
  it("is exactly 0 at the low floor (-5C)", () => {
    expect(comfortScore(-5, 0)).toBe(0);
  });
  it("is exactly 0 at the high ceiling (40C)", () => {
    expect(comfortScore(40, 0)).toBe(0);
  });
  it("clamps to 0 below the floor (-20C)", () => {
    expect(comfortScore(-20, 0)).toBe(0);
  });
  it("clamps to 0 above the ceiling (60C)", () => {
    expect(comfortScore(60, 0)).toBe(0);
  });
});

describe("comfortScore — precipitation penalty", () => {
  it("applies no penalty at or below 30mm", () => {
    expect(comfortScore(22, 0)).toBe(100);
    expect(comfortScore(22, 30)).toBe(100);
  });
  it("applies the full -35 penalty at or above 250mm", () => {
    expect(comfortScore(22, 250)).toBe(65);
  });
  it("does not apply more than -35 penalty beyond 250mm", () => {
    expect(comfortScore(22, 1000)).toBe(65);
  });
  it("scales linearly between the free and max thresholds (140mm)", () => {
    // penalty = 35 * (140-30)/(250-30) = 35 * 110/220 = 17.5 -> 100-17.5 = 82.5 -> 83
    expect(comfortScore(22, 140)).toBe(83);
  });
});

describe("comfortScore — clamp and determinism", () => {
  it("never returns below 0 even with a harsh temp and heavy rain", () => {
    expect(comfortScore(-30, 500)).toBe(0);
    expect(comfortScore(55, 500)).toBe(0);
  });
  it("never returns above 100", () => {
    expect(comfortScore(22, -10)).toBeLessThanOrEqual(100);
  });
  it("is a pure function — same inputs always produce the same output", () => {
    const a = comfortScore(21.3, 87);
    const b = comfortScore(21.3, 87);
    const c = comfortScore(21.3, 87);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
  it("always returns an integer", () => {
    expect(Number.isInteger(comfortScore(19.7, 63))).toBe(true);
  });
});

describe("aggregateDailyToMonthly", () => {
  function makeDailyMonth(year: number, month: number, days: number, tempC: number, precipMm: number) {
    const mm = String(month + 1).padStart(2, "0");
    return Array.from({ length: days }, (_, d) => ({
      date: `${year}-${mm}-${String(d + 1).padStart(2, "0")}`,
      tempC,
      precipMm,
    }));
  }

  it("averages temperature across years for the same calendar month", () => {
    const daily = [
      ...makeDailyMonth(2020, 0, 31, 10, 5),
      ...makeDailyMonth(2021, 0, 31, 20, 1),
    ];
    const monthly = aggregateDailyToMonthly(daily);
    expect(monthly[0]!.tempC).toBe(15);
  });

  it("averages the yearly monthly precipitation total across years", () => {
    const daily = [
      ...makeDailyMonth(2020, 0, 31, 10, 5), // 155mm total in Jan 2020
      ...makeDailyMonth(2021, 0, 31, 20, 1), // 31mm total in Jan 2021
    ];
    const monthly = aggregateDailyToMonthly(daily);
    // (155 + 31) / 2 = 93
    expect(monthly[0]!.precipMm).toBe(93);
  });

  it("returns 12 months and defaults uncovered months to zero", () => {
    const daily = makeDailyMonth(2020, 5, 30, 25, 10); // June only
    const monthly = aggregateDailyToMonthly(daily);
    expect(monthly).toHaveLength(12);
    expect(monthly[5]!.tempC).toBe(25);
    expect(monthly[0]!.tempC).toBe(0);
    expect(monthly[0]!.precipMm).toBe(0);
  });

  it("rounds tempC to 1 decimal place", () => {
    const daily = [
      { date: "2020-03-01", tempC: 10.11, precipMm: 0 },
      { date: "2020-03-02", tempC: 10.19, precipMm: 0 },
    ];
    const monthly = aggregateDailyToMonthly(daily);
    // mean = 10.15 -> 10.1 or 10.2 depending on fp rounding, but always 1dp
    expect(monthly[2]!.tempC.toString()).toMatch(/^\d+(\.\d)?$/);
  });

  it("is deterministic for the same input", () => {
    const daily = makeDailyMonth(2020, 2, 31, 18.4, 42);
    const a = aggregateDailyToMonthly(daily);
    const b = aggregateDailyToMonthly(daily);
    expect(a).toEqual(b);
  });
});
