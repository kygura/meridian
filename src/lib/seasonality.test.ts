import { describe, it, expect } from "vitest";
import {
  comfortBin,
  heatClass,
  COMFORT_LABELS,
  MONTH_INITIALS,
  bestWindow,
  isMonthInWindow,
  formatBestSpan,
  assembleCityRows,
  sortRows,
  type HeatRowDef,
} from "./seasonality";
import type { SeasonMonth } from "./seasonalityApi";

function months(scores: number[]): SeasonMonth[] {
  return scores.map((score) => ({ score, tempC: 20, precipMm: 40 }));
}

describe("comfortBin (ramp bucketing, DESIGN §2)", () => {
  it("maps every boundary to the correct bin", () => {
    expect(comfortBin(0)).toBe(0);
    expect(comfortBin(16)).toBe(0);
    expect(comfortBin(17)).toBe(1);
    expect(comfortBin(33)).toBe(1);
    expect(comfortBin(34)).toBe(2);
    expect(comfortBin(50)).toBe(2);
    expect(comfortBin(51)).toBe(3);
    expect(comfortBin(66)).toBe(3);
    expect(comfortBin(67)).toBe(4);
    expect(comfortBin(83)).toBe(4);
    expect(comfortBin(84)).toBe(5);
    expect(comfortBin(100)).toBe(5);
  });

  it("produces the heat-bN class name", () => {
    expect(heatClass(78)).toBe("heat-b4");
    expect(heatClass(84)).toBe("heat-b5");
    expect(heatClass(5)).toBe("heat-b0");
  });

  it("has one word label per bin and 12 month initials", () => {
    expect(COMFORT_LABELS).toEqual(["HARSH", "THIN", "MILD", "FAIR", "GOOD", "PRIME"]);
    expect(MONTH_INITIALS).toHaveLength(12);
  });
});

describe("bestWindow (DESIGN §2.3)", () => {
  it("finds a simple summer run within max-8 of the peak", () => {
    //                     J   F   M   A   M   J   J   A   S   O   N   D
    const w = bestWindow(months([20, 22, 35, 50, 80, 85, 88, 86, 81, 55, 30, 22]));
    // max=88 (Jul); candidates >= 80: May(80),Jun(85),Jul(88),Aug(86),Sep(81)
    expect(w).toEqual({ startMonth: 4, endMonth: 8, peakMonth: 6, isWrap: false });
  });

  it("handles a wrap-around run across the Dec/Jan seam", () => {
    //                     J   F   M   A   M   J   J   A   S   O   N   D
    const w = bestWindow(months([85, 82, 60, 40, 20, 10, 8, 12, 30, 55, 80, 88]));
    // max=88 (Dec); candidates >= 80: Nov(80),Dec(88),Jan(85),Feb(82)
    expect(w).toEqual({ startMonth: 10, endMonth: 1, peakMonth: 11, isWrap: true });
  });

  it("collapses to a single month when nothing else clears max-8", () => {
    const scores = [10, 10, 10, 10, 10, 90, 10, 10, 10, 10, 10, 10];
    const w = bestWindow(months(scores));
    expect(w).toEqual({ startMonth: 5, endMonth: 5, peakMonth: 5, isWrap: false });
  });

  it("returns a full-year window when every month qualifies", () => {
    const w = bestWindow(months(Array(12).fill(75)));
    expect(w).toEqual({ startMonth: 0, endMonth: 11, peakMonth: 0, isWrap: false });
  });

  it("prefers the longest run; ties prefer the run holding the peak", () => {
    // Two runs of equal length 2: Mar-Apr (peak 90 in Apr) and Sep-Oct.
    //                     J   F   M   A   M   J   J   A   S   O   N   D
    const w = bestWindow(months([10, 10, 85, 90, 10, 10, 10, 10, 84, 86, 10, 10]));
    expect(w?.startMonth).toBe(2);
    expect(w?.endMonth).toBe(3);
    expect(w?.peakMonth).toBe(3);
  });

  it("returns null for missing or malformed input", () => {
    expect(bestWindow(null)).toBeNull();
    expect(bestWindow(undefined)).toBeNull();
    expect(bestWindow(months([50, 50]))).toBeNull();
  });
});

describe("isMonthInWindow", () => {
  it("covers straight and wrapping windows", () => {
    const straight = { startMonth: 4, endMonth: 8, peakMonth: 6, isWrap: false };
    expect(isMonthInWindow(straight, 4)).toBe(true);
    expect(isMonthInWindow(straight, 8)).toBe(true);
    expect(isMonthInWindow(straight, 3)).toBe(false);
    expect(isMonthInWindow(straight, 9)).toBe(false);

    const wrap = { startMonth: 10, endMonth: 1, peakMonth: 11, isWrap: true };
    expect(isMonthInWindow(wrap, 11)).toBe(true);
    expect(isMonthInWindow(wrap, 0)).toBe(true);
    expect(isMonthInWindow(wrap, 1)).toBe(true);
    expect(isMonthInWindow(wrap, 2)).toBe(false);
    expect(isMonthInWindow(wrap, 9)).toBe(false);

    expect(isMonthInWindow(null, 0)).toBe(false);
  });
});

describe("formatBestSpan", () => {
  it("formats spans, single months, and missing windows", () => {
    expect(formatBestSpan({ startMonth: 4, endMonth: 8, peakMonth: 6, isWrap: false })).toBe(
      "MAY–SEP"
    );
    expect(formatBestSpan({ startMonth: 10, endMonth: 1, peakMonth: 11, isWrap: true })).toBe(
      "NOV–FEB"
    );
    expect(formatBestSpan({ startMonth: 5, endMonth: 5, peakMonth: 5, isWrap: false })).toBe(
      "JUN"
    );
    expect(formatBestSpan({ startMonth: 0, endMonth: 11, peakMonth: 3, isWrap: false })).toBe(
      "JAN–DEC"
    );
    expect(formatBestSpan(null)).toBe("—");
  });
});

describe("assembleCityRows (DESIGN §5)", () => {
  const cities = [
    { id: "lisbon-portugal", name: "Lisbon", country: "Portugal", iata: "LIS" },
    { id: "tokyo-japan", name: "Tokyo", country: "Japan", iata: "HND" },
    { id: "quito-ecuador", name: "Quito", country: "Ecuador", iata: "UIO" },
  ];
  const shortlist = [
    { cityId: "lisbon-portugal", name: "Lisbon", country: "Portugal", iata: "LIS" },
    { cityId: "tokyo-japan", name: "Tokyo", country: "Japan", iata: "HND" },
  ];
  const trips = [
    {
      nodes: [
        { cityId: "tokyo-japan", name: "Tokyo", iata: "HND" },
        { cityId: "quito-ecuador", name: "Quito", iata: "UIO" },
      ],
    },
  ];

  it("pins the selected city first with SELECTED badge", () => {
    const rows = assembleCityRows({
      selectedCityId: "tokyo-japan",
      shortlist,
      trips,
      cities,
    });
    expect(rows[0]).toMatchObject({ cityId: "tokyo-japan", badge: "SELECTED" });
  });

  it("dedupes by cityId with SELECTED > SHORTLIST > TRIP precedence", () => {
    const rows = assembleCityRows({
      selectedCityId: "tokyo-japan",
      shortlist,
      trips,
      cities,
    });
    expect(rows.map((r) => r.cityId)).toEqual([
      "tokyo-japan",
      "lisbon-portugal",
      "quito-ecuador",
    ]);
    expect(rows.map((r) => r.badge)).toEqual(["SELECTED", "SHORTLIST", "TRIP"]);
  });

  it("fills trip-row country from the city database", () => {
    const rows = assembleCityRows({ selectedCityId: null, shortlist: [], trips, cities });
    const quito = rows.find((r) => r.cityId === "quito-ecuador");
    expect(quito?.country).toBe("Ecuador");
  });

  it("skips an unknown selected city and returns empty for empty inputs", () => {
    expect(
      assembleCityRows({ selectedCityId: "nowhere", shortlist: [], trips: [], cities })
    ).toEqual([]);
    expect(
      assembleCityRows({ selectedCityId: null, shortlist: [], trips: [], cities: [] })
    ).toEqual([]);
  });
});

describe("sortRows (DESIGN §3.3)", () => {
  const rows: HeatRowDef[] = [
    { cityId: "a", name: "Athens", country: "Greece", badge: "SHORTLIST" },
    { cityId: "b", name: "Bergen", country: "Norway", badge: "SHORTLIST" },
    { cityId: "c", name: "Cusco", country: "Peru", badge: "TRIP" },
  ];
  // Athens: best window starts May (idx 4), peak 90.
  // Bergen: best window starts Jan (idx 0), peak 70.
  // Cusco: uncovered.
  const data = {
    a: months([10, 10, 10, 10, 88, 90, 10, 10, 10, 10, 10, 10]),
    b: months([70, 68, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]),
    c: null,
  };

  it("BEST WINDOW orders by window start month, uncovered last", () => {
    const sorted = sortRows(rows, data, "best");
    expect(sorted.map((r) => r.cityId)).toEqual(["b", "a", "c"]);
  });

  it("PEAK SCORE orders by max score desc, uncovered last", () => {
    const sorted = sortRows(rows, data, "peak");
    expect(sorted.map((r) => r.cityId)).toEqual(["a", "b", "c"]);
  });

  it("A–Z orders alphabetically regardless of coverage", () => {
    const sorted = sortRows(rows, data, "az");
    expect(sorted.map((r) => r.name)).toEqual(["Athens", "Bergen", "Cusco"]);
  });

  it("keeps the SELECTED row pinned first regardless of sort", () => {
    const withSelected: HeatRowDef[] = [
      ...rows,
      { cityId: "z", name: "Zagreb", country: "Croatia", badge: "SELECTED" },
    ];
    const sorted = sortRows(
      withSelected,
      { ...data, z: months(Array(12).fill(50)) },
      "az"
    );
    expect(sorted[0]?.cityId).toBe("z");
  });
});
