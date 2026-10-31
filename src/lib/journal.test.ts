import { describe, it, expect } from "vitest";
import {
  chainLabel,
  comfortSentence,
  daysBetween,
  DEFAULT_FILTERS,
  filterJourneys,
  formatMoney,
  formatRange,
  formatRangeLong,
  formatWhen,
  groupByYear,
  itinerary,
  journalTags,
  journalYears,
  journeyStats,
  kmFlown,
  modeGlyphs,
  ratingText,
  spendBreakdown,
  spendEur,
} from "./journal";
import type { City, Journey, Money, Stop } from "../types";

const city = (id: string, iata: string, country: string, lat: number, lng: number): City => ({
  id,
  name: id,
  iata,
  country,
  lat,
  lng,
  population: 1,
});
const CITIES = [
  city("lisbon", "LIS", "Portugal", 38.77, -9.13),
  city("porto", "OPO", "Portugal", 41.24, -8.68),
  city("madrid", "MAD", "Spain", 40.47, -3.56),
];

const money = (eur: number): Money => ({ amount: eur, currency: "EUR", eur, rateDate: "2024-05-01" });
const prov = { source: "manual", confidence: "high" } as const;
const stop = (cityId: string, arrive: string, depart: string, extra: Partial<Stop> = {}): Stop => ({
  cityId,
  arrive,
  depart,
  ...extra,
});

function journey(id: string, over: Partial<Journey> = {}): Journey {
  return {
    id,
    title: id,
    status: "confirmed",
    startDate: "2024-05-12",
    endDate: "2024-05-20",
    stops: [stop("lisbon", "2024-05-12", "2024-05-15"), stop("porto", "2024-05-15", "2024-05-20")],
    segments: [],
    experiences: [],
    tags: [],
    bookingIds: [],
    provenance: prov,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...over,
  };
}

describe("dates", () => {
  it("daysBetween across month and DST boundaries", () => {
    expect(daysBetween("2024-05-12", "2024-05-20")).toBe(8);
    expect(daysBetween("2024-03-30", "2024-04-02")).toBe(3);
  });
  it("formatRange variants", () => {
    expect(formatRange("2024-05-12", "2024-05-20")).toBe("MAY 12 – 20");
    expect(formatRange("2024-05-28", "2024-06-02")).toBe("MAY 28 – JUN 2");
    expect(formatRange("2023-12-28", "2024-01-03")).toBe("DEC 28 2023 – JAN 3 2024");
    expect(formatRange("2024-05-12", "2024-05-12")).toBe("MAY 12");
  });
  it("formatRangeLong", () => {
    expect(formatRangeLong("2024-05-12", "2024-05-20")).toBe("12 MAY – 20 MAY 2024");
    expect(formatRangeLong("2023-12-28", "2024-01-03")).toBe("28 DEC 2023 – 3 JAN 2024");
  });
});

describe("money", () => {
  it("formats EUR with grouping and shows a dash for absent", () => {
    expect(formatMoney(money(12480))).toBe("€12,480");
    expect(formatMoney(undefined)).toBe("—");
  });
  it("spend sums stays, transport, experiences; null when nothing priced", () => {
    const j = journey("a", {
      stops: [stop("lisbon", "2024-05-12", "2024-05-15", { lodging: { name: "x", cost: money(420), provenance: prov } })],
      segments: [
        { mode: "flight", fromCityId: "lisbon", toCityId: "porto", departAt: "2024-05-15", cost: money(80), provenance: prov },
      ],
      experiences: [{ cityId: "porto", date: "2024-05-16", title: "t", cost: money(40), provenance: prov }],
    });
    expect(spendBreakdown(j)).toEqual({ stays: 420, transport: 80, experiences: 40, total: 540, priced: true, has: { stays: true, transport: true, experiences: true } });
    expect(spendEur(j)).toBe(540);
    expect(spendEur(journey("b"))).toBeNull();
  });
});

describe("kmFlown / stats", () => {
  const flight = (from: string, to: string) => ({
    mode: "flight" as const,
    fromCityId: from,
    toCityId: to,
    departAt: "2024-05-15",
    provenance: prov,
  });
  it("counts flight segments only, skips unknown cities", () => {
    const j = journey("a", {
      segments: [
        flight("lisbon", "porto"),
        { ...flight("porto", "madrid"), mode: "train" },
        flight("lisbon", "nowhere"),
      ],
    });
    const km = kmFlown(j, CITIES);
    expect(km).toBeGreaterThan(270);
    expect(km).toBeLessThan(320);
  });
  it("stats cover confirmed journeys only and report unpriced count", () => {
    const priced = journey("a", {
      segments: [flight("lisbon", "madrid")],
      stops: [
        stop("lisbon", "2024-05-12", "2024-05-15", { lodging: { name: "x", cost: money(100), provenance: prov } }),
        stop("madrid", "2024-05-15", "2024-05-20"),
      ],
    });
    const unpriced = journey("b", { startDate: "2023-01-01", endDate: "2023-01-03", stops: [stop("porto", "2023-01-01", "2023-01-03")] });
    const draft = journey("c", { status: "draft" });
    const s = journeyStats([priced, unpriced, draft], CITIES);
    expect(s.journeys).toBe(2);
    expect(s.countries).toBe(2);
    expect(s.cities).toBe(3);
    expect(s.nights).toBe(8 + 2);
    expect(s.spendEur).toBe(100);
    expect(s.unpriced).toBe(1);
    expect(s.km).toBeGreaterThan(500);
  });
  it("empty set is all zeros", () => {
    expect(journeyStats([], CITIES)).toEqual({ journeys: 0, countries: 0, cities: 0, nights: 0, km: 0, spendEur: 0, unpriced: 0 });
  });
});

describe("filters and grouping", () => {
  const a = journey("a", { startDate: "2024-05-12", endDate: "2024-05-20", rating: 5, tags: ["food", "coast"] });
  const b = journey("b", { startDate: "2023-08-01", endDate: "2023-08-05", rating: 3, tags: ["food"] });
  const c = journey("c", { startDate: "2024-09-01", endDate: "2024-09-03", status: "draft" });
  const d = journey("d", { startDate: "2024-01-10", endDate: "2024-01-12" });
  const all = [a, b, c, d];

  it("hides drafts by default and sorts newest first", () => {
    expect(filterJourneys(all, DEFAULT_FILTERS).map((j) => j.id)).toEqual(["a", "d", "b"]);
    expect(filterJourneys(all, { ...DEFAULT_FILTERS, drafts: true }).map((j) => j.id)).toEqual(["c", "a", "d", "b"]);
  });
  it("filters by year, min rating and tags (all must match)", () => {
    expect(filterJourneys(all, { ...DEFAULT_FILTERS, year: 2023 }).map((j) => j.id)).toEqual(["b"]);
    expect(filterJourneys(all, { ...DEFAULT_FILTERS, minRating: 4 }).map((j) => j.id)).toEqual(["a"]);
    expect(filterJourneys(all, { ...DEFAULT_FILTERS, tags: ["food"] }).map((j) => j.id)).toEqual(["a", "b"]);
    expect(filterJourneys(all, { ...DEFAULT_FILTERS, tags: ["food", "coast"] }).map((j) => j.id)).toEqual(["a"]);
  });
  it("lists years and tags present", () => {
    expect(journalYears(all)).toEqual([2024, 2023]);
    expect(journalTags(all)).toEqual(["coast", "food"]);
  });
  it("groups by year newest first with night and city totals", () => {
    const groups = groupByYear(filterJourneys(all, DEFAULT_FILTERS));
    expect(groups.map((g) => g.year)).toEqual([2024, 2023]);
    expect(groups[0].journeys.map((j) => j.id)).toEqual(["a", "d"]);
    expect(groups[0].nights).toBe(8 + 2);
    expect(groups[0].cities).toBe(2);
  });
});

describe("labels", () => {
  it("chain and mode glyphs", () => {
    const j = journey("a", {
      segments: [
        { mode: "flight", fromCityId: "lisbon", toCityId: "porto", departAt: "2024-05-15", provenance: prov },
        { mode: "train", fromCityId: "porto", toCityId: "lisbon", departAt: "2024-05-19", provenance: prov },
      ],
    });
    expect(chainLabel(j, CITIES)).toBe("LIS → OPO");
    expect(modeGlyphs(j.segments)).toBe("✈ ═");
  });
  it("ratingText", () => {
    expect(ratingText(3)).toBe("3 of 5");
    expect(ratingText(undefined)).toBe("Not rated");
  });
});

describe("comfortSentence", () => {
  const obs = (comfort: number, normalComfort: number) => ({ tempC: 20, precipMm: 10, comfort, normalComfort });
  it("kinder at delta >= +8, weighted by nights", () => {
    const s = comfortSentence([
      stop("a", "2024-05-01", "2024-05-04", { observed: obs(90, 70) }), // 3 nights, +20
      stop("b", "2024-05-04", "2024-05-05", { observed: obs(70, 70) }), // 1 night, 0
    ]);
    expect(s.kind).toBe("kinder");
    expect(s.delta).toBeCloseTo(15);
    expect(s.text).toBe("You got a kinder week than usual — comfort 85 against a normal 70.");
  });
  it("rougher at delta <= -8", () => {
    const s = comfortSentence([stop("a", "2024-05-01", "2024-05-08", { observed: obs(54, 68) })]);
    expect(s.kind).toBe("rougher");
    expect(s.text).toBe("A rougher week than the season usually gives — 54 against 68.");
  });
  it("same inside the band, boundary is inclusive", () => {
    expect(comfortSentence([stop("a", "2024-05-01", "2024-05-08", { observed: obs(75, 70) })]).kind).toBe("same");
    expect(comfortSentence([stop("a", "2024-05-01", "2024-05-08", { observed: obs(78, 70) })]).kind).toBe("kinder");
  });
  it("unknown when no stop has observed; zero-night stops still weigh 1", () => {
    expect(comfortSentence([stop("a", "2024-05-01", "2024-05-02")]).kind).toBe("unknown");
    expect(comfortSentence([stop("a", "2024-05-01", "2024-05-01", { observed: obs(90, 70) })]).kind).toBe("kinder");
  });
});

describe("itinerary", () => {
  const leg = (from: string, to: string, mode: "flight" | "train" = "flight") => ({
    mode,
    fromCityId: from,
    toCityId: to,
    departAt: "2024-05-15",
    provenance: prov,
  });
  it("matches legs to consecutive stops and leaves side trips as other", () => {
    const j = journey("a", {
      stops: [stop("lisbon", "2024-05-12", "2024-05-15"), stop("porto", "2024-05-15", "2024-05-18"), stop("lisbon", "2024-05-18", "2024-05-20")],
      segments: [leg("porto", "lisbon"), leg("lisbon", "porto"), leg("porto", "madrid", "train")],
    });
    const it = itinerary(j);
    expect(it.legs.map((g) => g && g.fromCityId)).toEqual(["lisbon", "porto"]);
    expect(it.other.map((g) => g.toCityId)).toEqual(["madrid"]);
  });
  it("a missing pair gives a null leg", () => {
    expect(itinerary(journey("a")).legs).toEqual([null]);
  });
  it("groups experiences under the stop whose dates contain them", () => {
    const x = (cityId: string, date: string) => ({ cityId, date, title: date, provenance: prov });
    const j = journey("a", {
      stops: [stop("lisbon", "2024-05-12", "2024-05-15"), stop("porto", "2024-05-15", "2024-05-18"), stop("lisbon", "2024-05-18", "2024-05-20")],
      experiences: [x("lisbon", "2024-05-19"), x("lisbon", "2024-05-13"), x("madrid", "2024-05-16"), x("lisbon", "2024-06-30")],
    });
    const it = itinerary(j);
    expect(it.doneByStop.map((l) => l.map((e) => e.date))).toEqual([["2024-05-13", "2024-06-30"], [], ["2024-05-19"]]);
    expect(it.doneOther.map((e) => e.cityId)).toEqual(["madrid"]);
  });
});

describe("formatWhen", () => {
  it("shows the time only when present", () => {
    expect(formatWhen("2024-05-15")).toBe("15 MAY");
    expect(formatWhen("2024-05-15T09:40")).toBe("15 MAY 09:40");
  });
});
