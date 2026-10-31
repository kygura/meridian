import { describe, expect, it } from "vitest";
import { countryKey, displayCountry } from "./countryNames";
import {
  filterNewsByRegion,
  formatNewsTime,
  isMockNews,
  newsAgeMinutes,
  newsForCountry,
  newsPlace,
  regionFromContinent,
} from "./newsRegions";
import { dashPath } from "./dashPath";
import { onWatchPrefill, peekWatchPrefill, setWatchPrefill, takeWatchPrefill } from "./watchPrefill";

describe("countryNames", () => {
  it("joins csv, Natural Earth and common spellings", () => {
    expect(countryKey("Korea, South")).toBe(countryKey("Republic of Korea"));
    expect(countryKey("Burma")).toBe(countryKey("Myanmar"));
    expect(countryKey("Côte D’Ivoire")).toBe(countryKey("Ivory Coast"));
    expect(countryKey("Czechia")).toBe(countryKey("Czech Rep."));
    expect(countryKey("Congo (Kinshasa)")).toBe(countryKey("Dem. Rep. Congo"));
    expect(countryKey("United States")).toBe(countryKey("United States of America"));
    expect(countryKey("  Japan ")).toBe("japan");
  });

  it("formats csv names for people", () => {
    expect(displayCountry("Korea, South")).toBe("South Korea");
    expect(displayCountry("Bosnia And Herzegovina")).toBe("Bosnia and Herzegovina");
    expect(displayCountry("Portugal")).toBe("Portugal");
    expect(displayCountry(undefined)).toBe("");
  });
});

describe("newsRegions", () => {
  const items = [
    { location: "JAPAN", text: "a", glyph: "info" as const, time: "5m" },
    { location: "S.KOREA", text: "b", glyph: "info" as const, time: "2h" },
    { location: "MIDEAST", text: "c", glyph: "alert" as const, time: "1d" },
    { location: "WORLD", text: "d", glyph: "info" as const, time: "now" },
    { location: "UK", text: "e", glyph: "good" as const, time: "3d" },
  ];

  it("resolves labels to places", () => {
    expect(newsPlace("S.KOREA")).toEqual({ name: "South Korea", country: "Korea, South", region: "asia" });
    expect(newsPlace("WORLD").region).toBeNull();
    expect(newsPlace("ATLANTIS")).toEqual({ name: "Atlantis", region: null });
    expect(newsPlace(undefined).name).toBe("World");
  });

  it("filters by region and country", () => {
    expect(filterNewsByRegion(items, null)).toHaveLength(5);
    expect(filterNewsByRegion(items, "asia").map((i) => i.text)).toEqual(["a", "b"]);
    expect(filterNewsByRegion(items, "middle-east").map((i) => i.text)).toEqual(["c"]);
    expect(newsForCountry(items, "Korea, South").map((i) => i.text)).toEqual(["b"]);
    expect(newsForCountry(items, "United Kingdom").map((i) => i.text)).toEqual(["e"]);
    expect(newsForCountry(items, "Peru")).toEqual([]);
  });

  it("maps Natural Earth continents", () => {
    expect(regionFromContinent("Asia", "Western Asia")).toBe("middle-east");
    expect(regionFromContinent("South America")).toBe("americas");
    expect(regionFromContinent("Antarctica")).toBeNull();
  });

  it("formats times in plain words and sorts by age", () => {
    expect(formatNewsTime("now")).toBe("Just now");
    expect(formatNewsTime("12m")).toBe("12 min ago");
    expect(formatNewsTime("1h")).toBe("1 hour ago");
    expect(formatNewsTime("5h")).toBe("5 hours ago");
    expect(formatNewsTime("1d")).toBe("Yesterday");
    expect(formatNewsTime("4d")).toBe("4 days ago");
    expect(formatNewsTime("—")).toBe("");
    expect(newsAgeMinutes("2h")).toBe(120);
    expect(newsAgeMinutes("x")).toBe(Number.POSITIVE_INFINITY);
  });

  it("detects the server's sample headlines", () => {
    expect(isMockNews([{ source: undefined, url: undefined }])).toBe(true);
    expect(isMockNews([{ source: "BBC", url: "https://x" }])).toBe(false);
    expect(isMockNews([])).toBe(false);
  });
});

describe("dashPath", () => {
  it("cuts a long line into several dashes", () => {
    const pieces = dashPath([[0, 0], [90, 0]], 2);
    // 90° at zoom 2 is 512px -> about 512 / 14 = 36 dashes.
    expect(pieces.length).toBeGreaterThan(30);
    expect(pieces.length).toBeLessThan(40);
    for (const p of pieces) expect(p.length).toBeGreaterThanOrEqual(2);
    expect(pieces[0][0][0]).toBeCloseTo(0, 6);
  });

  it("keeps dashes about the requested length on screen", () => {
    const [first] = dashPath([[0, 0], [90, 0]], 3, 10, 5);
    const lngSpan = first[first.length - 1][0] - first[0][0];
    // zoom 3 -> 4096 px per 360°, so 10px ≈ 0.879°.
    expect(lngSpan).toBeCloseTo((10 / 4096) * 360, 3);
  });

  it("returns short paths whole and ignores degenerate input", () => {
    const short: [number, number][] = [[0, 0], [0.001, 0]];
    expect(dashPath(short, 1)).toEqual([short]);
    expect(dashPath([[1, 1]], 3)).toEqual([]);
  });

  it("walks across multi-point paths", () => {
    const pieces = dashPath([[0, 0], [10, 0], [10, 10]], 4);
    expect(pieces.length).toBeGreaterThan(5);
  });
});

describe("watchPrefill", () => {
  it("hands a city over once", () => {
    const seen: (string | undefined)[] = [];
    const off = onWatchPrefill((p) => seen.push(p?.cityId));
    setWatchPrefill({ cityId: "lisbon-portugal" });
    expect(peekWatchPrefill()?.cityId).toBe("lisbon-portugal");
    expect(takeWatchPrefill()?.cityId).toBe("lisbon-portugal");
    expect(takeWatchPrefill()).toBeNull();
    off();
    setWatchPrefill({ cityId: "x" });
    expect(seen).toEqual(["lisbon-portugal"]);
    setWatchPrefill(null);
  });
});
