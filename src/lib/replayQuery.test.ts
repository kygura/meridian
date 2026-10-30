import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTROLS,
  buildQuery,
  crowdReadout,
  monthReadout,
  narrowQuery,
  querySummary,
  resetBend,
  scorableWeights,
  shiftMonth,
  templateCard,
  tempReadout,
  weightShares,
} from "./replayQuery";
import type { Fingerprint } from "../types";

const fp = (over: Partial<Fingerprint> = {}): Fingerprint => ({
  month: 5,
  weekOfYear: 20,
  tempC: 21,
  precipMm: 4,
  durationNights: 7,
  tags: [],
  status: { month: "ok", comfort: "ok", tempC: "ok", precipMm: "ok", dailySpendEur: "absent", flightCostEurPer1000km: "absent", crowdProxy: "ok" },
  crowdProxy: 62,
  computedAt: "2024-05-01",
  inputsHash: "x",
  ...over,
});

describe("buildQuery", () => {
  it("sends a bare query when nothing is constrained", () => {
    const q = buildQuery(DEFAULT_CONTROLS, { journeyId: "j1", stopIndex: null });
    expect(q.template).toEqual({ journeyId: "j1" });
    expect(q.bend).toEqual({ tempC: 0, spendPct: 0, crowd: 0, monthShift: 0 });
    expect(q.constraints).toBeUndefined();
  });
  it("any month sends monthShift null and a stop sends stopIndex", () => {
    const q = buildQuery({ ...DEFAULT_CONTROLS, anyMonth: true, monthShift: 3 }, { journeyId: "j1", stopIndex: 0 });
    expect(q.bend.monthShift).toBeNull();
    expect(q.template).toEqual({ journeyId: "j1", stopIndex: 0 });
  });
  it("only includes constraints that are set (months 1-based, sorted)", () => {
    const q = buildQuery(
      { ...DEFAULT_CONTROLS, months: [8, 6], excludeVisited: true, maxFlightHours: 6, tags: ["eclipse"] },
      { journeyId: "j", stopIndex: null }
    );
    expect(q.constraints).toEqual({ months: [6, 8], excludeVisited: true, maxFlightHours: 6, tags: ["eclipse"] });
  });
  it("narrowQuery adds the row-level city and month", () => {
    const q = narrowQuery(buildQuery({ ...DEFAULT_CONTROLS, excludeVisited: true }, { journeyId: "j", stopIndex: null }), "opo", 6);
    expect(q.constraints).toEqual({ excludeVisited: true, cityIds: ["opo"], months: [6] });
  });
  it("resetBend zeroes the four sliders and keeps the rest", () => {
    const c = resetBend({ ...DEFAULT_CONTROLS, tempC: 4, spendPct: -10, crowd: 5, monthShift: 2, anyMonth: true, excludeVisited: true });
    expect(c).toMatchObject({ tempC: 0, spendPct: 0, crowd: 0, monthShift: 0, anyMonth: false, excludeVisited: true });
  });
});

describe("months and readouts", () => {
  it("wraps shifts into 1-12", () => {
    expect(shiftMonth(5, 2)).toBe(7);
    expect(shiftMonth(11, 3)).toBe(2);
    expect(shiftMonth(2, -4)).toBe(10);
  });
  it("formats signed readouts", () => {
    expect(tempReadout(3)).toEqual({ text: "+3 °C", spoken: "3 degrees warmer" });
    expect(tempReadout(-2).text).toBe("−2 °C");
    expect(crowdReadout(-20).text).toBe("FEWER 20");
    expect(monthReadout(2, false, 5).text).toBe("+2 MO → JUL");
    expect(monthReadout(2, true, 5)).toEqual({ text: "ANY", spoken: "any month" });
  });
});

describe("weights", () => {
  const w = { climate: 0.5, spend: 0.25, crowd: 0.25, flight: 0 };
  it("normalizes over scorable dimensions and nulls the rest", () => {
    const scorable = { climate: true, spend: false, crowd: true, flight: true };
    expect(weightShares(w, scorable)).toEqual({ climate: 67, spend: null, crowd: 33, flight: 0 });
  });
  it("spend is unscorable without recorded money; crowd without a proxy", () => {
    expect(scorableWeights(fp(), "observed")).toEqual({ climate: true, spend: false, crowd: true, flight: true });
    expect(scorableWeights(fp({ crowdProxy: undefined }), "normal").crowd).toBe(false);
    expect(scorableWeights(undefined, undefined)).toEqual({ climate: true, spend: true, crowd: true, flight: true });
    expect(scorableWeights(fp(), "none").climate).toBe(false);
  });
  it("all zero weights give 0 shares, not NaN", () => {
    const z = { climate: 0, spend: 0, crowd: 0, flight: 0 };
    expect(weightShares(z, { climate: true, spend: true, crowd: true, flight: true }).climate).toBe(0);
  });
});

describe("templateCard / querySummary", () => {
  it("shows values for ok dims and an em dash with status otherwise", () => {
    const items = templateCard(fp());
    expect(items.find((i) => i.key === "month")).toMatchObject({ text: "MAY", status: "ok" });
    expect(items.find((i) => i.key === "tempC")!.text).toBe("21°C");
    expect(items.find((i) => i.key === "crowdProxy")!.text).toBe("CROWD 62 (PROXY)");
    expect(items.find((i) => i.key === "dailySpendEur")).toMatchObject({ text: "—", status: "absent" });
  });
  it("no fingerprint: everything absent", () => {
    expect(templateCard(undefined).every((i) => i.text === "—")).toBe(true);
  });
  it("summarizes the bend and constraints", () => {
    const q = narrowQuery(buildQuery({ ...DEFAULT_CONTROLS, tempC: 3, spendPct: -25 }, { journeyId: "j", stopIndex: null }), "opo", 6);
    expect(querySummary(q, "Lisbon May")).toBe("TEMPLATE LISBON MAY · +3°C · −25 % SPEND · CITY OPO · MONTHS JUN");
  });
});
