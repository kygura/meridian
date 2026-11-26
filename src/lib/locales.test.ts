import { describe, expect, it } from "vitest";
import type { MapAnomaly } from "../types";
import type { PlaceProfile } from "./rotation";
import { staySpan } from "./rotation";
import {
  LOCALES,
  bestForMonth,
  crowdsFromEvents,
  daysInMonth,
  hazardHits,
  localeById,
  localeMonth,
  localeYear,
  monthRuns,
  percentileOf,
  researchRanks,
  researchScore,
  SCORE_WEIGHTS,
  rangeSegments,
  spanSegments,
  stayFromLocale,
  stayWindows,
  weekLevels,
  weekRange,
  weeksText,
  windowSegments,
  type Locale,
  type LocaleSignals,
  type StayWindow,
  type ResearchLevel,
} from "./locales";
import cityData from "../../data/city-data.json";

const R = (s: string): ResearchLevel[] => [...s].map((c) => ({ b: "best", g: "good", f: "fair", a: "avoid" })[c] as ResearchLevel);

/** Comfort scores from letters: G great (90), o good (70), f fair (55), p poor (30). */
const C = (s: string) => {
  const scores = [...s].map((c) => ({ G: 90, o: 70, f: 55, p: 30 })[c]!);
  return () => scores.map((score) => ({ score }));
};

const make = (over: Partial<Locale> = {}): Locale => ({
  id: "x",
  name: "X",
  country: "Thailand",
  region: "SE & East Asia",
  role: "base",
  cityIds: ["chiang-mai-thailand"],
  summary: "",
  months: R("gaaafffffgbb"),
  monthNotes: [{ months: [2, 3, 4], kind: "avoid", reason: "burning season" }],
  scores: { climate: 5, air: 5, cost: 5, safety: 5, health: 5, internet: 5, food: 5, nomad: 5, longstay: 5 },
  sources: [],
  stay: { minWeeks: 4, idealWeeks: 12, maxWeeks: 26, why: "" },
  ...over,
});

const year = (l: Locale, sig: LocaleSignals) => localeYear(l, sig);

describe("dataset", () => {
  it("has twelve months, a known role and real city ids for every locale", () => {
    const cities = (cityData as { cities: Record<string, unknown> }).cities;
    expect(LOCALES.length).toBeGreaterThanOrEqual(20);
    for (const l of LOCALES) {
      expect(l.months).toHaveLength(12);
      expect(["base", "hub", "destination"]).toContain(l.role);
      expect(l.stay.minWeeks).toBeLessThanOrEqual(l.stay.idealWeeks);
      expect(l.stay.idealWeeks).toBeLessThanOrEqual(l.stay.maxWeeks);
      for (const id of l.cityIds) expect(cities[id], `${l.id}: ${id}`).toBeTruthy();
      for (const n of l.monthNotes) for (const m of n.months) expect(m >= 1 && m <= 12).toBe(true);
      // Every month is explained by a note of its own rating.
      for (let m = 1; m <= 12; m++) expect(l.monthNotes.some((n) => n.months.includes(m) && n.kind === l.months[m - 1]), `${l.id} month ${m}`).toBe(true);
      for (const v of Object.values(l.scores)) expect(v >= 1 && v <= 10, `${l.id} score ${v}`).toBe(true);
      expect(Object.keys(l.scores).sort()).toEqual(Object.keys(SCORE_WEIGHTS).sort());
      expect(l.sources.length, `${l.id} sources`).toBeGreaterThan(0);
    }
    expect(new Set(LOCALES.map((l) => l.id)).size).toBe(LOCALES.length);
  });
});

describe("localeMonth: Meridian's data scores, the field check does not", () => {
  const l = make();

  it("scores from the Comfort Index and carries the field check unscored", () => {
    const m = localeMonth(l, 3, { comfort: C("GGGGGGGGGGGG") });
    expect(m).toMatchObject({ level: "great", source: "comfort", comfort: 90 });
    expect(m.research).toMatchObject({ level: "avoid", text: "burning season" });
    expect(m.researchDiffers).toBe(true);
    expect(localeMonth(l, 12, { comfort: C("GGGGGGGGGGGG") }).researchDiffers).toBe(false);
  });

  it("lowers a month a hazard reaches: one level at watch, to avoid at caution", () => {
    const comfort = C("GGGGGGGGGGGG");
    const watch = { label: "Haze", months: [3], score: 1, km: 10 };
    const caution = { label: "Haze", months: [3], score: 2, km: 10 };
    expect(localeMonth(l, 3, { comfort, hazards: [watch] })).toMatchObject({ level: "good", hazard: { label: "Haze" } });
    expect(localeMonth(l, 3, { comfort, hazards: [caution] }).level).toBe("avoid");
    expect(localeMonth(l, 4, { comfort, hazards: [caution] }).level).toBe("great");
    expect(localeMonth(l, 3, { comfort, hazards: [{ ...watch, score: 0.5 }] }).level).toBe("great");
  });

  it("lets the owner's rotation window win", () => {
    const profile: PlaceProfile = { cityId: "chiang-mai-thailand", name: "Chiang Mai", windows: [{ id: "w", kind: "peak", months: { start: 3, end: 3 }, reason: "festival" }] };
    expect(localeMonth(l, 3, { profile, comfort: C("pppppppppppp") })).toMatchObject({ level: "great", source: "personal", why: "Your peak: festival" });
  });

  it("is unknown without comfort data, whatever the field check says", () => {
    expect(localeMonth(l, 12)).toMatchObject({ level: "unknown", source: "none" });
  });

  it("keeps the measured tourist season", () => {
    const crowds = Array.from({ length: 12 }, (_, i) => (i === 0 ? ("high" as const) : ("low" as const)));
    expect(localeMonth(l, 1, { comfort: C("GGGGGGGGGGGG"), crowds }).tourism).toBe("high");
  });
});

describe("hazardHits", () => {
  const a = (over: Partial<MapAnomaly>): MapAnomaly => ({ id: "h", kind: "hazard", label: "Haze", lat: 18.8, lng: 99, severity: 2, months: [2, 3, 4], ...over });
  it("scores seasonal hazards by severity and distance, ignoring standing ones", () => {
    const hits = hazardHits(18.79, 98.98, [a({}), a({ id: "c", kind: "conflict", months: undefined }), a({ id: "far", lat: -30, lng: 20 })]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ label: "Haze", score: 2, km: 2 });
  });
});

describe("crowdsFromEvents", () => {
  it("reads peak and shoulder tourism seasons; low elsewhere; nothing when unmeasured", () => {
    const c = crowdsFromEvents([
      { kind: "season", tags: ["peak-season"], month: 7, months: [7, 8] },
      { kind: "season", tags: ["shoulder-season"], month: 6, months: [6, 9] },
      { kind: "festival", tags: [], month: 3 },
    ])!;
    expect(c[6]).toBe("high");
    expect(c[5]).toBe("shoulder");
    expect(c[0]).toBe("low");
    expect(crowdsFromEvents([{ kind: "festival", tags: [], month: 3 }])).toBeUndefined();
  });
});

describe("weekLevels", () => {
  it("bins 52 weekly scores, and gives null otherwise", () => {
    expect(weekLevels(Array.from({ length: 52 }, () => ({ score: 90 })))![0]).toBe("great");
    expect(weekLevels(null)).toBeNull();
    expect(weekLevels([{ score: 1 }])).toBeNull();
  });
});

describe("monthRuns", () => {
  it("joins runs across the new year", () => {
    const set = new Set([10, 11, 12, 1, 5]);
    expect(monthRuns((m) => set.has(m))).toEqual([[5], [10, 11, 12, 1]]);
  });
  it("gives one run for a whole year and none for an empty one", () => {
    expect(monthRuns(() => true)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]);
    expect(monthRuns(() => false)).toEqual([]);
  });
});

describe("stayWindows", () => {
  it("cuts the stay to the run of good months and places it on the best ones", () => {
    const l = make();
    const [w] = stayWindows(l, year(l, { comfort: C("opppfffffoGG") }));
    expect(w.run).toEqual({ start: 10, end: 1 });
    expect(w.great).toBe(2);
    expect(w.weeks.max).toBeCloseTo(4 * 4.348, 1);
    expect(w.stay).toEqual({ start: 10, end: 12 });
    expect(w.capped).toBe(false);
  });

  it("caps the stay at the passport's day limit", () => {
    const l = make();
    const [w] = stayWindows(l, year(l, { comfort: C("GGGGGGGGGGGG") }), 30);
    expect(w.weeks.max).toBeCloseTo(30 / 7, 1);
    expect(w.weeks.min).toBe(4);
    expect(w.capped).toBe(true);
    expect(w.stay.start).toBe(w.stay.end);
  });

  it("falls back to fair months, marked", () => {
    const l = make();
    const [w] = stayWindows(l, year(l, { comfort: C("ffffpppppppp") }));
    expect(w.fallback).toBe(true);
    expect(w.run).toEqual({ start: 1, end: 4 });
  });

  it("lets Beauty justify a base on the most tolerable months when none is even fair", () => {
    const l = make();
    const comfort = () => [30, 28, 10, 0, 0, 0, 0, 0, 0, 5, 20, 35].map((score) => ({ score }));
    const [w] = stayWindows(l, year(l, { comfort }), null, 1, 90);
    expect(w.relative).toBe(true);
    expect(w.run).toEqual({ start: 12, end: 2 });
    expect(stayWindows(l, year(l, { comfort }), null, 1, 60)).toEqual([]);
    expect(stayWindows(l, year(l, { comfort }))).toEqual([]);
  });

  it("widens a thin fair window to the most tolerable months for a beautiful place", () => {
    const l = make();
    const comfort = () => [55, 48, 46, 20, 0, 0, 0, 0, 0, 10, 30, 47].map((score) => ({ score }));
    expect(stayWindows(l, year(l, { comfort }))[0]).toMatchObject({ run: { start: 1, end: 1 }, fallback: true, relative: false });
    const ws = stayWindows(l, year(l, { comfort }), null, 1, 95);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ run: { start: 12, end: 3 }, fallback: false, relative: true });
  });

  it("ranks windows with more great months first", () => {
    const l = make();
    const ws = stayWindows(l, year(l, { comfort: C("ooppppGGpppp") }));
    expect(ws.map((w) => w.run.start)).toEqual([7, 1]);
  });

  it("prefers the frame with fewer tourist-peak months on a tie, then the soonest", () => {
    const m = make({ stay: { minWeeks: 4, idealWeeks: 4, maxWeeks: 8, why: "" } });
    const crowds = Array.from({ length: 12 }, (_, i) => (i < 6 ? ("high" as const) : ("low" as const)));
    expect(stayWindows(m, year(m, { comfort: C("GGGGGGGGGGGG"), crowds }))[0].stay).toEqual({ start: 7, end: 7 });
    expect(stayWindows(m, year(m, { comfort: C("GGGGGGGGGGGG") }), null, 11)[0].stay).toEqual({ start: 11, end: 11 });
  });
});

describe("weeksText", () => {
  it("speaks days for hubs and weeks for bases", () => {
    expect(weeksText({ min: 0.3, max: 1.5 })).toBe("2–11 days");
    expect(weeksText({ min: 6, max: 13 })).toBe("6–13 wk");
  });
});

describe("percentileOf", () => {
  it("is the share of values at or below", () => {
    expect(percentileOf(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(50);
    expect(percentileOf(undefined, [1])).toBeNull();
  });
});

describe("bestForMonth", () => {
  it("counts a worth-it window as fair and breaks ties by Beauty", () => {
    const a = make({ id: "a", name: "A" });
    const b = make({ id: "b", name: "B" });
    const c = make({ id: "c", name: "C" });
    const comfort = () => C("pppppppppppp")();
    const years = new Map([a, b, c].map((l) => [l.id, year(l, { comfort })]));
    const worth = { run: { start: 1, end: 2 }, relative: true } as unknown as StayWindow;
    const picks = bestForMonth([a, b, c], years, 1, { beauty: new Map([["b", 70], ["c", 90]]), windows: new Map([["a", [worth]]]) });
    expect(picks.map((p) => p.locale.id)).toEqual(["a", "c", "b"]);
  });
  it("ranks by fit, then name", () => {
    const a = make({ id: "a", name: "A" });
    const b = make({ id: "b", name: "B", cityIds: ["bangkok-thailand"] });
    const comfort = (id: string) => (id === "bangkok-thailand" ? C("GGGGGGGGGGGG")() : C("pppppppppppp")());
    const years = new Map([a, b].map((l) => [l.id, year(l, { comfort })]));
    expect(bestForMonth([a, b], years, 6).map((p) => p.locale.id)).toEqual(["b", "a"]);
  });
});

describe("stayFromLocale", () => {
  const great = { comfort: C("GGGGGGGGGGGG") };
  it("makes an idea stay with the window's next occurrence and the field check's budget", () => {
    const l = localeById("chiang-mai")!;
    const [w] = stayWindows(l, year(l, great));
    const place = { cityId: "chiang-mai-thailand", name: "Chiang Mai", country: "Thailand", iata: "CNX", lat: 18.79, lng: 98.98 };
    const s = stayFromLocale(l, place, w, "2026-11-26");
    expect(s.status).toBe("idea");
    expect(s.kind).toBe("base");
    expect(s.budgetMonthly).toEqual({ amount: l.cost!.max, currency: "EUR" });
    expect(staySpan(s)!.end > "2026-11-26").toBe(true);
    expect(s.minNights!).toBeLessThanOrEqual(s.maxNights!);
  });

  it("makes a hub a pass-through", () => {
    const l = localeById("bangkok")!;
    const [w] = stayWindows(l, year(l, great));
    const s = stayFromLocale(l, { cityId: "bangkok-thailand", name: "Bangkok", lat: 13.75, lng: 100.5 }, w, "2026-11-26");
    expect(s.kind).toBe("pass-through");
    expect(s.maxNights!).toBeLessThanOrEqual(11);
  });
});

describe("day windows", () => {
  it("counts a window's days in a month, wrapping the new year", () => {
    expect(daysInMonth({ from: "11-01", to: "02-14" }, 12)).toBe(31);
    expect(daysInMonth({ from: "11-01", to: "02-14" }, 2)).toBe(14);
    expect(daysInMonth({ from: "03-25", to: "04-10" }, 4)).toBe(10);
  });
});

describe("field check rank", () => {
  it("weights sum to one, so the overall stays on the 1–10 scale", () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(researchScore(make())).toBe(5);
  });

  it("ranks within a role, best first", () => {
    const hi = make({ id: "hi", name: "Hi", scores: { ...make().scores, climate: 9 } });
    const lo = make({ id: "lo", name: "Lo" });
    const hub = make({ id: "hub", name: "Hub", role: "hub" });
    const r = researchRanks([lo, hi, hub]);
    expect([r.get("hi"), r.get("lo"), r.get("hub")]).toEqual([1, 2, 1]);
  });
});

describe("segments", () => {
  const close = (got: { left: number; width: number }[], want: [number, number][]) => {
    expect(got).toHaveLength(want.length);
    got.forEach((g, i) => {
      expect(g.left * 12).toBeCloseTo(want[i][0], 3);
      expect(g.width * 12).toBeCloseTo(want[i][1], 3);
    });
  };

  it("places a window in months from the calendar's start", () => {
    close(windowSegments({ from: "03-01", to: "05-31" }, 1), [[2, 3]]);
    close(windowSegments({ from: "03-01", to: "05-31" }, 11), [[4, 3]]);
  });

  it("splits a window that crosses the calendar's start, and joins one that wraps the year", () => {
    close(windowSegments({ from: "11-01", to: "02-14" }, 12), [[0, 2.5], [11, 1]]);
    close(windowSegments({ from: "11-01", to: "02-14" }, 1), [[0, 1.5], [10, 2]]);
    close(windowSegments({ from: "01-01", to: "12-31" }, 7), [[0, 12]]);
  });

  it("draws a month span as whole months and the year's weeks end to end", () => {
    close(spanSegments({ start: 11, end: 1 }, 11), [[0, 3]]);
    const total = Array.from({ length: 52 }, (_, i) => rangeSegments([weekRange(i)], 11)).flat().reduce((a, g) => a + g.width, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});
