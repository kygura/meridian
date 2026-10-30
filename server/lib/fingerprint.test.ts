import { describe, it, expect } from "vitest";
import { computeFingerprint, computeInputsHash, needsRecompute } from "./fingerprint";
import { dominantMonth, isoWeek, stayNights } from "./stayDates";
import { haversineKm } from "../../src/lib/geo";
import { fixtureFingerprintDeps, lisbonJourney, getCity } from "./__fixtures__/journal";
import type { Fingerprint, Journey } from "../../src/types";

const strip = (j: Journey) =>
  JSON.parse(JSON.stringify(j, (k, v) => (k === "computedAt" ? undefined : v)));

describe("stay date helpers", () => {
  it("counts nights and picks the dominant month (ties → earliest)", () => {
    expect(stayNights("2024-05-10", "2024-05-17")).toBe(7);
    expect(dominantMonth("2024-01-29", "2024-02-05")).toBe(2);
    expect(dominantMonth("2024-01-28", "2024-02-05")).toBe(1);
    expect(dominantMonth("2024-12-30", "2025-01-02")).toBe(12);
  });
  it("computes ISO weeks", () => {
    expect(isoWeek("2024-05-13")).toBe(20);
    expect(isoWeek("2024-12-30")).toBe(1);
    expect(isoWeek("2021-01-03")).toBe(53);
  });
});

describe("computeFingerprint — Lisbon May 2024 fixture", () => {
  it("fills every dimension from real inputs", async () => {
    const { deps } = fixtureFingerprintDeps();
    const { journey, fingerprint: fp } = await computeFingerprint(lisbonJourney(), deps);

    expect(fp.month).toBe(5);
    expect(fp.weekOfYear).toBe(20);
    expect(fp.durationNights).toBe(7);
    expect(fp.tempC).toBe(19.2);
    expect(fp.precipMm).toBe(10);
    expect(fp.comfort).toBe(100);
    expect(fp.dailySpendEur).toBe(57.14); // (700 + 60 + 40) / 7 / 2
    const lis = getCity("lisbon-portugal")!;
    const ber = getCity("berlin-germany")!;
    const km = haversineKm([ber.lng, ber.lat], [lis.lng, lis.lat]) * 2;
    expect(fp.flightCostEurPer1000km).toBeCloseTo((340 / km) * 1000, 1);
    expect(fp.crowdProxy).toBeGreaterThanOrEqual(0);
    expect(fp.crowdIsOverride).toBeUndefined();
    expect(fp.rating).toBe(5);
    expect(fp.tags).toEqual(["city", "food"]);
    expect(Object.values(fp.status).every((s) => s === "ok")).toBe(true);
    expect(fp.inputsHash).toMatch(/^[0-9a-f]{40}$/);

    const stop = journey.stops[0]!;
    expect(stop.observed).toEqual({ tempC: 19.2, precipMm: 10, comfort: 100, normalComfort: 98, normalTempC: 18.5 });
    expect(stop.fingerprint?.dailySpendEur).toBe(57.14);
    expect(stop.fingerprint?.flightCostEurPer1000km).toBeCloseTo((180 / (km / 2)) * 1000, 1);
    expect(journey.fingerprint).toEqual(fp);
  });

  it("is deterministic: two runs differ only in computedAt", async () => {
    const a = await computeFingerprint(lisbonJourney(), fixtureFingerprintDeps({ now: new Date("2026-01-01T00:00:00Z") }).deps);
    const b = await computeFingerprint(lisbonJourney(), fixtureFingerprintDeps({ now: new Date("2026-06-01T00:00:00Z") }).deps);
    expect(a.fingerprint.computedAt).not.toBe(b.fingerprint.computedAt);
    expect(strip(a.journey)).toEqual(strip(b.journey));
  });

  it("marks weather pending on quota and never guesses", async () => {
    const { deps } = fixtureFingerprintDeps({ weather: "quota" });
    const { journey, fingerprint: fp } = await computeFingerprint(lisbonJourney(), deps);
    for (const d of ["comfort", "tempC", "precipMm"] as const) {
      expect(fp.status[d]).toBe("pending");
      expect(fp[d]).toBeUndefined();
    }
    expect(fp.status.dailySpendEur).toBe("ok");
    expect(journey.stops[0]!.observed).toBeUndefined();
    expect(needsRecompute(journey)).toBe(true);
  });

  it("leaves spend absent (not zero) when no money was recorded", async () => {
    const j = lisbonJourney();
    j.stops[0]!.lodging = { name: "friends", kind: "friends", provenance: j.provenance };
    j.experiences = j.experiences.map(({ cost, ...e }) => e);
    j.segments = j.segments.map(({ cost, ...s }) => s);
    const { fingerprint: fp } = await computeFingerprint(j, fixtureFingerprintDeps().deps);
    expect(fp.dailySpendEur).toBeUndefined();
    expect(fp.status.dailySpendEur).toBe("absent");
    expect(fp.flightCostEurPer1000km).toBeUndefined();
    expect(fp.status.flightCostEurPer1000km).toBe("absent");
  });

  it("persists crowd flags when holiday data is unavailable", async () => {
    const { fingerprint: fp, journey } = await computeFingerprint(lisbonJourney(), fixtureFingerprintDeps({ nager: "fail" }).deps);
    expect(fp.crowdFlags).toEqual(["holidays_unavailable"]);
    expect(journey.stops[0]!.fingerprint!.crowdFlags).toEqual(["holidays_unavailable"]);
    const ok = await computeFingerprint(lisbonJourney(), fixtureFingerprintDeps().deps);
    expect(ok.fingerprint.crowdFlags).toBeUndefined();
  });

  it("uses the stop's crowdOverride over the proxy", async () => {
    const j = lisbonJourney();
    j.stops[0]!.crowdOverride = 95;
    const { fingerprint: fp } = await computeFingerprint(j, fixtureFingerprintDeps().deps);
    expect(fp.crowdProxy).toBe(95);
    expect(fp.crowdIsOverride).toBe(true);
  });

  it("nights-weights journey-level crowd and climate across stops", async () => {
    const j = lisbonJourney({ endDate: "2024-05-20" });
    j.stops[0]!.crowdOverride = 80;
    j.stops.push({ cityId: "porto-portugal", arrive: "2024-05-17", depart: "2024-05-20", crowdOverride: 30 });
    const { fingerprint: fp } = await computeFingerprint(j, fixtureFingerprintDeps().deps);
    expect(fp.crowdProxy).toBe(Math.round((80 * 7 + 30 * 3) / 10));
    expect(fp.durationNights).toBe(10);
  });

  it("marks weather absent (not pending) for an unknown city", async () => {
    const j = lisbonJourney();
    j.stops[0]!.cityId = "atlantis-x";
    const { fingerprint: fp } = await computeFingerprint(j, fixtureFingerprintDeps().deps);
    expect(fp.status.tempC).toBe("absent");
    expect(fp.status.crowdProxy).toBe("absent");
  });
});

describe("needsRecompute / inputsHash", () => {
  it("is false right after a complete compute, true after inputs change", async () => {
    const { journey } = await computeFingerprint(lisbonJourney(), fixtureFingerprintDeps().deps);
    expect(needsRecompute(journey)).toBe(false);
    expect(needsRecompute({ ...journey, companions: 3 })).toBe(true);
    const moved = { ...journey, stops: [{ ...journey.stops[0]!, depart: "2024-05-18" }] };
    expect(needsRecompute(moved)).toBe(true);
    expect(needsRecompute({ ...journey, fingerprint: undefined })).toBe(true);
  });

  it("ignores computed fields and key order", () => {
    const j = lisbonJourney();
    const withComputed: Journey = {
      ...j,
      notes: "changed notes don't matter",
      stops: [{ ...j.stops[0]!, observed: { tempC: 1, precipMm: 1, comfort: 1, normalComfort: 1 }, fingerprint: {} as Fingerprint }],
    };
    expect(computeInputsHash(withComputed)).toBe(computeInputsHash(j));
  });
});
