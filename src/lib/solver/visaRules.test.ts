import { describe, expect, it } from "vitest";
import { visaConstraints, NO_PASSPORT_NOTE } from "./visaRules";
import { solve, addMonthsToDate, evaluatePlan, planOf } from "./engine";
import { baseInput, BASE_CONSTRAINTS, POOL, cand } from "./fixtures";
import { checkStays } from "../visa/engine";
import type { VisaData } from "../visa/data";
import type { SolveInput } from "./types";

// A small hand-made data file covering the fixture pool: test inputs, not the real dataset.
const DEST = ["US", "DE", "IN", "PT", "ES", "PL", "GE", "TH", "VN", "ID", "MX", "TR", "MY"];
const row = (cells: Record<string, string>) => DEST.map((d) => cells[d] ?? "vr").join(" ");
const DATA: VisaData = {
  version: 1,
  builtAt: "2026-11-10",
  sources: { requirements: { name: "Test data", url: "https://example.org", fetchedAt: "2026-11-10", licence: "test", datasetUpdated: "2026-02-17" } },
  countries: Object.fromEntries(
    [["US", "United States"], ["DE", "Germany"], ["IN", "India"], ["PT", "Portugal"], ["ES", "Spain"], ["PL", "Poland"], ["GE", "Georgia"], ["TH", "Thailand"], ["VN", "Vietnam"], ["ID", "Indonesia"], ["MX", "Mexico"], ["TR", "Turkey"], ["MY", "Malaysia"]].map(([c, n]) => [c, { name: n }])
  ),
  destinations: DEST,
  matrix: {
    US: row({ US: "-", DE: "vf90", PT: "vf90", ES: "vf90", PL: "vf90", GE: "vf360", TH: "vf60", VN: "vf45", ID: "voa30", MX: "vf180", TR: "vf90", MY: "vf90" }),
    DE: row({ DE: "-", US: "eta90", PT: "vf", ES: "vf", PL: "vf", GE: "vf360", TH: "vf60", VN: "vf45", ID: "voa30", MX: "vf180", TR: "vf90", MY: "vf90" }),
    IN: row({ IN: "-", TH: "vf60", VN: "ev90", ID: "voa30", GE: "ev", TR: "ev30", MY: "vf30" }),
  },
  validity: {},
};
const countries = [...new Set(POOL.map((c) => c.place.country!))];

describe("visaConstraints", () => {
  it("turns Schengen on for a US passport and adds each country's limit as a visa rule", () => {
    const v = visaConstraints(DATA, ["US"], countries, "2027-01-01", BASE_CONSTRAINTS);
    expect(v.constraints.schengen).toBe(true);
    const th = v.constraints.countryRules.find((r) => r.country === "Thailand")!;
    // Thailand's curated 30 days from 15 September 2026 beats the dataset's 60.
    expect(th).toMatchObject({ maxDaysPerEntry: 30, origin: "visa" });
    expect(v.constraints.countryRules.find((r) => r.country === "Turkey")).toMatchObject({ maxDaysIn: { days: 90, windowDays: 180 }, origin: "visa" });
    // No Schengen member gets its own rule: the pooled 90/180 covers them.
    expect(v.constraints.countryRules.some((r) => r.country === "Portugal")).toBe(false);
    expect(v.constraints.visa!.checked.join(" ")).toMatch(/Checked for your United States passport/);
    expect(v.constraints.visa!.checked.join(" ")).toMatch(/Thailand \(30 days per entry\)/);
  });

  it("turns Schengen off with free movement and keeps the owner's rule as the override", () => {
    const v = visaConstraints(DATA, ["DE"], countries, "2027-01-01", { ...BASE_CONSTRAINTS, countryRules: [{ country: "Thailand", maxDaysPerEntry: 45, note: "my extension" }] });
    expect(v.constraints.schengen).toBe(false);
    const th = v.constraints.countryRules.filter((r) => r.country === "Thailand");
    expect(th).toEqual([{ country: "Thailand", maxDaysPerEntry: 45, note: "my extension", origin: "owner" }]);
    expect(v.constraints.visa!.checked.join(" ")).toMatch(/free movement/);
    expect(v.constraints.visa!.checked.join(" ")).toMatch(/Your own rules replace the data for Thailand/);
  });

  it("says when a visa is needed first and where entry is barred", () => {
    const withKp = { ...DATA, countries: { ...DATA.countries, KP: { name: "North Korea" } }, destinations: [...DEST, "KP"], matrix: { ...DATA.matrix, IN: `${DATA.matrix.IN} na` } };
    const v = visaConstraints(withKp, ["IN"], [...countries, "North Korea"], "2027-01-01", BASE_CONSTRAINTS);
    expect(v.constraints.visa!.visaFirst.map((x) => x.country)).toEqual(expect.arrayContaining(["Vietnam", "Georgia", "Turkey"]));
    expect(v.excluded.get("North Korea")).toMatch(/does not admit/);
  });

  it("leaves the owner's settings alone without a passport, and says so", () => {
    const v = visaConstraints(DATA, [], countries, "2027-01-01", { ...BASE_CONSTRAINTS, countryRules: [{ country: "Thailand", maxDaysPerEntry: 60 }] });
    expect(v.constraints.schengen).toBe(true);
    expect(v.constraints.visa).toBeNull();
    expect(v.notes).toEqual([NO_PASSPORT_NOTE]);
  });
});

function withVisa(input: SolveInput, passports: string[]): SolveInput {
  const v = visaConstraints(DATA, passports, [...input.candidates.map((c) => c.place.country!), ...input.prior.map((p) => p.country)], input.start, input.constraints);
  return { ...input, constraints: v.constraints };
}

/** The visa module checks the plan on its own: no limit may be broken from the start on. */
function assertVisaLegal(input: SolveInput, passports: string[], p: ReturnType<typeof solve>["proposals"][number]) {
  expect(p.violations).toEqual([]);
  const r = checkStays(
    DATA,
    passports,
    [...input.prior.map((x, i) => ({ id: `prior-${i}`, country: x.country, start: x.start, end: x.end < input.start ? x.end : input.start, past: true })), ...p.stays.map((s) => ({ id: s.id, country: s.country!, start: s.start, end: s.end }))],
    { today: input.start, overrides: input.constraints.countryRules.filter((x) => x.origin !== "visa") }
  );
  expect(r.violations.map((v) => v.message)).toEqual([]);
}

describe("solver with the visa module", () => {
  it("keeps Thailand to 30 days an entry for a US passport, with a border run where allowed", () => {
    const pool = [
      cand("chiang-mai", "Chiang Mai", "Thailand", 18.79, 98.98, { levels: Array(12).fill("great"), cost: 1000, maxNights: 400 }),
      cand("kuala-lumpur", "Kuala Lumpur", "Malaysia", 3.14, 101.69, { levels: Array(12).fill("poor"), cost: 1400, kind: "pass-through" }),
      cand("tbilisi", "Tbilisi", "Georgia", 41.72, 44.79, { levels: Array(12).fill("fair"), cost: 1300, maxNights: 400 }),
    ];
    const input = withVisa(baseInput({ candidates: pool, constraints: { ...BASE_CONSTRAINTS, allowBorderRuns: true }, results: 1 }), ["US"]);
    const res = solve(input);
    expect(res.ok).toBe(true);
    const p = res.proposals[0];
    assertVisaLegal(input, ["US"], p);
    expect(p.visa.notes.join(" ")).toMatch(/Checked for your United States passport/);
    const cm = p.stays.filter((s) => s.cityId === "chiang-mai");
    expect(cm.length).toBeGreaterThan(0);
  });

  it("notes a stay that needs a visa first", () => {
    const pool = [cand("da-nang", "Da Nang", "Vietnam", 16.05, 108.2, { levels: Array(12).fill("great"), maxNights: 400 }), cand("tbilisi", "Tbilisi", "Georgia", 41.72, 44.79, { maxNights: 400 })];
    const input = withVisa(baseInput({ candidates: pool, results: 1 }), ["IN"]);
    const res = solve(input);
    expect(res.ok).toBe(true);
    const notes = res.proposals[0].stays.flatMap((s) => s.notes);
    expect(notes.some((n) => /E-visa needed for your IN passport/.test(n))).toBe(true);
  });

  it("says when the fixed stays alone already break a limit", () => {
    const input = withVisa(baseInput({ results: 1, prior: [{ country: "Portugal", start: "2026-10-01", end: "2027-01-01" }], fixed: [{ id: "lis", cityId: "lisbon", start: "2027-01-01", end: "2027-02-15", kind: "base", why: "Booked" }] }), ["US"]);
    const res = solve(input);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already break a day limit.*Schengen/);
  });

  it("re-scores an edited plan with the same checks", () => {
    const input = withVisa(baseInput({ results: 1 }), ["US"]);
    const best = solve(input).proposals[0];
    const ev = evaluatePlan(input, planOf(best));
    if ("error" in ev) throw new Error(ev.error);
    expect(ev.violations).toEqual([]);
    expect(ev.visa.notes).toEqual(expect.arrayContaining(input.constraints.visa!.checked));
  });
});

// Seeded random pools and passports, as the solver's own property tests, with the visa module's
// limits as hard rules and checkStays as the independent judge.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("properties with passports", () => {
  let solved = 0;
  let runs = 0;
  for (let trial = 0; trial < 12; trial++) {
    it(`trial ${trial}: every proposal passes the visa module's own check`, () => {
      const r = rng(5000 + trial);
      const passports = [["US"], ["DE"], ["IN"], ["US", "IN"]][Math.floor(r() * 4)];
      const pool = POOL.filter((c) => r() < 0.85).map((c) => ({ ...c, maxNights: c.kind === "base" ? 60 + Math.floor(r() * 120) : c.maxNights }));
      const start = `2027-${String(1 + Math.floor(r() * 12)).padStart(2, "0")}-${String(1 + Math.floor(r() * 27)).padStart(2, "0")}`;
      const input = withVisa(
        baseInput({
          candidates: pool,
          start,
          months: 12 + Math.floor(r() * 7),
          seed: trial,
          beamWidth: 24,
          prior: r() < 0.5 ? [{ country: "Portugal", start: addMonthsToDate(start, -3), end: addMonthsToDate(start, -1) }] : r() < 0.5 ? [{ country: "Thailand", start: addMonthsToDate(start, -1), end: start }] : [],
          constraints: { ...BASE_CONSTRAINTS, allowBorderRuns: r() < 0.5 },
        }),
        passports
      );
      const res = solve(input);
      if (!res.ok) {
        expect(res.error).toBeTruthy();
        return;
      }
      solved++;
      runs += res.proposals.flatMap((p) => p.stays).filter((s) => s.role === "border-run").length;
      for (const p of res.proposals) assertVisaLegal(input, passports, p);
      expect(JSON.stringify(solve(input).proposals.map((p) => p.total))).toBe(JSON.stringify(res.proposals.map((p) => p.total)));
    });
  }
  it("the trials are not vacuous: most find plans, and some use border runs", () => {
    expect(solved).toBeGreaterThanOrEqual(6);
    expect(runs).toBeGreaterThan(0);
  });
});
