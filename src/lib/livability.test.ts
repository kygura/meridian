import { describe, expect, it } from "vitest";
import { axisValue, bestOfBoth, livabilityFacts, quadrant, type LivabilityDetail, type LivabilityRow } from "./livability";

const rows: LivabilityRow[] = [
  ["porto", 79, 91, 85, 96],
  ["innsbruck", 89, 83, 93, 72],
  ["delhi", 35, 51, 10, 92],
  ["houston", 75, 22, 0, 44],
  ["nodata", 70, 70, null, null],
];

describe("livability helpers", () => {
  it("places cities in the four corners", () => {
    expect(quadrant(89, 83)).toBe("both");
    expect(quadrant(35, 80)).toBe("beauty");
    expect(quadrant(75, 22)).toBe("living");
    expect(quadrant(35, 22)).toBe("neither");
  });

  it("reads the chosen beauty axis", () => {
    expect(axisValue(rows[0], "beauty")).toBe(91);
    expect(axisValue(rows[0], "setting")).toBe(85);
    expect(axisValue(rows[4], "character")).toBeNull();
  });

  it("ranks 'best of both' by the weaker score, skipping cities without that axis", () => {
    expect(bestOfBoth(rows, "beauty", 3).map((r) => r[0])).toEqual(["innsbruck", "porto", "nodata"]);
    expect(bestOfBoth(rows, "setting").map((r) => r[0])).toEqual(["innsbruck", "porto", "delhi", "houston"]);
  });

  it("explains the scores in plain words", () => {
    const d = {
      raw: { hdi: 0.926, happiness: 7.1, homicides: 0.6, pm25: 7.2, pm25Local: true, reliefM: 1820, heritageKm: 23, photos: 8000, notable: 67 },
    } as unknown as LivabilityDetail;
    const f = livabilityFacts(d);
    expect(f.quality).toContain("Fine particles 7.2 µg/m³ (measured here); WHO guideline 5");
    expect(f.setting).toEqual(["1,820 m of relief within 15 km"]);
    expect(f.character).toEqual(["World Heritage site 23 km away", "Heavily photographed centre", "67 notable places within 5 km"]);
  });
});
