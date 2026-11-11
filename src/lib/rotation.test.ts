import { describe, expect, it } from "vitest";
import type { Journey, Trip } from "../types";
import {
  bookBy,
  bookingDeadlines,
  currentStay,
  defaultLeadTime,
  dueReminders,
  effectiveStatus,
  journeyStayTemplate,
  mergeImportedWindows,
  monthEndExclusive,
  nextWindow,
  nightsByMonth,
  placeTemplate,
  rentalLinks,
  rotationIssues,
  rotationLegs,
  rotationTotals,
  solverInput,
  stayFit,
  stayPresence,
  staySpan,
  timelineMonths,
  tripToRotation,
  whatsNext,
  type PlaceProfile,
  type RotationPlace,
  type RotationState,
  type RotationStay,
} from "./rotation";

const lisbon: RotationPlace = { cityId: "lisbon-portugal", name: "Lisbon", country: "Portugal", iata: "LIS", lat: 38.72, lng: -9.14 };
const bangkok: RotationPlace = { cityId: "bangkok-thailand", name: "Bangkok", country: "Thailand", iata: "BKK", lat: 13.75, lng: 100.5 };
const chiangMai: RotationPlace = { cityId: "chiang-mai-thailand", name: "Chiang Mai", country: "Thailand", iata: "CNX", lat: 18.79, lng: 98.98 };

let n = 0;
const stay = (over: Partial<RotationStay> & { place: RotationPlace }): RotationStay => ({
  id: over.id ?? `s${++n}`,
  kind: "base",
  status: "planned",
  ...over,
});

describe("spans and status", () => {
  it("uses dates, else the month window", () => {
    expect(staySpan({ start: "2027-01-05", end: "2027-03-01" })).toEqual({ start: "2027-01-05", end: "2027-03-01", approx: false });
    expect(staySpan({ window: { from: "2027-11", to: "2028-01" } })).toEqual({ start: "2027-11-01", end: "2028-02-01", approx: true });
    expect(staySpan({ start: "2027-03-01", end: "2027-03-01" })).toBeNull();
    expect(monthEndExclusive("2027-12")).toBe("2028-01-01");
  });

  it("finds the stay containing today; a moving day belongs to the stay moved into", () => {
    const a = stay({ id: "a", place: lisbon, start: "2026-09-01", end: "2026-11-15" });
    const b = stay({ id: "b", place: bangkok, start: "2026-11-15", end: "2026-11-19", kind: "pass-through" });
    const idea = stay({ id: "i", place: chiangMai, status: "idea", start: "2026-11-01", end: "2026-12-01" });
    expect(currentStay([a, b, idea], "2026-11-10")?.id).toBe("a");
    expect(currentStay([a, b, idea], "2026-11-15")?.id).toBe("b");
    expect(currentStay([a, b], "2026-11-19")).toBeNull();
    expect(effectiveStatus(a, "2026-11-10")).toBe("current");
    expect(effectiveStatus(a, "2026-12-01")).toBe("done");
    expect(effectiveStatus(idea, "2026-11-10")).toBe("idea");
  });

  it("says what's next", () => {
    const a = stay({ id: "a", place: lisbon, start: "2026-09-01", end: "2026-11-15" });
    const b = stay({ id: "b", place: bangkok, start: "2026-11-15", end: "2026-11-19" });
    const w = whatsNext([a, b], "2026-11-10");
    expect(w.current?.id).toBe("a");
    expect(w.daysLeft).toBe(5);
    expect(w.nextMoveDate).toBe("2026-11-15");
    expect(w.next?.id).toBe("b");
    const between = whatsNext([a, b], "2026-08-20");
    expect(between.current).toBeNull();
    expect(between.nextMoveDate).toBe("2026-09-01");
    expect(between.daysToMove).toBe(12);
  });
});

describe("gaps and overlaps", () => {
  it("reports a gap, an overlap and length limits; ignores ideas and back-to-back moves", () => {
    const a = stay({ id: "a", place: lisbon, start: "2027-01-01", end: "2027-03-01", minNights: 90 });
    const b = stay({ id: "b", place: bangkok, start: "2027-03-01", end: "2027-03-04" });
    const c = stay({ id: "c", place: chiangMai, start: "2027-03-10", end: "2027-05-01", maxNights: 30 });
    const d = stay({ id: "d", place: lisbon, start: "2027-04-20", end: "2027-06-01" });
    const idea = stay({ id: "x", place: bangkok, status: "idea", start: "2027-06-10", end: "2027-06-20" });
    const issues = rotationIssues([a, b, c, d, idea]);
    const kinds = issues.map((i) => `${i.kind}:${i.stayIds.join(">")}:${i.days}`).sort();
    expect(kinds).toEqual(["gap:b>c:6", "overlap:c>d:11", "too-long:c:22", "too-short:a:31"].sort());
    expect(issues.find((i) => i.kind === "gap")?.from).toBe("2027-03-04");
  });

  it("marks issues against month windows tentative and lets windows share a month", () => {
    const a = stay({ id: "a", place: lisbon, window: { from: "2027-01", to: "2027-02" } });
    const b = stay({ id: "b", place: bangkok, window: { from: "2027-02", to: "2027-03" } });
    const c = stay({ id: "c", place: chiangMai, start: "2027-05-01", end: "2027-06-01" });
    const issues = rotationIssues([a, b, c]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "gap", tentative: true, days: 30 });
  });
});

describe("fit", () => {
  const comfort = (scores: number[]) => () => scores.map((score) => ({ score }));

  it("splits nights by month", () => {
    expect(nightsByMonth("2027-01-20", "2027-03-05")).toEqual([
      { month: "2027-01", nights: 12 },
      { month: "2027-02", nights: 28 },
      { month: "2027-03", nights: 4 },
    ]);
  });

  it("personal windows override the Comfort Index", () => {
    const s = stay({ place: chiangMai, start: "2027-03-01", end: "2027-05-01" });
    const all90 = comfort(Array(12).fill(90));
    expect(stayFit(s, undefined, all90)).toMatchObject({ level: "great", source: "comfort" });
    const profile: PlaceProfile = {
      cityId: chiangMai.cityId,
      name: "Chiang Mai",
      windows: [{ id: "w1", kind: "avoid", months: { start: 3, end: 4 }, reason: "burning season, air quality" }],
    };
    const fit = stayFit(s, profile, all90);
    expect(fit.level).toBe("avoid");
    expect(fit.source).toBe("personal");
    expect(fit.summary).toContain("burning season");
  });

  it("weights months by nights and says when nothing is known", () => {
    const s = stay({ place: lisbon, start: "2027-06-01", end: "2027-08-01" });
    // June 90 (great), July 40 (poor): mean of 4 and 1 rounds to fair.
    const scores = Array(12).fill(50);
    scores[5] = 90;
    scores[6] = 40;
    expect(stayFit(s, undefined, comfort(scores)).level).toBe("fair");
    expect(stayFit(s, undefined, () => null).level).toBe("unknown");
    expect(stayFit(stay({ place: lisbon }), undefined).summary).toMatch(/No dates/);
  });

  it("a few avoid nights at the edge of a long stay do not sink it", () => {
    const s = stay({ place: chiangMai, start: "2027-01-01", end: "2027-03-04" });
    const profile: PlaceProfile = { cityId: chiangMai.cityId, name: "Chiang Mai", windows: [{ id: "w", kind: "avoid", months: { start: 3, end: 4 } }] };
    expect(stayFit(s, profile, comfort(Array(12).fill(90))).level).not.toBe("avoid");
  });
});

describe("booking lead times and reminders", () => {
  it("defaults by type and length; a place or stay overrides", () => {
    expect(defaultLeadTime("pass-through", 3).max).toBe(3);
    expect(defaultLeadTime("base", 20).max).toBe(4);
    expect(defaultLeadTime("base", 60).max).toBe(8);
    expect(defaultLeadTime("base", 120).max).toBe(12);
    const s = stay({ place: lisbon, start: "2027-06-01", end: "2027-08-01" });
    expect(bookBy(s)).toBe("2027-04-06");
    const azores: PlaceProfile = { cityId: lisbon.cityId, name: "Lisbon", windows: [], leadTime: { min: 8, max: 10 } };
    expect(bookBy(s, azores)).toBe("2027-03-23");
    expect(bookBy({ ...s, leadTime: { min: 52, max: 52 } }, azores)).toBe("2026-06-02");
    expect(bookBy(stay({ place: lisbon, window: { from: "2027-06", to: "2027-07" } }))).toBe("2027-04-06");
  });

  it("lists deadlines for unbooked future stays and returns due reminders with links", () => {
    const state: RotationState = {
      settings: { name: "r", horizonMonths: 18 },
      places: [],
      stays: [
        stay({ id: "due", place: lisbon, start: "2027-01-01", end: "2027-03-01" }), // book by 2026-11-06: overdue
        stay({ id: "soon", place: bangkok, kind: "pass-through", start: "2026-12-10", end: "2026-12-13" }), // 2026-11-19
        stay({ id: "later", place: chiangMai, start: "2027-09-01", end: "2027-11-01" }),
        stay({ id: "booked", place: chiangMai, status: "booked", start: "2027-01-01", end: "2027-02-01" }),
      ],
    };
    const today = "2026-11-10";
    expect(bookingDeadlines(state, today).map((d) => d.stayId)).toEqual(["due", "soon", "later"]);
    const r = dueReminders(state, today, 14);
    expect(r.map((x) => `${x.stayId}:${x.kind}:${x.daysLeft}`)).toEqual(["due:overdue:-4", "soon:due:9"]);
    expect(r[0].message).toContain("Lisbon");
    expect(r[0].links.map((l) => l.site)).toEqual(["flatio", "airbnb", "booking"]);
  });

  it("rental links carry the city and dates only", () => {
    const links = rentalLinks(stay({ place: lisbon, start: "2027-01-01", end: "2027-03-01" }));
    const booking = links.find((l) => l.site === "booking")!.url;
    expect(booking).toContain("checkin=2027-01-01");
    expect(booking).toContain("Lisbon");
    expect(links.find((l) => l.site === "airbnb")!.label).toMatch(/monthly/i);
  });
});

describe("legs and totals", () => {
  const state: RotationState = {
    settings: { name: "r", horizonMonths: 12 },
    places: [],
    stays: [
      stay({ id: "a", place: lisbon, start: "2026-11-01", end: "2027-02-01", rentMonthly: { amount: 1500, currency: "EUR" } }),
      stay({ id: "b", place: bangkok, kind: "pass-through", start: "2027-02-01", end: "2027-02-04" }),
      stay({ id: "c", place: chiangMai, start: "2027-02-04", end: "2027-05-04", budgetMonthly: { amount: 900, currency: "EUR" } }),
      stay({ id: "i", place: lisbon, status: "idea", start: "2027-06-01", end: "2027-07-01" }),
    ],
  };

  it("builds a leg per move with the trip leg estimates, and no return leg", () => {
    const legs = rotationLegs(state.stays);
    expect(legs.map((l) => `${l.fromStayId}>${l.toStayId}@${l.date}`)).toEqual(["a>b@2027-02-01", "b>c@2027-02-04"]);
    expect(legs[0].leg.mode).toBe("flight");
    expect(legs[0].leg.cost).toBeGreaterThan(0);
    expect(legs[0].leg.method).toMatch(/not a fare/);
  });

  it("totals months covered, cost per month by currency, and moves per year", () => {
    const t = rotationTotals(state, "2026-11-10", rotationLegs(state.stays));
    expect(t.from).toBe("2026-11-01");
    expect(t.to).toBe("2027-11-01");
    expect(t.monthsCovered).toBeCloseTo(6.0, 0);
    expect(t.moves).toBe(2);
    expect(t.movesPerYear).toBe(2);
    expect(t.costPerMonth).toHaveLength(1);
    expect(t.costPerMonth[0]).toMatchObject({ currency: "EUR", basis: "mixed" });
    // 92 nights at 1500 and 89 at 900, night-weighted.
    expect(t.costPerMonth[0].perMonth).toBe(Math.round((1500 * 92 + 900 * 89) / 181));
  });

  it("lays out month columns", () => {
    const m = timelineMonths("2027-01-01", "2027-04-01");
    expect(m.map((x) => x.ym)).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect(m[1].left).toBeCloseTo(31 / 90);
  });
});

describe("conversions", () => {
  const trip: Trip = {
    id: "t1",
    name: "Dry season",
    color: "#000",
    status: "confirmed",
    nodes: [
      { cityId: lisbon.cityId, name: "Lisbon", iata: "LIS", lat: lisbon.lat, lng: lisbon.lng, months: { start: 11, end: 12 } },
      { cityId: bangkok.cityId, name: "Bangkok", iata: "BKK", lat: bangkok.lat, lng: bangkok.lng, months: { start: 1, end: 1 } },
      {
        cityId: chiangMai.cityId,
        name: "Chiang Mai",
        lat: chiangMai.lat,
        lng: chiangMai.lng,
        arrive: "2028-02-01",
        depart: "2028-02-05",
        lodging: { name: "Flat", bookingRef: "X1" },
      },
    ],
    year: 2027,
    departure: { cityId: "las-palmas-spain", name: "Las Palmas", iata: "LPA", lat: 28.1, lng: -15.43 },
  };

  it("turns a trip into stays with windows, dates, statuses, and an optional home", () => {
    let i = 0;
    const { stays, home } = tripToRotation(trip, "2026-11-10", () => ({ country: "X" }), () => `id${i++}`);
    expect(stays.map((s) => [s.window, s.start, s.status, s.kind])).toEqual([
      [{ from: "2027-11", to: "2027-12" }, undefined, "planned", "base"],
      [{ from: "2028-01", to: "2028-01" }, undefined, "planned", "base"],
      [undefined, "2028-02-01", "booked", "pass-through"],
    ]);
    expect(home?.iata).toBe("LPA");
    expect(stays[0].origin).toEqual({ kind: "trip", tripId: "t1" });
  });

  it("without a year, uses the next time the months come round", () => {
    expect(nextWindow({ start: 11, end: 2 }, "2026-11-10")).toEqual({ from: "2026-11", to: "2027-02" });
    expect(nextWindow({ start: 3, end: 4 }, "2026-11-10")).toEqual({ from: "2027-03", to: "2027-04" });
  });

  it("makes a stay template from a journey stop, with a labelled monthly budget", () => {
    const journey = {
      id: "j1",
      title: "Lisbon winter",
      stops: [
        {
          cityId: lisbon.cityId,
          arrive: "2025-01-01",
          depart: "2025-02-15",
          lodging: { name: "Alfama flat", kind: "apartment", cost: { amount: 2250, currency: "EUR", eur: 2250, rateDate: "2025-01-01" }, provenance: { source: "manual", confidence: "high" } },
        },
      ],
    } as unknown as Journey;
    const t = journeyStayTemplate(journey, 0, () => ({ id: lisbon.cityId, name: "Lisbon", country: "Portugal", iata: "LIS", lat: 1, lng: 2 }), () => "tpl")!;
    expect(t).toMatchObject({ id: "tpl", kind: "base", status: "idea", minNights: 45, maxNights: 45 });
    expect(t.budgetMonthly).toEqual({ amount: Math.round((2250 / 45) * 30.4375), currency: "EUR" });
    expect(t.notes).toMatch(/scaled to/);
    expect(t.start).toBeUndefined();
    expect(placeTemplate(t, "2027-01-01")).toMatchObject({ start: "2027-01-01", end: "2027-02-15" });
    expect(journeyStayTemplate(journey, 3, () => undefined)).toBeNull();
  });
});

describe("extension points", () => {
  it("gives the visa module presence by country, tentative for windows", () => {
    const p = stayPresence([
      stay({ id: "a", place: chiangMai, start: "2027-01-01", end: "2027-02-01" }),
      stay({ id: "b", place: bangkok, window: { from: "2027-02", to: "2027-02" } }),
      stay({ id: "c", place: lisbon, status: "idea", start: "2027-03-01", end: "2027-04-01" }),
    ]);
    expect(p).toEqual([
      { stayId: "a", country: "Thailand", start: "2027-01-01", end: "2027-02-01", tentative: false },
      { stayId: "b", country: "Thailand", start: "2027-02-01", end: "2027-03-01", tentative: true },
    ]);
  });

  it("hands a solver the locked stays and the place pool", () => {
    const state: RotationState = {
      settings: { name: "r", horizonMonths: 12 },
      stays: [stay({ id: "a", place: lisbon, locked: true }), stay({ id: "b", place: bangkok })],
      places: [{ cityId: "x", name: "X", windows: [] }],
    };
    const s = solverInput(state, "2026-11-10");
    expect(s.locked.map((x) => x.id)).toEqual(["a"]);
    expect(s.pool).toHaveLength(1);
    expect(s.to).toBe("2027-11-01");
  });

  it("re-importing windows replaces that source and keeps hand-written ones", () => {
    const profile: PlaceProfile = {
      cityId: "c",
      name: "C",
      windows: [
        { id: "m", kind: "peak", months: { start: 1, end: 2 }, source: { kind: "manual" } },
        { id: "n1", kind: "avoid", months: { start: 3, end: 4 }, source: { kind: "notion", ref: "page1" } },
      ],
    };
    const merged = mergeImportedWindows(profile, [{ id: "n2", kind: "avoid", months: { start: 3, end: 5 }, source: { kind: "notion", ref: "page1" } }], "notion");
    expect(merged.windows.map((w) => w.id)).toEqual(["m", "n2"]);
  });
});
