import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY,
  countryTint,
  dryness,
  filterCount,
  filtersActive,
  greenness,
  matchesCity,
  matchingMonths,
  monthConditions,
  normalizeOverlay,
  visibleConflicts,
  visibleDisasters,
  visibleEvents,
  type CityProfile,
  type ClimateMonth,
  type OverlayConfig,
} from "./overlayConfig";
import type { MeridianEvent } from "../types";

const month = (tempC: number, precipMm: number, score = 50): ClimateMonth => ({ tempC, precipMm, score });
/** 12 months: dry warm Jan-Jun, wet hot Jul-Dec. */
const monsoonal: CityProfile = {
  climate: [...Array(6).fill(month(28, 10, 80)), ...Array(6).fill(month(33, 220, 30))],
  scores: { stability: 80, connectivity: 40 },
};
const cfg = (patch: Partial<OverlayConfig>): OverlayConfig => ({ ...DEFAULT_OVERLAY, ...patch });

describe("weather derivations", () => {
  it("greenness needs both rain and warmth, and fades in extreme heat", () => {
    expect(greenness(25, 150)).toBe(100);
    expect(greenness(25, 10)).toBe(0);
    expect(greenness(-5, 200)).toBe(0);
    expect(greenness(38, 150)).toBeLessThan(greenness(30, 150));
  });
  it("dryness runs 100 (no rain) to 0 (100 mm+)", () => {
    expect(dryness(0)).toBe(100);
    expect(dryness(50)).toBe(50);
    expect(dryness(300)).toBe(0);
  });
  it("tags a month with one temperature band and one moisture band", () => {
    const tags = monthConditions(month(28, 10));
    expect(tags).toContain("warm");
    expect(tags).toContain("arid");
    expect(tags).not.toContain("hot");
    expect(monthConditions(month(-4, 60))).toEqual(expect.arrayContaining(["freezing", "damp", "snowy"]));
  });
});

describe("matchesCity", () => {
  it("matches everything when no filter is set", () => {
    expect(matchesCity(DEFAULT_OVERLAY, { scores: {} }, 3)).toBe(true);
    expect(filtersActive(DEFAULT_OVERLAY)).toBe(false);
  });
  it("ORs conditions within a group and ANDs across groups", () => {
    const warmOrHotAndDry = cfg({ conditions: ["warm", "hot", "dry", "arid"] });
    expect(matchesCity(warmOrHotAndDry, monsoonal, 3)).toBe(true); // warm + arid
    expect(matchesCity(warmOrHotAndDry, monsoonal, 9)).toBe(false); // hot but wet
    expect(matchesCity(cfg({ conditions: ["cold"] }), monsoonal, 3)).toBe(false);
  });
  it("applies month scope: this month, any month, year-round", () => {
    const wet = cfg({ conditions: ["wet"] });
    expect(matchesCity({ ...wet, monthScope: "month" }, monsoonal, 2)).toBe(false);
    expect(matchesCity({ ...wet, monthScope: "any" }, monsoonal, 2)).toBe(true);
    expect(matchesCity({ ...wet, monthScope: "all" }, monsoonal, 2)).toBe(false);
    expect(matchesCity(cfg({ conditions: ["warm", "hot"], monthScope: "all" }), monsoonal, 2)).toBe(true);
  });
  it("filters on weather and society ranges", () => {
    expect(matchesCity(cfg({ ranges: { temperature: [30, 45] } }), monsoonal, 8)).toBe(true);
    expect(matchesCity(cfg({ ranges: { temperature: [30, 45] } }), monsoonal, 2)).toBe(false);
    expect(matchesCity(cfg({ ranges: { stability: [70, 100] } }), monsoonal, 2)).toBe(true);
    expect(matchesCity(cfg({ ranges: { connectivity: [60, 100] } }), monsoonal, 2)).toBe(false);
  });
  it("never matches a city that lacks the data a filter needs", () => {
    expect(matchesCity(cfg({ conditions: ["warm"] }), { scores: { stability: 90 } }, 1)).toBe(false);
    expect(matchesCity(cfg({ ranges: { cost: [50, 100] } }), monsoonal, 1)).toBe(false);
  });
  it("lists the months that pass", () => {
    expect(matchingMonths(cfg({ conditions: ["wet"] }), monsoonal)).toEqual([7, 8, 9, 10, 11, 12]);
  });
  it("counts a group of conditions as one filter", () => {
    expect(filterCount(cfg({ conditions: ["warm", "hot", "dry"], ranges: { stability: [60, 100] } }))).toBe(3);
  });
});

describe("countryTint", () => {
  it("averages ramp positions per country and skips cities without data", () => {
    const cities = [
      { id: "a", country: "Spain" },
      { id: "b", country: "Spain" },
      { id: "c", country: "Korea, South" },
      { id: "d", country: "Peru" },
    ];
    const profiles = new Map<string, CityProfile>([
      ["a", { scores: { stability: 40 } }],
      ["b", { scores: { stability: 80 } }],
      ["c", { scores: { stability: 100 } }],
    ]);
    const t = countryTint(cities, profiles, "stability", 1);
    expect(t.get("spain")).toBe(60);
    expect(t.get("south korea")).toBe(100);
    expect(t.has("peru")).toBe(false);
  });
  it("normalizes temperature over its domain", () => {
    const profiles = new Map<string, CityProfile>([["a", { climate: Array(12).fill(month(7.5, 0)), scores: {} }]]);
    expect(countryTint([{ id: "a", country: "X" }], profiles, "temperature", 5).get("x")).toBe(50);
  });
});

describe("normalizeOverlay", () => {
  it("falls back to defaults for junk and drops unknown ids", () => {
    expect(normalizeOverlay(undefined)).toEqual(DEFAULT_OVERLAY);
    const n = normalizeOverlay({
      tint: "nonsense",
      conditions: ["warm", "bogus"],
      monthScope: "x",
      ranges: { temperature: [99, -99], nope: [1, 2], stability: [1] },
      signals: { eventKinds: ["festival", "zzz"], minSeverity: 7 },
    });
    expect(n.tint).toBe("comfort");
    expect(n.conditions).toEqual(["warm"]);
    expect(n.monthScope).toBe("month");
    expect(n.ranges).toEqual({ temperature: [-30, 45] });
    expect(n.signals.eventKinds).toEqual(["festival"]);
    expect(n.signals.minSeverity).toBe(1);
  });
});

describe("signals", () => {
  const ev = (id: string, m: number, kind: MeridianEvent["kind"]): MeridianEvent => ({ id, title: id, kind, cityIds: ["x"], month: m, recurring: true, tags: [] });
  const events = [ev("a", 3, "festival"), ev("b", 3, "eclipse"), ev("c", 8, "festival")];
  const s = { ...DEFAULT_OVERLAY.signals, events: true };
  it("hides everything when the toggle is off", () => {
    expect(visibleEvents(events, DEFAULT_OVERLAY.signals, 3)).toEqual([]);
  });
  it("filters events by month and kind", () => {
    expect(visibleEvents(events, s, 3).map((e) => e.id)).toEqual(["a", "b"]);
    expect(visibleEvents(events, { ...s, eventsThisMonthOnly: false }, 3)).toHaveLength(3);
    expect(visibleEvents(events, { ...s, eventKinds: ["eclipse"] }, 3).map((e) => e.id)).toEqual(["b"]);
  });
  it("filters conflicts and disasters by severity and disaster type", () => {
    const items = [
      { lat: 0, lng: 0, label: "a", sev: 1, type: "quake" },
      { lat: 0, lng: 0, label: "b", sev: 3, type: "storm" },
    ];
    expect(visibleConflicts(items, { ...DEFAULT_OVERLAY.signals, conflicts: true, minSeverity: 2 }).map((p) => p.label)).toEqual(["b"]);
    expect(visibleDisasters(items, { ...DEFAULT_OVERLAY.signals, disasters: true, disasterTypes: ["quake"] }).map((p) => p.label)).toEqual(["a"]);
    expect(visibleDisasters(items, DEFAULT_OVERLAY.signals)).toEqual([]);
  });
});
