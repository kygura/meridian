import { describe, expect, it } from "vitest";
import {
  AIR_BAND_LABEL,
  airBand,
  airPenalty,
  comfortBreakdown,
  comfortScore,
  monthOfWeek,
  weekOfDayOfYear,
  weeklyComfortBreakdown,
} from "./comfort";

describe("comfortBreakdown", () => {
  it("splits the index into temperature, rain and air", () => {
    const b = comfortBreakdown(30, 140, 42.5);
    expect(b.temp).toBeCloseTo(71.43, 1); // 100 * (40-30)/14
    expect(b.rain).toBeCloseTo(17.5, 5); // 35 * (140-30)/220
    expect(b.air).toBeCloseTo(20, 5); // 40 * (42.5-10)/65
    expect(b.airKnown).toBe(true);
    expect(b.score).toBe(Math.round(b.temp - b.rain - b.air));
  });

  it("is unchanged from the two-term index when no PM2.5 is known", () => {
    expect(comfortScore(22, 140)).toBe(83);
    expect(comfortScore(33, 0)).toBe(50);
    const b = comfortBreakdown(22, 140);
    expect(b.airKnown).toBe(false);
    expect(b.air).toBe(0);
    expect(comfortBreakdown(22, 140, null).airKnown).toBe(false);
  });

  it("applies no air penalty at or below 10 ug/m3 and the full 40 at or above 75", () => {
    expect(airPenalty(0)).toBe(0);
    expect(airPenalty(10)).toBe(0);
    expect(airPenalty(75)).toBe(40);
    expect(airPenalty(400)).toBe(40);
    expect(airPenalty(42.5)).toBeCloseTo(20, 5);
  });

  it("never goes below 0 or above 100", () => {
    expect(comfortScore(-30, 500, 300)).toBe(0);
    expect(comfortScore(22, 0, 0)).toBe(100);
  });

  it("scores weekly rain on the monthly scale", () => {
    // 50 mm in a week is ~217 mm over an average month.
    const w = weeklyComfortBreakdown(22, 50);
    expect(w.rain).toBeCloseTo((35 * (50 * (365.25 / 12 / 7) - 30)) / 220, 5);
  });
});

describe("air bands", () => {
  it("names the band of a monthly mean", () => {
    expect(airBand(6)).toBe("clean");
    expect(airBand(18)).toBe("moderate");
    expect(airBand(40)).toBe("poor");
    expect(airBand(80)).toBe("unhealthy");
    expect(airBand(160)).toBe("hazardous");
    expect(AIR_BAND_LABEL[airBand(40)]).toBe("Poor air");
  });
});

describe("week calendar", () => {
  it("maps days of the year to weeks 1-52, folding the last days into week 52", () => {
    expect(weekOfDayOfYear(1)).toBe(1);
    expect(weekOfDayOfYear(7)).toBe(1);
    expect(weekOfDayOfYear(8)).toBe(2);
    expect(weekOfDayOfYear(364)).toBe(52);
    expect(weekOfDayOfYear(365)).toBe(52);
  });
  it("maps weeks to the month they mostly fall in", () => {
    expect(monthOfWeek(1)).toBe(1);
    expect(monthOfWeek(10)).toBe(3);
    expect(monthOfWeek(27)).toBe(7);
    expect(monthOfWeek(52)).toBe(12);
  });
});
