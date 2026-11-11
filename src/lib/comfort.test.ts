import { describe, expect, it } from "vitest";
import {
  AIR_BAND_LABEL,
  airBand,
  airPenalty,
  breakdownRows,
  comfortBreakdown,
  comfortScore,
  desertPenalty,
  annualRain,
  monthOfWeek,
  tempComfort,
  weekOfDayOfYear,
  weeklyComfortBreakdown,
} from "./comfort";

describe("comfortBreakdown", () => {
  it("splits the index into temperature, rain and air", () => {
    const b = comfortBreakdown(24, 140, 42.5);
    expect(b.temp).toBe(65); // TEMP_CURVE point
    expect(b.rain).toBeCloseTo(17.5, 5); // 35 * (140-30)/220
    expect(b.air).toBeCloseTo(20, 5); // 40 * (42.5-10)/65
    expect(b.airKnown).toBe(true);
    expect(b.score).toBe(Math.round(b.temp - b.rain - b.air));
  });

  it("is unchanged from the two-term index when no PM2.5 is known", () => {
    expect(comfortScore(18, 140)).toBe(83); // 100 - 35 * 110/220
    expect(comfortScore(26, 0)).toBe(45);
    const b = comfortBreakdown(18, 140);
    expect(b.airKnown).toBe(false);
    expect(b.air).toBe(0);
    expect(comfortBreakdown(18, 140, null).airKnown).toBe(false);
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
    expect(comfortScore(18, 0, 0)).toBe(100);
  });
});

describe("desert", () => {
  it("takes nothing off at 400mm of rain a year or more, and 45 at 50mm or less", () => {
    expect(desertPenalty(400)).toBe(0);
    expect(desertPenalty(1200)).toBe(0);
    expect(desertPenalty(50)).toBe(45);
    expect(desertPenalty(10)).toBe(45);
    expect(desertPenalty(225)).toBeCloseTo(22.5, 5);
  });
  it("keeps Cairo's mildest month under 50", () => {
    // Cairo: ~18.5C mean in March, ~25mm of rain a year
    expect(comfortScore(18.5, 9, undefined, 25)).toBeLessThanOrEqual(55);
    expect(comfortScore(15.4, 7, 30, 25)).toBeLessThan(50);
  });
  it("applies only when the year's rain is given, and shows as its own row", () => {
    expect(comfortBreakdown(18, 0).desert).toBe(0);
    const b = comfortBreakdown(18, 0, undefined, 25);
    expect(b.desert).toBe(45);
    expect(b.score).toBe(55);
    const rows = breakdownRows(b, 18, 0);
    expect(rows.at(-1)).toMatchObject({ key: "desert", text: "−45", note: "25 mm of rain a year" });
    expect(breakdownRows(comfortBreakdown(18, 0, undefined, 800), 18, 0).some((r) => r.key === "desert")).toBe(false);
  });
  it("sums a year from 12 months or 52 weeks, and refuses gaps", () => {
    expect(annualRain(Array(12).fill(10))).toBe(120);
    expect(annualRain(Array(52).fill(7))).toBeCloseTo(364 * (365.25 / 364), 5);
    expect(annualRain([...Array(11).fill(10), null])).toBeUndefined();
    expect(annualRain([1, 2, 3])).toBeUndefined();
  });
});

describe("tempComfort", () => {
  it("peaks across a 16-20C monthly mean", () => {
    expect(tempComfort(16)).toBe(100);
    expect(tempComfort(20)).toBe(100);
  });
  it("falls away fast above it and more gently below", () => {
    expect(tempComfort(22)).toBe(85);
    expect(tempComfort(26)).toBe(45);
    expect(tempComfort(30)).toBe(15);
    expect(tempComfort(34)).toBe(0);
    expect(tempComfort(13)).toBe(78);
    expect(tempComfort(4)).toBe(25);
    expect(tempComfort(-10)).toBe(0);
  });
  it("interpolates between points and stays flat past the ends", () => {
    expect(tempComfort(23)).toBe(75);
    expect(tempComfort(45)).toBe(0);
    expect(tempComfort(-30)).toBe(0);
    expect(tempComfort(Number.NaN)).toBe(0);
  });

  it("scores weekly rain on the monthly scale", () => {
    // 50 mm in a week is ~217 mm over an average month.
    const w = weeklyComfortBreakdown(22, 50);
    expect(w.rain).toBeCloseTo((35 * (50 * (365.25 / 12 / 7) - 30)) / 220, 5);
  });
});

describe("breakdownRows", () => {
  it("lists temperature, rain and air with the points each is worth", () => {
    const rows = breakdownRows(comfortBreakdown(24, 140, 42.5), 24, 140, 42.5);
    expect(rows.map((r) => r.key)).toEqual(["temp", "rain", "air"]);
    expect(rows.map((r) => r.text)).toEqual(["+65", "−18", "−20"]);
    expect(rows[2]!.note).toBe("PM2.5 43 µg/m³ (Poor air)");
  });
  it("says so when air quality is unknown instead of showing a clean result", () => {
    const rows = breakdownRows(comfortBreakdown(22, 10), 22, 10);
    expect(rows[2]).toMatchObject({ text: "n/a", points: 0 });
    expect(rows[2]!.note).toContain("No air-quality data");
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
