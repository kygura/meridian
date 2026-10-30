import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { loadCities, getCityById } from "./cities";
import { runReplay } from "./replay";
import { loadEvents } from "./replayService";
import { fixtureFingerprintDeps, lisbonJourney, getCity, SEASONALITY, NOW } from "./__fixtures__/journal";
import { computeFingerprint } from "./fingerprint";
import type { MeridianEvent, Journey } from "../../src/types";

const events = (JSON.parse(readFileSync(join(process.cwd(), "data", "events.json"), "utf-8")) as { version: number; events: MeridianEvent[] }).events;

beforeAll(() => loadCities());

describe("data/events.json", () => {
  it("has unique ids, valid months and a cityId that exists in the city DB for every event", () => {
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    for (const e of events) {
      expect(e.month, e.id).toBeGreaterThanOrEqual(1);
      expect(e.month, e.id).toBeLessThanOrEqual(12);
      expect(e.cityIds.length, e.id).toBeGreaterThan(0);
      for (const id of e.cityIds) expect(getCityById(id), `${e.id}: ${id}`).toBeDefined();
      if (e.date) expect(Number(e.date.slice(5, 7)), e.id).toBe(e.month);
      if (!e.recurring) expect(e.date, e.id).toBeDefined();
    }
  });

  it("covers 2026-2030 solar eclipses and recurring festivals", () => {
    const eclipses = events.filter((e) => e.tags.includes("eclipse"));
    expect(eclipses.map((e) => e.date)).toEqual(["2026-08-12", "2027-08-02", "2028-01-26", "2028-07-22", "2030-06-01", "2030-11-25"]);
    expect(events.filter((e) => e.recurring).length).toBeGreaterThanOrEqual(20);
  });

  it("loadEvents keeps one-off events only in their month's next occurrence", async () => {
    const dated = (list: MeridianEvent[]) => list.filter((e) => !e.recurring).map((e) => e.id);
    const early = await loadEvents(new Date("2026-01-01T00:00:00Z"));
    expect(dated(early)).toEqual(["eclipse-2026-08-12"]);
    expect(early.filter((e) => e.recurring)).toHaveLength(events.filter((e) => e.recurring).length);
    expect(dated(await loadEvents(new Date("2027-10-01T00:00:00Z")))).toEqual(["eclipse-2028-01-26", "eclipse-2028-07-22"]); // next Jan and Jul occurrences
    const later = await loadEvents(new Date("2027-01-01T00:00:00Z"));
    expect(later.find((e) => e.id === "eclipse-2026-08-12")).toBeUndefined();
    expect(later.find((e) => e.id === "eclipse-2027-08-02")).toBeDefined();
    expect(later.find((e) => e.id === "oktoberfest")).toBeDefined(); // recurring stays
  });
});

describe("eclipse tag constraint in replay", () => {
  async function eclipseCells(today: string): Promise<string[]> {
    let lisbon: Journey = lisbonJourney();
    lisbon = (await computeFingerprint(lisbon, fixtureFingerprintDeps().deps)).journey;
    const r = await runReplay(
      { template: { journeyId: lisbon.id }, bend: { monthShift: null }, weights: { climate: 1, spend: 0, crowd: 0, flight: 0 }, constraints: { tags: ["eclipse"] }, limit: 50 },
      {
        journeys: [lisbon],
        settings: { homeCityId: "berlin-germany" },
        seasonality: SEASONALITY,
        getCity,
        flightEstimate: async () => ({ priceAmount: 100, currency: "EUR", source: "mock" }),
        eurOf: (a) => a,
        now: () => NOW,
        events: await loadEvents(new Date(`${today}T00:00:00Z`)),
      }
    );
    for (const x of r.results) expect(x.events!.some((e) => e.tags.includes("eclipse"))).toBe(true);
    return r.results.map((x) => `${x.cityId}/${x.month}`).sort();
  }

  it("tags a month only with the eclipse in its next occurrence, never one years away", async () => {
    // 2026-10-30: only the 2027-08 eclipse (no fixture city on its path); the 2028/2030 ones must not tag Jan/Jun/Nov 2027.
    expect(await eclipseCells("2026-10-30")).toEqual([]);
    // 2027-10-01: the 2028-01-26 annular eclipse is January's next occurrence (Seville); 2030-06 still isn't June's.
    expect(await eclipseCells("2027-10-01")).toEqual(["seville-spain/1"]);
  });
});
