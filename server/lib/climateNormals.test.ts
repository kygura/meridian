import { describe, expect, it } from "vitest";
import {
  cellKeyFor,
  dailyFromHourly,
  dayOfYear365,
  decodeMonths,
  decodeWeeks,
  emptyClimateFile,
  encodeWeekly,
  monthlyMeanNormals,
  parseClimateFile,
  serializeClimateFile,
  smoothCircular,
  weekIndex,
  weeklyNormals,
  type DailyValue,
} from "./climateNormals";

/** Daily series over `years`, value = f(date, day-of-year). */
function series(years: number[], f: (date: string, doy: number) => number): DailyValue[] {
  const out: DailyValue[] = [];
  for (const y of years) {
    for (let d = new Date(Date.UTC(y, 0, 1)); d.getUTCFullYear() === y; d = new Date(d.getTime() + 86_400_000)) {
      const date = d.toISOString().slice(0, 10);
      out.push({ date, v: f(date, dayOfYear365(date)!) });
    }
  }
  return out;
}

describe("calendar", () => {
  it("keys cities by 0.25 degree cell, so neighbours share a record", () => {
    expect(cellKeyFor(18.8, 98.98)).toBe(cellKeyFor(18.85, 99.0));
    expect(cellKeyFor(18.8, 98.98)).not.toBe(cellKeyFor(19.2, 98.98));
    expect(cellKeyFor(-0.1, -0.1)).toBe("0,0");
  });

  it("counts 29 February as 28 February and puts 31 December in the last week", () => {
    expect(dayOfYear365("2024-02-29")).toBe(59);
    expect(dayOfYear365("2024-03-01")).toBe(60);
    expect(dayOfYear365("2023-03-01")).toBe(60);
    expect(weekIndex("2024-01-01")).toBe(0);
    expect(weekIndex("2024-12-31")).toBe(51);
    expect(weekIndex("2023-12-25")).toBe(51);
  });
});

describe("weeklyNormals", () => {
  const seasonal = (doy: number) => 15 + 10 * Math.sin(((doy - 100) / 365) * 2 * Math.PI);

  it("recovers a seasonal curve from daily data as 52 values", () => {
    const w = weeklyNormals(series([2020, 2021, 2022], (_, doy) => seasonal(doy)))!;
    expect(w).toHaveLength(52);
    const peak = w.indexOf(Math.max(...w));
    expect(peak).toBeGreaterThanOrEqual(25);
    expect(peak).toBeLessThanOrEqual(29);
    expect(Math.max(...w)).toBeGreaterThan(24);
    expect(Math.min(...w)).toBeLessThan(6);
  });

  it("scales a daily rain mean to a 7-day total", () => {
    const w = weeklyNormals(series([2021, 2022], () => 2), true)!;
    for (const v of w) expect(v).toBeCloseTo(14, 6);
  });

  it("smooths week-to-week noise but keeps a flat series flat", () => {
    expect(smoothCircular([0, 0, 40, 0, 0, 0])).toEqual([0, 10, 20, 10, 0, 0]);
    expect(smoothCircular([5, 5, 5, 5])).toEqual([5, 5, 5, 5]);
    expect(smoothCircular([40, 0, 0, 0])[3]).toBe(10); // wraps around the new year
  });

  it("returns null for a series too sparse to be a normal, never a partial profile", () => {
    expect(weeklyNormals(series([2020], () => 1).slice(0, 40))).toBeNull();
    const sparse = series([2020], () => 1).slice(0, 3);
    expect(encodeWeekly(sparse, sparse)).toBeUndefined();
  });

  it("is deterministic", () => {
    const d = series([2020, 2021], (_, doy) => seasonal(doy));
    expect(weeklyNormals(d)).toEqual(weeklyNormals(d));
  });
});

describe("monthlyMeanNormals and dailyFromHourly", () => {
  it("averages each year's monthly mean, and is null when a month has no data", () => {
    const m = monthlyMeanNormals(series([2022, 2023], (date) => Number(date.slice(5, 7))))!;
    expect(m).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(monthlyMeanNormals(series([2022], () => 1).slice(0, 100))).toBeNull();
  });

  it("averages hours into days and drops days with fewer than 12 valid hours", () => {
    const times = Array.from({ length: 48 }, (_, i) => `2023-03-0${1 + Math.floor(i / 24)}T${String(i % 24).padStart(2, "0")}:00`);
    const values = times.map((_, i) => (i < 24 ? 10 : i < 24 + 8 ? 90 : null)); // day 2 has only 8 hours
    expect(dailyFromHourly(times, values)).toEqual([{ date: "2023-03-01", v: 10 }]);
  });
});

describe("record encode / decode", () => {
  it("decodes months with the Comfort Index including the air penalty", () => {
    const cell = { m: { t: Array(12).fill(180), p: Array(12).fill(10), a: [...Array(11).fill(50), 750] } };
    const m = decodeMonths(cell)!;
    expect(m[0]).toMatchObject({ tempC: 18, precipMm: 10, pm25: 5, score: 100 });
    expect(m[11]).toMatchObject({ pm25: 75, score: 60 }); // 100 - 40
  });

  it("leaves pm25 off months with no air-quality figure", () => {
    const m = decodeMonths({ m: { t: Array(12).fill(180), p: Array(12).fill(10) } })!;
    expect(m[0]).not.toHaveProperty("pm25");
    expect(m[0]!.score).toBe(100);
  });

  it("round-trips a weekly profile to 52 weeks with rain per 7 days", () => {
    const temp = series([2020, 2021], () => 22);
    const rain = series([2020, 2021], () => 1);
    const air = series([2023], () => 12);
    const w = decodeWeeks({ w: encodeWeekly(temp, rain, air)! })!;
    expect(w).toHaveLength(52);
    expect(w[10]).toMatchObject({ tempC: 22, precipMm: 7, pm25: 12 });
  });

  it("rejects malformed cells instead of guessing", () => {
    expect(decodeMonths(undefined)).toBeNull();
    expect(decodeMonths({ m: { t: [1, 2], p: [1, 2] } })).toBeNull();
    expect(decodeWeeks({ w: { t: [1], p: [1] } })).toBeNull();
  });
});

describe("file format", () => {
  it("writes one cell per line, sorted, and parses back", () => {
    const f = emptyClimateFile("2015-2024", "2023-2025");
    f.cells["10,20"] = { at: "2026-01-01", m: { t: Array(12).fill(1), p: Array(12).fill(2) } };
    f.cells["-3,4"] = { at: "2026-01-02" };
    const text = serializeClimateFile(f);
    expect(text.split("\n").filter((l) => l.startsWith('"-3,4"') || l.startsWith('"10,20"'))).toHaveLength(2);
    const back = parseClimateFile(text)!;
    expect(back.cells).toEqual(f.cells);
    expect(back.airWindow).toBe("2023-2025");
    expect(Object.keys(back.cells)).toEqual(["-3,4", "10,20"]);
  });
  it("refuses a file of the wrong shape", () => {
    expect(parseClimateFile("{}")).toBeUndefined();
    expect(parseClimateFile("nope")).toBeUndefined();
  });
});
