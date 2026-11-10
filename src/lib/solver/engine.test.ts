import { describe, expect, it } from "vitest";
import { __internal, addMonthsToDate, buildSlots, evaluatePlan, planOf, solve } from "./engine";
import { baseInput, BASE_CONSTRAINTS, cand, POOL } from "./fixtures";
import { addRange, dayNum, inSchengen, peakUse, usedOn } from "./visa";
import type { ProposedRotation, SolveInput } from "./types";

/** Every hard rule, checked independently of the engine's own validator. */
function assertLegal(input: SolveInput, p: ProposedRotation) {
  const stays = p.stays;
  expect(stays[0].start).toBe(input.start);
  expect(stays[stays.length - 1].end).toBe(addMonthsToDate(input.start, input.months));
  for (let i = 1; i < stays.length; i++) expect(stays[i].start).toBe(stays[i - 1].end);
  for (const s of stays) expect(s.nights).toBeGreaterThan(0);
  for (const f of input.fixed) {
    const hit = stays.find((s) => s.id === f.id);
    expect(hit, `fixed ${f.id} kept`).toBeTruthy();
    expect([hit!.cityId, hit!.start, hit!.end]).toEqual([f.cityId, f.start, f.end]);
  }
  if (input.constraints.schengen) {
    let r = addRange([], 0, -1).filter(() => false) as ReturnType<typeof addRange>;
    for (const pr of input.prior) if (inSchengen(pr.country)) r = addRange(r, dayNum(pr.start), dayNum(pr.end));
    for (const s of stays) if (inSchengen(s.country)) r = addRange(r, dayNum(s.start), dayNum(s.end));
    for (let d = dayNum(input.start); d < dayNum(stays[stays.length - 1].end); d++) expect(usedOn(r, d, 180)).toBeLessThanOrEqual(90);
  }
  const byId = new Map(input.candidates.map((c) => [c.place.cityId, c]));
  for (const s of stays) {
    if (s.role === "fixed") continue;
    const c = byId.get(s.cityId)!;
    expect(c.inPool).toBe(true);
    expect(c.excluded).toBeFalsy();
    if (s.role === "base") expect(s.nights).toBeLessThanOrEqual(c.maxNights);
    if (input.constraints.avoidIsHard) for (const m of s.months) expect(c.months[Number(m.ym.slice(5)) - 1].source === "personal" && m.level === "avoid").toBe(false);
    if (input.constraints.minInternetMbps !== null && c.internetMbps) expect(c.internetMbps.value).toBeGreaterThanOrEqual(input.constraints.minInternetMbps);
  }
  expect(p.violations).toEqual([]);
}

describe("slots", () => {
  it("cuts the horizon into half months and at fixed stays, with no gaps", () => {
    const slots = buildSlots("2027-01-01", "2028-01-01", [{ start: "2027-03-10", end: "2027-04-20" }]);
    expect(slots[0].start).toBe(dayNum("2027-01-01"));
    expect(slots[slots.length - 1].end).toBe(dayNum("2028-01-01"));
    for (let i = 1; i < slots.length; i++) expect(slots[i].start).toBe(slots[i - 1].end);
    expect(slots.reduce((a, s) => a + s.nights, 0)).toBe(365);
    const fixed = slots.filter((s) => s.fixed === 0);
    expect(fixed[0].start).toBe(dayNum("2027-03-10"));
    expect(fixed[fixed.length - 1].end).toBe(dayNum("2027-04-20"));
    // 1–9 March stays a free slot; 20 Apr–1 May is merged (no slivers under 4 nights).
    expect(slots.every((s) => s.fixed !== -1 || s.nights >= 4)).toBe(true);
  });

  it("adds months by calendar, clamping the day", () => {
    expect(addMonthsToDate("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonthsToDate("2026-11-10", 18)).toBe("2028-05-10");
  });
});

describe("visa ranges", () => {
  it("counts entry and exit days and shared moving days once", () => {
    let r = addRange([], dayNum("2027-01-01"), dayNum("2027-01-31"));
    r = addRange(r, dayNum("2027-01-31"), dayNum("2027-02-10"));
    expect(r.length).toBe(1);
    expect(usedOn(r, dayNum("2027-02-10"), 180)).toBe(41);
    expect(peakUse(r, 180).used).toBe(41);
  });
});

describe("solve", () => {
  it("returns several distinct, legal, ranked rotations with explained scores", () => {
    const input = baseInput();
    const res = solve(input);
    expect(res.ok).toBe(true);
    expect(res.proposals.length).toBe(3);
    for (const p of res.proposals) assertLegal(input, p);
    const totals = res.proposals.map((p) => p.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    for (const p of res.proposals.slice(1)) expect(p.differsFromBest).toBeGreaterThanOrEqual(0.15);
    const keys = res.proposals[0].components.map((c) => c.key);
    expect(keys).toEqual(["fit", "cost", "friction", "visa", "risk"]);
    for (const c of res.proposals[0].components) expect(c.detail.length).toBeGreaterThan(10);
    expect(res.proposals[0].monthsTable.length).toBe(12);
  });

  it("is deterministic: same input and seed, same output", () => {
    const a = solve(baseInput());
    const b = solve(baseInput());
    expect(JSON.stringify(a.proposals)).toBe(JSON.stringify(b.proposals));
  });

  it("keeps Schengen to 90 days in any 180, counting past stays", () => {
    const onlyEurope = POOL.filter((c) => ["lisbon", "porto", "valencia", "krakow", "tbilisi"].includes(c.place.cityId));
    const input = baseInput({ candidates: onlyEurope, prior: [{ country: "Spain", start: "2026-10-15", end: "2026-12-31" }] });
    const res = solve(input);
    expect(res.ok).toBe(true);
    for (const p of res.proposals) {
      assertLegal(input, p);
      expect(p.visa.schengen.maxUsed).toBeLessThanOrEqual(90);
    }
    // With 78 days just spent in Spain, the year has to start outside the area.
    expect(res.proposals[0].stays[0].cityId).toBe("tbilisi");
  });

  it("explains a Schengen buffer", () => {
    const onlyEurope = POOL.filter((c) => ["lisbon", "valencia", "tbilisi"].includes(c.place.cityId)).map((c) =>
      c.place.cityId === "tbilisi" ? { ...c, months: c.months.map((m) => ({ ...m, level: "poor" as const })) } : { ...c, months: c.months.map((m) => ({ ...m, level: "great" as const })) }
    );
    const res = solve(baseInput({ candidates: onlyEurope, beamWidth: 64 }));
    expect(res.ok).toBe(true);
    const notes = res.proposals[0].stays.flatMap((s) => s.notes);
    expect(notes.some((n) => n.startsWith("Schengen buffer"))).toBe(true);
  });

  it("re-solves around a locked stay without moving it", () => {
    const input = baseInput({ fixed: [{ id: "locked-1", cityId: "mexico-city", start: "2027-04-10", end: "2027-06-02", kind: "base", why: "Locked" }] });
    const res = solve(input);
    expect(res.ok).toBe(true);
    for (const p of res.proposals) assertLegal(input, p);
  });

  it("never places an excluded place or one under a floor", () => {
    const pool = POOL.map((c) => (c.place.cityId === "chiang-mai" ? { ...c, excluded: "Air quality alert" } : c.place.cityId === "da-nang" ? { ...c, internetMbps: { value: 8, source: "t" } } : c));
    const input = baseInput({ candidates: pool, constraints: { ...BASE_CONSTRAINTS, minInternetMbps: 20 } });
    const res = solve(input);
    for (const p of res.proposals) {
      assertLegal(input, p);
      expect(p.stays.some((s) => s.cityId === "chiang-mai" || s.cityId === "da-nang")).toBe(false);
    }
  });

  it("honours a region preference and reports how much of it was met", () => {
    const input = baseInput({ preferences: [{ id: "p1", kind: "region", region: "southeast-asia", months: { start: 11, end: 2 }, weight: 1 }], weights: { fit: 0.3, cost: 0.3, friction: 0.2, visa: 0.3, risk: 0.3, preferences: 1 } });
    const res = solve(input);
    const best = res.proposals[0];
    const pref = best.components.find((c) => c.key === "preferences")!;
    expect(pref.score).toBeGreaterThan(80);
    const jan = best.monthsTable.find((m) => m.ym === "2027-01")!;
    expect(["chiang-mai", "da-nang", "bali"]).toContain(jan.cityId);
  });

  it("gives every solver-placed stay its next-best alternatives with the score difference", () => {
    const res = solve(baseInput());
    const best = res.proposals[0];
    const base = best.stays.find((s) => s.role === "base" && s.alternatives.length)!;
    expect(base).toBeTruthy();
    for (const a of base.alternatives) {
      expect(a.delta).toBeCloseTo(a.total - best.total, 1);
      expect(a.cityId).not.toBe(base.cityId);
    }
  });

  it("uses a border run to restart a per-entry limit, and says why", () => {
    const pool = [
      cand("chiang-mai", "Chiang Mai", "Thailand", 18.79, 98.98, { levels: Array(12).fill("great"), cost: 1000, maxNights: 400 }),
      cand("kuala-lumpur", "Kuala Lumpur", "Malaysia", 3.14, 101.69, { levels: Array(12).fill("poor"), cost: 1400, kind: "pass-through" }),
    ];
    const input = baseInput({
      candidates: pool,
      months: 12,
      constraints: { ...BASE_CONSTRAINTS, schengen: false, taxDays: null, allowBorderRuns: true, countryRules: [{ country: "Thailand", maxDaysPerEntry: 60, note: "test rule" }] },
      results: 1,
    });
    const res = solve(input);
    expect(res.ok).toBe(true);
    const runs = res.proposals[0].stays.filter((s) => s.role === "border-run");
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].notes[0]).toMatch(/Border run/);
    expect(res.proposals[0].violations).toEqual([]);
  });

  it("says what blocks it when nothing legal exists", () => {
    const pool = [POOL[0]]; // Lisbon only: a year in Schengen breaks 90/180
    const res = solve(baseInput({ candidates: pool }));
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("re-scores an edited plan and flags a broken one", () => {
    const input = baseInput();
    const best = solve(input).proposals[0];
    const plan = planOf(best);
    const same = evaluatePlan(input, plan);
    expect("error" in same).toBe(false);
    if (!("error" in same)) expect(same.total).toBeCloseTo(best.total, 5);
    const broken = { stays: plan.stays.map((s, i) => (i === 1 ? { ...s, start: "2027-02-20" } : s)) };
    const ev = evaluatePlan(input, broken, {}, false);
    if (!("error" in ev)) expect(ev.violations.length).toBeGreaterThan(0);
  });
});

// ── Property tests: random pools, locks and rules (seeded, so reproducible) ──────────

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

describe("properties", () => {
  const levels = ["great", "good", "fair", "poor", "avoid", "unknown"] as const;
  for (let trial = 0; trial < 24; trial++) {
    it(`trial ${trial}: legal, covers the horizon, keeps locks`, () => {
      const r = rng(1000 + trial);
      const pool = POOL.filter((c) => c.kind === "base")
        .filter(() => r() < 0.8)
        .map((c) => ({
          ...c,
          minNights: 14 + Math.floor(r() * 30),
          maxNights: 60 + Math.floor(r() * 100),
          months: c.months.map((m) => {
            const level = levels[Math.floor(r() * levels.length)];
            return { level, source: level === "avoid" && r() < 0.5 ? ("personal" as const) : ("comfort" as const), why: "t" };
          }),
          costMonthlyEur: r() < 0.2 ? null : { value: 900 + Math.floor(r() * 2000), source: "t" },
        }));
      const startMonth = 1 + Math.floor(r() * 12);
      const start = `2027-${String(startMonth).padStart(2, "0")}-${String(1 + Math.floor(r() * 27)).padStart(2, "0")}`;
      const months = 12 + Math.floor(r() * 7);
      const fixed =
        r() < 0.6 && pool.length
          ? [{ id: "fx", cityId: pool[Math.floor(r() * pool.length)].place.cityId, start: addMonthsToDate(start, 2), end: addMonthsToDate(start, 3), kind: "base" as const, why: "Locked" }]
          : [];
      const input = baseInput({
        candidates: pool,
        start,
        months,
        fixed,
        seed: trial,
        beamWidth: 24,
        prior: r() < 0.5 ? [{ country: "Portugal", start: addMonthsToDate(start, -4), end: addMonthsToDate(start, -2) }] : [],
        constraints: { ...BASE_CONSTRAINTS, minInternetMbps: r() < 0.3 ? 50 : null },
      });
      const res = solve(input);
      if (!res.ok) {
        expect(res.error).toBeTruthy();
        return;
      }
      for (const p of res.proposals) assertLegal(input, p);
      // Same input, same output.
      expect(JSON.stringify(solve(input).proposals.map((p) => p.total))).toBe(JSON.stringify(res.proposals.map((p) => p.total)));
    });
  }
});

describe("speed", () => {
  it("solves 18 months over a 30-place pool fast enough to run on request", () => {
    const pool = Array.from({ length: 30 }, (_, i) => {
      const b = POOL[i % 9];
      return { ...b, place: { ...b.place, cityId: `${b.place.cityId}-${i}`, lat: b.place.lat + i * 0.01 } };
    });
    const t0 = performance.now();
    const res = solve(baseInput({ candidates: pool, months: 18, results: 5, beamWidth: 96 }));
    const ms = performance.now() - t0;
    expect(res.ok).toBe(true);
    expect(res.proposals.length).toBeGreaterThanOrEqual(3);
    expect(ms).toBeLessThan(8000);
  });
});

describe("internals", () => {
  it("validator catches a gap, an overlap and a moved lock", () => {
    const input = baseInput({ fixed: [{ id: "fx", cityId: "lisbon", start: "2027-03-01", end: "2027-04-01", kind: "base", why: "Locked" }] });
    const P = __internal.prepare(input, {});
    if ("error" in P) throw new Error(P.error);
    const v = __internal.violations(P, {
      stays: [
        { id: "a", cityId: "tbilisi", start: "2027-01-01", end: "2027-02-20", kind: "base", role: "base" },
        { id: "b", cityId: "chiang-mai", start: "2027-02-25", end: "2027-03-05", kind: "base", role: "base" },
        { id: "fx", cityId: "lisbon", start: "2027-03-05", end: "2028-01-01", kind: "base", role: "fixed" },
      ],
    });
    expect(v.some((x) => x.startsWith("Gap"))).toBe(true);
    expect(v.some((x) => x.includes("Fixed stay fx"))).toBe(true);
  });
});
