import { describe, expect, it } from "vitest";
import type { PlaceProfile } from "./rotation";
import { staySpan } from "./rotation";
import {
  LOCALES,
  bestForMonth,
  localeById,
  localeMonth,
  localeYear,
  daysInMonth,
  monthRuns,
  seasonFor,
  spanSegments,
  windowSegments,
  stayFromLocale,
  stayWindows,
  weeksText,
  type Locale,
  type ResearchLevel,
} from "./locales";
import cityData from "../../data/city-data.json";

const R = (s: string): ResearchLevel[] => [...s].map((c) => ({ b: "best", g: "good", f: "fair", a: "avoid" })[c] as ResearchLevel);

const make = (months: string, over: Partial<Locale> = {}): Locale => ({
  id: "x",
  name: "X",
  country: "Thailand",
  region: "SE & East Asia",
  role: "base",
  cityIds: ["chiang-mai-thailand"],
  summary: "",
  months: R(months),
  notes: [{ months: [2, 3, 4], kind: "avoid", reason: "burning season" }],
  stay: { minWeeks: 4, idealWeeks: 12, maxWeeks: 26, why: "" },
  ...over,
});

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
      for (const n of l.notes) for (const m of n.months) expect(m >= 1 && m <= 12).toBe(true);
    }
    expect(new Set(LOCALES.map((l) => l.id)).size).toBe(LOCALES.length);
  });
});

describe("localeMonth", () => {
  const l = make("gaaafffffgbb");

  it("reads the research and its note", () => {
    expect(localeMonth(l, 3)).toMatchObject({ level: "avoid", source: "research", why: "burning season" });
    expect(localeMonth(l, 12)).toMatchObject({ level: "great", source: "research" });
  });

  it("lets a personal window override the research", () => {
    const profile: PlaceProfile = { cityId: "chiang-mai-thailand", name: "Chiang Mai", windows: [{ id: "w", kind: "peak", months: { start: 3, end: 3 }, reason: "festival" }] };
    expect(localeMonth(l, 3, profile)).toMatchObject({ level: "great", source: "personal", why: "Your peak: festival" });
  });

  it("flags when the Comfort Index disagrees by two levels or more", () => {
    const comfort = () => Array.from({ length: 12 }, () => ({ score: 10 }));
    expect(localeMonth(l, 12, undefined, comfort)).toMatchObject({ comfort: 10, disagrees: true });
    expect(localeMonth(l, 6, undefined, comfort)).toMatchObject({ disagrees: false });
  });

  it("falls back to the Comfort Index, then unknown", () => {
    const blank = { ...l, months: [] as ResearchLevel[] };
    expect(localeMonth(blank, 5, undefined, () => Array.from({ length: 12 }, () => ({ score: 90 })))).toMatchObject({ level: "great", source: "comfort" });
    expect(localeMonth(blank, 5)).toMatchObject({ level: "unknown", source: "none" });
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
    const l = make("gaaafffffgbb");
    const [w] = stayWindows(l, localeYear(l));
    expect(w.run).toEqual({ start: 10, end: 1 });
    expect(w.great).toBe(2);
    expect(w.weeks.max).toBeCloseTo(4 * 4.348, 1);
    expect(w.stay).toEqual({ start: 10, end: 12 });
    expect(w.capped).toBe(false);
  });

  it("caps the stay at the passport's day limit", () => {
    const l = make("bbbbbbbbbbbb");
    const [w] = stayWindows(l, localeYear(l), 30);
    expect(w.weeks.max).toBeCloseTo(30 / 7, 1);
    expect(w.weeks.min).toBe(4);
    expect(w.capped).toBe(true);
    expect(w.stay.start).toBe(w.stay.end);
  });

  it("falls back to fair months, marked", () => {
    const l = make("ffffaaaaaaaa");
    const [w] = stayWindows(l, localeYear(l));
    expect(w.fallback).toBe(true);
    expect(w.run).toEqual({ start: 1, end: 4 });
  });

  it("ranks windows with more great months first", () => {
    const l = make("ggaaaabbaaaa");
    const ws = stayWindows(l, localeYear(l));
    expect(ws.map((w) => w.run.start)).toEqual([7, 1]);
  });
});

describe("weeksText", () => {
  it("speaks days for hubs and weeks for bases", () => {
    expect(weeksText({ min: 0.3, max: 1.5 })).toBe("2–11 days");
    expect(weeksText({ min: 6, max: 13 })).toBe("6–13 wk");
  });
});

describe("bestForMonth", () => {
  it("ranks by fit, then the owner's score", () => {
    const a = make("bbbbbbbbbbbb", { id: "a", name: "A", scores: { climate: 1, health: 1, food: 1, cost: 1, connect: 1, safe: 1, qol: 1, overall: 7 } });
    const b = make("bbbbbbbbbbbb", { id: "b", name: "B", scores: { climate: 1, health: 1, food: 1, cost: 1, connect: 1, safe: 1, qol: 1, overall: 8 } });
    const c = make("aaaaaaaaaaaa", { id: "c", name: "C" });
    const years = new Map([a, b, c].map((l) => [l.id, localeYear(l)]));
    expect(bestForMonth([a, b, c], years, 6).map((p) => p.locale.id)).toEqual(["b", "a", "c"]);
  });
});

describe("stayFromLocale", () => {
  it("makes an idea stay with the window's next occurrence and the research's budget", () => {
    const l = localeById("chiang-mai")!;
    const [w] = stayWindows(l, localeYear(l));
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
    const [w] = stayWindows(l, localeYear(l));
    const s = stayFromLocale(l, { cityId: "bangkok-thailand", name: "Bangkok", lat: 13.75, lng: 100.5 }, w, "2026-11-26");
    expect(s.kind).toBe("pass-through");
    expect(s.maxNights!).toBeLessThanOrEqual(11);
  });
});

describe("Travel Seasons windows", () => {
  const l = make("gaaafffffgbb", {
    seasons: [
      { kind: "peak", tourism: "high", from: "11-01", to: "02-14", title: "Dry peak" },
      { kind: "avoid", tourism: "low", from: "02-15", to: "04-30", title: "Burning season" },
    ],
  });

  it("counts a window's days in a month, wrapping the new year", () => {
    expect(daysInMonth({ from: "11-01", to: "02-14" }, 12)).toBe(31);
    expect(daysInMonth({ from: "11-01", to: "02-14" }, 2)).toBe(14);
    expect(daysInMonth({ from: "02-15", to: "04-30" }, 2)).toBe(14);
    expect(daysInMonth({ from: "03-25", to: "04-10" }, 4)).toBe(10);
  });

  it("sets a month when a window covers half of it, avoid winning ties", () => {
    expect(seasonFor(l, 1)?.title).toBe("Dry peak");
    expect(seasonFor(l, 2)?.title).toBe("Burning season");
    expect(seasonFor(l, 6)).toBeUndefined();
  });

  it("reads the windows before the research and keeps their tourist season", () => {
    expect(localeMonth(l, 1)).toMatchObject({ level: "great", source: "seasons", tourism: "high" });
    expect(localeMonth(l, 3)).toMatchObject({ level: "avoid", source: "seasons" });
    expect(localeMonth(l, 6)).toMatchObject({ level: "fair", source: "research" });
  });

  it("prefers the frame with fewer high-season months on a tie", () => {
    const m = make("bbbbbbbbbbbb", {
      stay: { minWeeks: 4, idealWeeks: 4, maxWeeks: 8, why: "" },
      seasons: [{ kind: "peak", tourism: "high", from: "01-01", to: "06-30", title: "Busy" }],
    });
    expect(stayWindows(m, localeYear(m))[0].stay).toEqual({ start: 7, end: 7 });
  });
});

describe("soonest frame", () => {
  it("breaks a tie by the frame starting soonest from the given month", () => {
    const m = make("bbbbbbbbbbbb", { stay: { minWeeks: 4, idealWeeks: 4, maxWeeks: 8, why: "" } });
    expect(stayWindows(m, localeYear(m), null, 11)[0].stay).toEqual({ start: 11, end: 11 });
    expect(stayWindows(m, localeYear(m))[0].stay).toEqual({ start: 1, end: 1 });
  });
});

describe("windowSegments", () => {
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

  it("splits a window that crosses the calendar's start", () => {
    // Nov 1 – Feb 14 on a calendar starting in December: Dec–mid-Feb first, then November at the end.
    close(windowSegments({ from: "11-01", to: "02-14" }, 12), [[0, 2.5], [11, 1]]);
  });

  it("keeps a wrapping window whole when the calendar starts in January", () => {
    close(windowSegments({ from: "11-01", to: "02-14" }, 1), [[0, 1.5], [10, 2]]);
    close(windowSegments({ from: "01-01", to: "12-31" }, 7), [[0, 12]]);
  });

  it("draws a month span as whole months", () => {
    close(spanSegments({ start: 11, end: 1 }, 11), [[0, 3]]);
  });
});
