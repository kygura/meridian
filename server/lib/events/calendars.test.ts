import { describe, it, expect } from "vitest";
import { chineseCalendarDays, parseWhen } from "./calendars";

const from = new Date("2026-11-18T00:00:00Z");
const to = new Date("2028-05-18T00:00:00Z");

describe("parseWhen", () => {
  it("reads a month name and a Gregorian month and day as a recurring month", () => {
    expect(parseWhen("October", from, to)).toEqual({ kind: "months", months: [10] });
    expect(parseWhen("April 13", from, to)).toEqual({ kind: "months", months: [4] });
    expect(parseWhen("March 21", from, to)).toEqual({ kind: "months", months: [3] });
  });

  it("reads a Hindu lunar month as an approximate Gregorian month", () => {
    expect(parseWhen("Ashvin Shukla Pratipada", from, to)).toEqual({ kind: "months", months: [10], approximate: true });
    expect(parseWhen("Kartik Shukla Dwitiya", from, to)).toEqual({ kind: "months", months: [11], approximate: true });
    expect(parseWhen("Phalguna Purnima", from, to)).toEqual({ kind: "months", months: [3], approximate: true });
  });

  it("resolves a Chinese-calendar day to Gregorian dates inside the window", () => {
    const ny = parseWhen("Lunar/Lunisolar New Year's Day", from, to);
    expect(ny).toEqual({ kind: "dates", dates: ["2027-02-07", "2028-01-26"] });
    const midAutumn = parseWhen("15th day of the 8th month of the Chinese lunisolar calendar", from, to);
    expect(midAutumn).toEqual({ kind: "dates", dates: ["2027-09-15"] });
    const qixi = parseWhen("7th day of the 7th month in the Chinese calendar", from, to);
    expect(qixi).toEqual({ kind: "dates", dates: ["2027-08-08"] });
  });

  it("does not read what it cannot place", () => {
    expect(parseWhen("Easter − 47 days", from, to)).toBeUndefined();
    expect(parseWhen("12th month", from, to)).toBeUndefined();
    expect(parseWhen("first Saturday in March", from, to)).toBeUndefined();
    expect(parseWhen("", from, to)).toBeUndefined();
  });
});

describe("chineseCalendarDays", () => {
  it("lists a month and day for each Gregorian day, with leap months marked 0", () => {
    const days = chineseCalendarDays(new Date("2025-06-01T00:00:00Z"), new Date("2025-09-01T00:00:00Z"));
    expect(days).toHaveLength(93);
    // 2025 had a leap sixth month.
    expect(days.some((d) => d.month === 0)).toBe(true);
    expect(days.every((d) => d.day >= 1 && d.day <= 30)).toBe(true);
  });
});
