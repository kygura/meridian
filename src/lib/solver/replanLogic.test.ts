import { describe, expect, it } from "vitest";
import { advisoryShifts, airShift, diffStays, flightShift, newsShifts, stepShift, visaShifts, weatherShift, type WatchedStay } from "./replanLogic";
import { DEFAULT_REPLAN, type ShiftMemory } from "./settings";

const S = { ...DEFAULT_REPLAN, hysteresisPct: 20, cooldownDays: 7, pm25Over: 25, tempDeltaC: 5, flightChangePct: 30, newsMinLevel: "incident" as const };
const stay: WatchedStay = { id: "st1", cityId: "chiang-mai-thailand", name: "Chiang Mai", country: "Thailand", start: "2027-01-05", end: "2027-03-01", fixed: false };

const day = (n: number) => new Date(Date.UTC(2026, 10, 10 + n)).toISOString().slice(0, 10);

/** Run a series of magnitudes, one a day; return the days that fired. */
function run(mags: number[], continuous: boolean) {
  let mem: ShiftMemory | undefined;
  const fired: number[] = [];
  mags.forEach((m, i) => {
    const r = stepShift(mem, m, continuous, day(i), S);
    mem = r.memory;
    if (r.fire) fired.push(i);
  });
  return fired;
}

describe("detectors", () => {
  it("turns news issues and flags at the owner's level into shifts with evidence", () => {
    const news = {
      issues: [
        { subject: "air", label: "Air travel", level: "incident" as const, summary: "One deadly incident", lastSeen: "2026-11-08T10:00:00Z", headlines: [{ title: "Plane skids off runway", url: "https://example.org/a", source: "Example News", pubDate: "2026-11-08T10:00:00Z" }] },
        { subject: "power", label: "Power supply", level: "recurring" as const, summary: "Repeated outages", lastSeen: "2026-11-09T10:00:00Z", headlines: [] },
        // A pattern whose last headline is months old is the place's standing risk, not a shift.
        { subject: "rail", label: "Rail safety", level: "systemic" as const, summary: "Two deadly crashes", lastSeen: "2026-07-01T10:00:00Z", headlines: [] },
      ],
      flags: [
        { topic: "unrest", severity: 3 as const, headline: "Protests in the old town", url: "https://example.org/b", latest: "2026-11-09T09:00:00Z" },
        { topic: "transport", severity: 3 as const, headline: "Old strike", url: "https://example.org/c", latest: "2026-09-01T09:00:00Z" },
      ],
    };
    const out = newsShifts(stay, news, S, "2026-11-10");
    expect(out.map((s) => s.key)).toEqual(["news:st1:air", "flag:st1:unrest"]);
    expect(out[0].evidence[1]).toMatchObject({ url: "https://example.org/a", source: "Example News" });
    // Flags count one level stricter than issues: at "incident", only deadly (severity 3) flags.
    expect(out[1].magnitude).toBe(1);
    expect(out.every((s) => s.action === "penalise")).toBe(true);
  });

  it("counts a curated advisory only when it was added recently", () => {
    const advisories = [
      { id: "new", label: "Unsafe rail", severity: 2, since: "2026-10" },
      { id: "old", label: "Standing conflict", severity: 3, since: "2025-01" },
      { id: "none", label: "No date", severity: 3 },
    ];
    expect(advisoryShifts(stay, advisories, "2026-11-10").map((s) => s.key)).toEqual(["advisory:st1:new"]);
  });

  it("measures air, temperature and fares against their thresholds", () => {
    expect(airShift(stay, 85, 35, S, "src").magnitude).toBe(2);
    expect(airShift(stay, 20, 35, S, "src").magnitude).toBe(0);
    expect(weatherShift(stay, 31, 26, S, "src").magnitude).toBe(1);
    const up = flightShift(stay, "Lisbon", 650, 500, "EUR", S, "Duffel");
    expect(up.magnitude).toBe(1);
    expect(up.action).toBe("penalise");
    expect(flightShift(stay, "Lisbon", 300, 500, "EUR", S, "Duffel").action).toBe("none");
  });

  it("finds a Schengen breach made by an edit, counting past presence", () => {
    const stays: WatchedStay[] = [
      { id: "a", cityId: "lisbon", name: "Lisbon", country: "Portugal", start: "2026-11-01", end: "2027-01-15", fixed: false },
      { id: "b", cityId: "madrid", name: "Madrid", country: "Spain", start: "2027-01-15", end: "2027-02-01", fixed: false },
    ];
    const v = visaShifts(stays, [{ country: "France", start: "2026-09-01", end: "2026-09-20" }], true, [], "2026-11-10");
    expect(v).toHaveLength(1);
    expect(v[0].title).toMatch(/Schengen/);
    expect(visaShifts(stays.slice(0, 1), [], true, [], "2026-11-10")).toEqual([]);
  });

  it("finds a per-entry breach made by an edit, past days of the entry included", () => {
    const rules = [{ country: "Thailand", maxDaysPerEntry: 60 }];
    const long: WatchedStay[] = [{ id: "cm", cityId: "chiang-mai-thailand", name: "Chiang Mai", country: "Thailand", start: "2026-12-01", end: "2027-02-14", fixed: false }];
    const v = visaShifts(long, [], false, rules, "2026-11-10");
    expect(v).toHaveLength(1);
    expect(v[0].key.startsWith("visa:")).toBe(true);
    expect(v[0].stayId).toBe("cm");
    expect(v[0].title).toMatch(/Thailand: one entry of 76 days from 2026-12-01, over your limit of 60/);
    expect(v[0].magnitude).toBeGreaterThan(1);
    // 50 days in the plan, but the entry began 20 days earlier; a rule typed in another case still applies.
    const short: WatchedStay[] = [{ id: "cm", cityId: "chiang-mai-thailand", name: "Chiang Mai", country: "Thailand", start: "2026-11-10", end: "2026-12-30", fixed: false }];
    expect(visaShifts(short, [], false, rules, "2026-11-10")).toEqual([]);
    expect(visaShifts(short, [{ country: "Thailand", start: "2026-10-21", end: "2026-11-10" }], false, [{ country: "thailand", maxDaysPerEntry: 60 }], "2026-11-10")).toHaveLength(1);
    // A visit elsewhere in between starts a new entry.
    const split: WatchedStay[] = [
      { id: "a", cityId: "chiang-mai-thailand", name: "Chiang Mai", country: "Thailand", start: "2026-12-01", end: "2027-01-15", fixed: false },
      { id: "b", cityId: "vientiane-laos", name: "Vientiane", country: "Laos", start: "2027-01-15", end: "2027-01-18", fixed: false },
      { id: "c", cityId: "chiang-mai-thailand", name: "Chiang Mai", country: "Thailand", start: "2027-01-18", end: "2027-03-01", fixed: false },
    ];
    expect(visaShifts(split, [], false, rules, "2026-11-10")).toEqual([]);
  });
});

describe("hysteresis", () => {
  it("does not fire on a continuous reading wobbling around the threshold", () => {
    expect(run([0.9, 1.1, 0.95, 1.15, 0.92, 1.1, 1.05], true)).toEqual([]);
  });

  it("fires once when a reading clearly crosses, and stays quiet while it stays high", () => {
    expect(run([0.5, 1.3, 1.4, 1.5, 1.3, 1.25], true)).toEqual([1]);
  });

  it("does not re-fire inside the cooldown even after clearing and crossing again", () => {
    // Fires on day 1, clears day 2, high again day 3: within 7 days, so silent.
    expect(run([0.2, 1.4, 0.5, 1.4, 1.4], true)).toEqual([1]);
  });

  it("fires again after the cooldown once the shift has cleared", () => {
    expect(run([1.4, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1.4], true)).toEqual([0, 8]);
  });

  it("keeps a discrete shift active until it has been absent for the cooldown", () => {
    // Present day 0, absent days 1-3 (not yet cleared), present day 4: no second fire.
    expect(run([1, 0, 0, 0, 1], false)).toEqual([0]);
    // Absent for 7+ days clears it; present again on day 9 fires again.
    expect(run([1, 0, 0, 0, 0, 0, 0, 0, 0, 1], false)).toEqual([0, 9]);
  });
});

describe("diff", () => {
  it("lists unchanged, moved, removed and added stays", () => {
    const active = [
      { id: "a", cityId: "lisbon", name: "Lisbon", start: "2026-11-10", end: "2026-12-10" },
      { id: "b", cityId: "cm", name: "Chiang Mai", start: "2027-01-05", end: "2027-03-01" },
      { id: "c", cityId: "tb", name: "Tbilisi", start: "2027-03-01", end: "2027-05-01" },
    ];
    const planB = [
      { id: "a", cityId: "lisbon", name: "Lisbon", start: "2026-11-10", end: "2026-12-10" },
      { id: "x1", cityId: "dn", name: "Da Nang", start: "2026-12-10", end: "2027-02-01" },
      { id: "x2", cityId: "tb", name: "Tbilisi", start: "2027-02-01", end: "2027-05-01" },
    ];
    const d = diffStays(active, planB);
    expect(d.map((c) => `${c.kind}:${c.name}`)).toEqual(["unchanged:Lisbon", "added:Da Nang", "removed:Chiang Mai", "moved:Tbilisi"]);
  });
});
