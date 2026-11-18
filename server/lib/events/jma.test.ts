import { describe, it, expect, beforeAll } from "vitest";
import type { City } from "../../../src/types";
import { getCities, loadCities } from "../cities";
import {
  buildJmaEvents,
  discoverPages,
  matchStations,
  monthsBetween,
  nextOccurrence,
  normalizeJa,
  parseMapleTable,
  parseSakuraTable,
  seasonDate,
} from "./jma";
import { fixtureText } from "../__fixtures__/liveEvents";

const page = (name: string) => fixtureText(`events/${name}`);
const NOW = new Date("2026-11-18T12:00:00Z");

let cities: City[];
beforeAll(() => {
  loadCities();
  cities = getCities();
});

describe("cherry blossom table (recorded JMA page)", () => {
  const flowering = parseSakuraTable(page("jma-sakura-flowering.html"));
  const bloom = parseSakuraTable(page("jma-sakura-fullbloom.html"));

  it("reads the years from the header and one row per station", () => {
    expect(flowering.years).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
    expect(flowering.rows).toHaveLength(30);
    expect(bloom.years).toEqual(flowering.years);
  });

  it("reads Tokyo: observed 3/14 3/20 3/14 3/29 3/24 3/19 and a normal of 3/24", () => {
    const tokyo = flowering.rows.find((r) => r.station === "東京")!;
    expect(tokyo.observed).toEqual([{ m: 3, d: 14 }, { m: 3, d: 20 }, { m: 3, d: 14 }, { m: 3, d: 29 }, { m: 3, d: 24 }, { m: 3, d: 19 }]);
    expect(tokyo.normal).toEqual({ m: 3, d: 24 });
    expect(bloom.rows.find((r) => r.station === "東京")!.normal).toEqual({ m: 3, d: 31 });
  });

  it("reads a station with no observations as nulls, and the substitute species is ignored", () => {
    const rumoi = flowering.rows.find((r) => r.station === "留萌")!;
    expect(rumoi.observed.every((o) => o === null)).toBe(true);
    expect(rumoi.normal).toBeNull();
    expect(flowering.rows.find((r) => r.station === "札幌")!.normal).toEqual({ m: 5, d: 1 });
  });

  it("copes with another year range in the header", () => {
    const text = "<pre>\n地点名　     2024   2025   平年値   代替種目\n            月 日  月 日   月 日\n\n東京     *   3 29   3 24    3 24    \n</pre>";
    const t = parseSakuraTable(text);
    expect(t.years).toEqual([2024, 2025]);
    expect(t.rows[0]).toMatchObject({ station: "東京", normal: { m: 3, d: 24 } });
  });
});

describe("autumn leaves table (recorded JMA page)", () => {
  const maple = parseMapleTable(page("jma-maple.html"));

  it("reads observed dates and the difference from the normal for 2025 and 2026", () => {
    expect(maple).toHaveLength(25);
    const sapporo = maple.find((r) => r.station === "札幌")!;
    expect(sapporo.years).toEqual([
      { year: 2025, observed: { m: 11, d: 6 }, diffFromNormal: 9 },
      { year: 2026, observed: { m: 11, d: 9 }, diffFromNormal: 12 },
    ]);
  });

  it("reads a year with no observation as null", () => {
    const tokyo = maple.find((r) => r.station === "東京")!;
    expect(tokyo.years[1]).toEqual({ year: 2026, observed: null, diffFromNormal: null });
    expect(tokyo.years[0]!.observed).toEqual({ m: 11, d: 23 });
  });
});

describe("matching stations to cities", () => {
  it("matches a Japanese station name to a city's native name", () => {
    const m = matchStations(["東京", "札幌", "京都", "大阪", "名古屋"], cities);
    expect(m.matched.get("東京")).toBe("tokyo-japan");
    expect(m.matched.get("札幌")).toBe("sapporo-japan");
    expect(m.matched.get("京都")).toBe("kyoto-japan");
    expect(m.unmatched).toEqual([]);
  });

  it("counts a station whose name is no city's native name as unmatched", () => {
    const m = matchStations(["東京", "彦根", "石垣島"], cities);
    expect(m.matched.size).toBe(1);
    expect(m.unmatched).toEqual(["彦根", "石垣島"]);
  });

  it("compares names without width differences or a trailing 市", () => {
    expect(normalizeJa("京都市")).toBe("京都");
    expect(normalizeJa("ＴＯＫＹＯ")).toBe("TOKYO");
  });

  it("only matches cities in Japan, and the biggest when two share a name", () => {
    const fake: City[] = [
      { id: "a-japan", name: "A", country: "Japan", lat: 1, lng: 1, population: 10, nativeName: "大阪" },
      { id: "b-japan", name: "B", country: "Japan", lat: 2, lng: 2, population: 1000, nativeName: "大阪" },
      { id: "c-china", name: "C", country: "China", lat: 3, lng: 3, population: 99999, nativeName: "大阪" },
    ];
    expect(matchStations(["大阪"], fake).matched.get("大阪")).toBe("b-japan");
  });
});

describe("dates", () => {
  it("projects a normal to its next occurrence", () => {
    expect(nextOccurrence({ m: 3, d: 24 }, NOW)).toBe("2027-03-24");
    expect(nextOccurrence({ m: 11, d: 28 }, NOW)).toBe("2026-11-28");
    expect(nextOccurrence({ m: 11, d: 18 }, NOW)).toBe("2026-11-18");
  });

  it("uses the observed date inside the last 30 days or the next 12 months, else the projected normal", () => {
    const normal = { m: 3, d: 24 };
    expect(seasonDate({ year: 2026, md: { m: 3, d: 19 } }, normal, NOW)).toBe("2027-03-24");
    expect(seasonDate({ year: 2026, md: { m: 11, d: 9 } }, { m: 10, d: 28 }, NOW)).toBe("2026-11-09");
    expect(seasonDate({ year: 2027, md: { m: 3, d: 20 } }, normal, NOW)).toBe("2027-03-20");
    expect(seasonDate(undefined, normal, NOW)).toBe("2027-03-24");
  });

  it("gives the months from first flowers to full bloom, in order, at most three", () => {
    expect(monthsBetween({ m: 3, d: 24 }, { m: 3, d: 31 })).toEqual([3]);
    expect(monthsBetween({ m: 3, d: 28 }, { m: 4, d: 4 })).toEqual([3, 4]);
    expect(monthsBetween({ m: 12, d: 28 }, { m: 1, d: 3 })).toEqual([12, 1]);
    expect(monthsBetween({ m: 3, d: 1 }, { m: 9, d: 1 })).toEqual([3]);
  });
});

describe("events from the tables", () => {
  const input = {
    flowering: parseSakuraTable(page("jma-sakura-flowering.html")),
    fullBloom: parseSakuraTable(page("jma-sakura-fullbloom.html")),
    maple: parseMapleTable(page("jma-maple.html")),
  };
  let built: ReturnType<typeof buildJmaEvents>;
  beforeAll(() => {
    built = buildJmaEvents(input, cities, NOW);
  });
  const byId = (id: string) => built.events.find((e) => e.id === id)!;

  it("counts stations and matches", () => {
    expect(built.stations).toEqual({ cherry: 29, maple: 25 });
    expect(built.matched).toEqual({ cherry: 25, maple: 22 });
    expect(built.unmatched.sort()).toEqual(["石垣島", "奈良", "彦根", "高知"].sort());
    expect(built.events).toHaveLength(47);
  });

  it("makes a Tokyo cherry blossom event from the normal, projected to the next season", () => {
    expect(byId("jma-sakura-tokyo-japan")).toMatchObject({
      title: "Cherry blossom",
      kind: "nature",
      cityIds: ["tokyo-japan"],
      month: 3,
      date: "2027-03-24",
      recurring: true,
      tags: ["cherry-blossom", "nature"],
      source: "jma",
      feed: "jma",
    });
    expect(byId("jma-sakura-tokyo-japan").months).toBeUndefined();
    expect(byId("jma-sakura-tokyo-japan").note).toContain("first flowers Mar 24, full bloom Mar 31");
    expect(byId("jma-sakura-tokyo-japan").note).toContain("Observed first flowers Mar 19, 2026");
  });

  it("makes a Sapporo event in May", () => {
    expect(byId("jma-sakura-sapporo-japan")).toMatchObject({ month: 5, date: "2027-05-01" });
  });

  it("derives an autumn leaves normal from the observed date minus the stated difference", () => {
    // Sapporo 2026: observed 11/9, 12 days later than normal, so the normal is 10/28.
    expect(byId("jma-koyo-sapporo-japan")).toMatchObject({ title: "Autumn leaves", month: 10, date: "2026-11-09", recurring: true, tags: ["autumn-leaves", "koyo", "nature"] });
    expect(byId("jma-koyo-sapporo-japan").note).toContain("around Oct 28");
    // Tokyo has no 2026 observation yet: 2025 observed 11/23, 5 days earlier than normal: normal 11/28, still ahead.
    expect(byId("jma-koyo-tokyo-japan")).toMatchObject({ month: 11, date: "2026-11-28" });
  });

  it("skips stations without a normal, and autumn leaf stations without a stated difference", () => {
    // Rumoi has no observations or normal. Its station is not a city's native name either, so it is not counted as unmatched.
    expect(built.stations.cherry).toBe(input.flowering.rows.filter((r) => r.normal).length);
    expect(built.unmatched).not.toContain("留萌");
    expect(built.events.filter((e) => e.id.startsWith("jma-koyo-tokyo")).length).toBe(1);
  });

  it("builds nothing from a missing page and still builds from the others", () => {
    const only = buildJmaEvents({ flowering: input.flowering }, cities, NOW);
    expect(only.events.every((e) => e.id.startsWith("jma-sakura"))).toBe(true);
    expect(only.stations.maple).toBe(0);
    expect(buildJmaEvents({}, cities, NOW).events).toEqual([]);
  });
});

describe("page discovery", () => {
  it("finds the table pages in the index, whichever suffix they carry", () => {
    expect(discoverPages(page("jma-index.html"))).toEqual({ flowering: "sakura003_07.html", fullBloom: "sakura004_07.html", maple: "phn_014.html" });
    expect(discoverPages('<a href="sakura003_07.html">x</a><a href="sakura003_08.html">y</a>').flowering).toBe("sakura003_08.html");
  });

  it("falls back to the known names when the index lists none", () => {
    expect(discoverPages("<html></html>")).toEqual({ flowering: "sakura003_07.html", fullBloom: "sakura004_07.html", maple: "phn_014.html" });
  });
});
