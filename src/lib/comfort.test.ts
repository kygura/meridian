import { describe, expect, it } from "vitest";
import {
  AIR_BAND_LABEL,
  airBand,
  airPenalty,
  breakdownRows,
  comfortBreakdown,
  comfortScore,
  climateYear,
  desertPenalty,
  desertShare,
  annualRain,
  monthOfWeek,
  SKY_FREE_H,
  SKY_MAX_H,
  SKY_MAX_PENALTY,
  skyPenalty,
  tempComfort,
  weekOfDayOfYear,
  weeklyComfortBreakdown,
} from "./comfort";

describe("comfortBreakdown", () => {
  it("splits the index into temperature, rain and air", () => {
    const b = comfortBreakdown(24, 140, 42.5);
    expect(b.temp).toBe(76); // TEMP_CURVE point
    expect(b.rain).toBeCloseTo(17.5 * (0.6 + 0.4 * 0.76), 5); // 35 * (140-30)/220, eased for 24C heat
    expect(b.air).toBeCloseTo(20, 5); // 40 * (42.5-10)/65
    expect(b.airKnown).toBe(true);
    expect(b.score).toBe(Math.round(b.temp - b.rain - b.air));
  });

  it("is unchanged from the two-term index when no PM2.5 is known", () => {
    expect(comfortScore(18, 140)).toBe(83); // 100 - 35 * 110/220
    expect(comfortScore(26, 0)).toBe(64);
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
  it("spares mild ocean deserts and keeps hot and continental ones (ADR 0025)", () => {
    const year = (t: number[], p: number[]) => climateYear(t.map((tempC, i) => ({ tempC, precipMm: p[i] })))!;
    // Monthly means (C) and rain (mm), Open-Meteo 2015-2024 as Meridian stores them.
    const arrecife = year([17.2, 17.1, 17.7, 18.8, 20, 21.3, 22.6, 23.6, 23.2, 22.4, 20.3, 18.5], [6, 14, 6, 5, 3, 2, 0, 1, 8, 16, 10, 6]);
    const fuerteventura = year([17.6, 17.7, 18.4, 19.7, 21, 22.4, 24.1, 25, 24, 23, 20.8, 18.7], [5, 9, 5, 5, 2, 1, 0, 1, 9, 12, 8, 5]);
    const cairo = year([14, 15.4, 18, 21.5, 25, 27.5, 28.5, 28.4, 26.7, 24, 19.5, 15.6], [5, 4, 4, 1, 0, 0, 0, 0, 0, 1, 3, 6]);
    const dubai = year([19.5, 20.5, 23, 27, 31, 33.5, 35.5, 35.5, 33, 29.5, 25, 21], [12, 25, 18, 7, 1, 0, 0, 0, 0, 1, 3, 13]);
    const gobi = year([-15, -11, -3, 6, 13, 19, 21, 19, 13, 4, -6, -13], [1, 1, 3, 4, 10, 25, 35, 30, 12, 4, 2, 1]);
    expect(desertShare(arrecife.warmestC, arrecife.coldestC)).toBe(0);
    expect(comfortBreakdown(17.2, 6, undefined, arrecife).desert).toBe(0);
    expect(comfortScore(17.2, 6, undefined, arrecife)).toBe(100);
    const f = desertShare(fuerteventura.warmestC, fuerteventura.coldestC);
    expect(f).toBeCloseTo(0.25, 5);
    expect(comfortBreakdown(17.6, 5, undefined, fuerteventura).desert).toBeCloseTo(desertPenalty(fuerteventura.precipMm) * 0.25, 5);
    expect(desertShare(cairo.warmestC, cairo.coldestC)).toBe(1);
    expect(comfortScore(18, 4, undefined, cairo)).toBeLessThanOrEqual(55);
    expect(desertShare(dubai.warmestC, dubai.coldestC)).toBe(1);
    expect(desertShare(gobi.warmestC, gobi.coldestC)).toBe(1);
  });
  it("explains a scaled desert term in its row, and applies in full without temperatures", () => {
    const y = { precipMm: 60, warmestC: 25, coldestC: 17.6 };
    const b = comfortBreakdown(18, 5, undefined, y);
    expect(breakdownRows(b, 18, 5).at(-1)?.note).toBe("60 mm of rain a year; a mild ocean climate (warmest month 25°C) keeps 25% of the penalty");
    expect(comfortBreakdown(18, 5, undefined, { precipMm: 40 }).desert).toBe(45);
    expect(climateYear([{ tempC: null, precipMm: 1 }, ...Array.from({ length: 11 }, () => ({ tempC: 20, precipMm: 1 }))])).toEqual({ precipMm: 12 });
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
  it("falls away above it (eased for humid heat, ADR 0023) and more gently below", () => {
    expect(tempComfort(22)).toBe(88);
    expect(tempComfort(26)).toBe(64);
    expect(tempComfort(30)).toBe(36);
    expect(tempComfort(34)).toBe(9);
    expect(tempComfort(36)).toBe(0);
    expect(tempComfort(13)).toBe(78);
    expect(tempComfort(4)).toBe(25);
    expect(tempComfort(-10)).toBe(0);
  });
  it("interpolates between points and stays flat past the ends", () => {
    expect(tempComfort(23)).toBe(82);
    expect(tempComfort(45)).toBe(0);
    expect(tempComfort(-30)).toBe(0);
    expect(tempComfort(Number.NaN)).toBe(0);
  });

  it("scores weekly rain on the monthly scale", () => {
    // 50 mm in a week is ~217 mm over an average month.
    const w = weeklyComfortBreakdown(22, 50);
    expect(w.rain).toBeCloseTo(((35 * (50 * (365.25 / 12 / 7) - 30)) / 220) * (0.6 + 0.4 * 0.88), 5); // 22C: heat score 88
  });
});

describe("breakdownRows", () => {
  it("lists temperature, rain and air with the points each is worth", () => {
    const rows = breakdownRows(comfortBreakdown(24, 140, 42.5), 24, 140, 42.5);
    expect(rows.map((r) => r.key)).toEqual(["temp", "rain", "air"]);
    expect(rows.map((r) => r.text)).toEqual(["+76", "−16", "−20"]);
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

describe("sky term (ADR 0026)", () => {
  it("is free at 6 h of sun a day, full at 2 h, linear between", () => {
    expect([SKY_FREE_H, SKY_MAX_H, SKY_MAX_PENALTY]).toEqual([6, 2, 25]);
    expect(skyPenalty(6)).toBe(0);
    expect(skyPenalty(9)).toBe(0);
    expect(skyPenalty(4)).toBe(12.5);
    expect(skyPenalty(2)).toBe(25);
    expect(skyPenalty(1)).toBe(25);
    expect(skyPenalty(0)).toBe(25);
  });

  it("takes nothing off when the sunshine is unknown, and says so in the breakdown", () => {
    for (const none of [undefined, null, Number.NaN]) {
      const b = comfortBreakdown(18, 0, undefined, undefined, none);
      expect(b).toMatchObject({ sky: 0, skyKnown: false, score: 100 });
    }
    expect(comfortScore(18, 0, undefined, undefined, 1.5)).toBe(75);
    expect(weeklyComfortBreakdown(18, 0, undefined, undefined, 4)).toMatchObject({ sky: 12.5, skyKnown: true, score: 88 }); // 87.5 rounds up; weekly sunH is already per day
  });

  it("adds a Sky row after Air only when sunshine is known", () => {
    const withSun = breakdownRows(comfortBreakdown(18, 10, undefined, undefined, 1.5), 18, 10, undefined, "mm a month", 1.5);
    expect(withSun.map((r) => r.key)).toEqual(["temp", "rain", "air", "sky"]);
    expect(withSun[3]).toMatchObject({ label: "Sky", points: -25, text: "−25", note: "1.5 h of sun a day" });
    expect(breakdownRows(comfortBreakdown(18, 10, undefined, undefined, 2), 18, 10, undefined, "mm a month", 2)[3]!.note).toBe("2 h of sun a day");
    expect(breakdownRows(comfortBreakdown(18, 10, undefined, undefined, 8), 18, 10, undefined, "mm a month", 8)[3]).toMatchObject({ text: "0", note: "8 h of sun a day" });
    const without = breakdownRows(comfortBreakdown(18, 10), 18, 10);
    expect(without.map((r) => r.key)).toEqual(["temp", "rain", "air"]);
    expect(breakdownRows(comfortBreakdown(18, 10), 18, 10, undefined, "mm a month", 3).some((r) => r.key === "sky")).toBe(false); // a figure without a known breakdown never shows
  });

  it("puts Lima's garua winter at 80 or below, while the Canaries stay as they were", () => {
    const lima = [23, 23.5, 23, 21.5, 19.5, 18, 17, 16.5, 17, 18, 19.5, 21.5].map((tempC) => ({ tempC, precipMm: 1 }));
    const year = climateYear(lima)!;
    const jul = lima[6]!;
    expect(comfortBreakdown(jul.tempC, jul.precipMm, undefined, year).score).toBe(100); // 0025: the desert term is gone, the sky is not seen
    expect(comfortScore(jul.tempC, jul.precipMm, undefined, year, 1.5)).toBeLessThanOrEqual(80);
    // a sunny Lima summer month is not hurt
    expect(comfortScore(lima[1]!.tempC, 1, undefined, year, 7.5)).toBe(comfortScore(lima[1]!.tempC, 1, undefined, year));
    // Canary-like: mild, dry, sunny (8 h)
    const arrecife = { precipMm: 80, warmestC: 23.6, coldestC: 17.1 };
    expect(comfortScore(17.2, 6, undefined, arrecife, 8)).toBe(100);
    expect(comfortBreakdown(17.2, 6, undefined, arrecife, 8).sky).toBe(0);
  });
});
