// Validates the air-quality normals and the Comfort Index air penalty against places whose air is
// well known. The values are the real Open-Meteo / CAMS figures committed in data/climate-normals.json
// (fetched by scripts/backfill-climate.ts), not fixtures. The thresholds are deliberately loose: they
// pin the physical story (burning season, winter inversion, clean ocean air), not the third digit.

import { beforeAll, describe, expect, it } from "vitest";
import { airBand, airPenalty, comfortBreakdown } from "../../src/lib/comfort";
import { cellKeyFor, decodeMonths, readCommittedClimate, type ClimateFile } from "./climateNormals";
import { getCityById, loadCities } from "./cities";

let file: ClimateFile;
beforeAll(() => {
  loadCities();
  // This suite reads the repo's committed file, whatever DATA_DIR other suites set.
  delete process.env.DATA_DIR;
  file = readCommittedClimate();
});

function months(cityId: string) {
  const city = getCityById(cityId);
  if (!city) throw new Error(`city ${cityId} is not in the dataset`);
  const cell = file.cells[cellKeyFor(city.lat, city.lng)];
  const m = decodeMonths(cell);
  if (!m || !cell?.m?.a) throw new Error(`no air-quality normals committed for ${cityId}: run npm run backfill:climate`);
  return m;
}
const MAR = 2;
const AUG = 7;
const NOV = 10;

describe("committed climate normals", () => {
  it("record the windows they average over", () => {
    expect(file.weatherWindow).toBe("2015-2024");
    expect(file.airWindow).toBe("2023-2025");
  });
});

describe("Chiang Mai: the February to April burning season", () => {
  it("shows PM2.5 in March at least double the rainy-season level, and takes points off for it", () => {
    const m = months("chiang-mai-thailand");
    expect(m[MAR]!.pm25!).toBeGreaterThan(25);
    expect(m[MAR]!.pm25!).toBeGreaterThan(2 * m[AUG]!.pm25!);
    const withAir = comfortBreakdown(m[MAR]!.tempC, m[MAR]!.precipMm, m[MAR]!.pm25);
    const without = comfortBreakdown(m[MAR]!.tempC, m[MAR]!.precipMm);
    expect(withAir.air).toBeGreaterThan(8);
    expect(withAir.score).toBeLessThan(without.score - 8);
    expect(m[MAR]!.score).toBe(withAir.score);
  });

  it("peaks in the burning season, not the monsoon", () => {
    const m = months("chiang-mai-thailand").map((x) => x.pm25!);
    const peak = m.indexOf(Math.max(...m));
    expect([1, 2, 3]).toContain(peak); // Feb, Mar or Apr
    expect(airPenalty(m[AUG]!)).toBeLessThan(airPenalty(m[MAR]!));
  });
});

describe("Delhi and Lahore: the winter smog", () => {
  for (const city of ["delhi-india", "lahore-pakistan"]) {
    it(`${city} is unhealthy in November and worst around the turn of the year`, () => {
      const m = months(city);
      expect(m[NOV]!.pm25!).toBeGreaterThan(75);
      expect(["unhealthy", "hazardous"]).toContain(airBand(m[NOV]!.pm25!));
      expect(comfortBreakdown(m[NOV]!.tempC, m[NOV]!.precipMm, m[NOV]!.pm25).air).toBe(40); // the full penalty
      const winter = Math.max(m[11]!.pm25!, m[0]!.pm25!);
      expect(winter).toBeGreaterThanOrEqual(m[NOV]!.pm25!);
      expect(m[NOV]!.pm25!).toBeGreaterThan(1.5 * m[AUG]!.pm25!);
    });
  }

  it("the penalty turns a pleasant November into a poor one", () => {
    const m = months("delhi-india")[NOV]!;
    const without = comfortBreakdown(m.tempC, m.precipMm).score;
    expect(without).toBeGreaterThan(60); // clear, mild, dry: a great month on temperature and rain alone
    expect(m.score).toBeLessThanOrEqual(without - 35);
  });
});

describe("a clean control: Honolulu", () => {
  it("has clean air all year and loses almost nothing to the air penalty", () => {
    const m = months("honolulu-united-states");
    for (const x of m) {
      expect(x.pm25!).toBeLessThan(15);
      expect(airBand(x.pm25!)).toBe("clean");
      expect(airPenalty(x.pm25!)).toBe(0);
    }
  });
});

describe("ordering across the cases", () => {
  it("ranks Delhi November worse than Chiang Mai March worse than Honolulu", () => {
    const pen = (id: string, month: number) => airPenalty(months(id)[month]!.pm25!);
    expect(pen("delhi-india", NOV)).toBeGreaterThan(pen("chiang-mai-thailand", MAR));
    expect(pen("chiang-mai-thailand", MAR)).toBeGreaterThan(pen("honolulu-united-states", MAR));
  });
});
