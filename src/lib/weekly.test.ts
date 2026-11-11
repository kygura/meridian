import { describe, expect, it } from "vitest";
import { buildWeekRows, resultKey } from "./replayGrid";
import { resultWhen, weekRangeLabel } from "./repeatCopy";
import { DEFAULT_CONTROLS, buildQuery, controlsFromQuery, narrowQuery } from "./replayQuery";
import { frameBreakdown, frameColumns, frameValues, bestRun, bestRunLabel, type FrameMonth } from "./heatFrame";
import { CONDITIONS, matchesFilter, modeRampVars, modeStep, monthTraits, valueStep, type ClimateMonth } from "./climate";
import type { ReplayResponse, ReplayResult } from "../types";

const result = (over: Partial<ReplayResult>): ReplayResult => ({
  cityId: "a",
  month: 5,
  match: 80,
  dims: [],
  scoredOn: [],
  visitedBefore: false,
  ...over,
});

describe("week labels", () => {
  it("names the dates of a week of the year", () => {
    expect(weekRangeLabel(1)).toBe("Jan 1–7");
    expect(weekRangeLabel(19)).toBe("May 7–13");
    expect(weekRangeLabel(5)).toBe("Jan 29 – Feb 4");
    expect(weekRangeLabel(52)).toBe("Dec 24–31");
  });
  it("words a result by week or by month", () => {
    expect(resultWhen({ month: 5 })).toBe("May");
    expect(resultWhen({ month: 5, week: 19 })).toBe("Week 19 · May 7–13");
  });
  it("keys weekly results apart from monthly ones", () => {
    expect(resultKey({ cityId: "a", month: 5 })).toBe("a:5");
    expect(resultKey({ cityId: "a", month: 5, week: 19 })).toBe("a:w19");
    expect(resultKey({ cityId: "a", month: 5, week: 20 })).not.toBe(resultKey({ cityId: "a", month: 5, week: 19 }));
  });
});

describe("week controls", () => {
  it("sends resolution only when weeks are chosen, so month queries are unchanged", () => {
    const month = buildQuery(DEFAULT_CONTROLS, { journeyId: "j", stopIndex: null });
    expect("resolution" in month).toBe(false);
    const week = buildQuery({ ...DEFAULT_CONTROLS, resolution: "week" }, { journeyId: "j", stopIndex: null });
    expect(week.resolution).toBe("week");
    expect(controlsFromQuery(week).resolution).toBe("week");
    expect(controlsFromQuery(month).resolution).toBe("month");
  });
  it("narrows a row-level watch to one week", () => {
    const q = narrowQuery(buildQuery({ ...DEFAULT_CONTROLS, resolution: "week" }, { journeyId: "j", stopIndex: null }), "opo", 5, 19);
    expect(q.constraints).toMatchObject({ cityIds: ["opo"], months: [5], weeks: [19] });
    expect(q.resolution).toBe("week");
    expect(narrowQuery(q, "opo", 6).constraints?.weeks).toBeUndefined();
  });
});

describe("buildWeekRows", () => {
  const resp: ReplayResponse = {
    results: [result({ cityId: "weekly", month: 5, week: 19, match: 90 }), result({ cityId: "monthly", month: 5, match: 70 })],
    universeSize: 2,
    template: {},
    resolution: "week",
    grid: [
      { cityId: "weekly", months: Array(12).fill(50) },
      { cityId: "monthly", months: [...Array(4).fill(40), 70, ...Array(7).fill(40)] },
    ],
    weekGrid: [{ cityId: "weekly", weeks: Array.from({ length: 52 }, (_, i) => (i === 3 ? null : i)) }],
  };
  const rows = buildWeekRows(resp);

  it("lays a weekly city out across 52 weeks with its ranked week overlaid", () => {
    const r = rows.find((x) => x.cityId === "weekly")!;
    expect(r.cells).toHaveLength(52);
    expect(r.cells[0]).toMatchObject({ match: 0 });
    expect(r.cells[3]).toBeNull();
    expect(r.cells[18]!.result?.week).toBe(19);
    expect(r.cells[18]!.match).toBe(90);
    expect(r.cells[10]!.monthly).toBeUndefined();
  });

  it("stands a month-matched city's month flat across its weeks, marked as monthly", () => {
    const r = rows.find((x) => x.cityId === "monthly")!;
    const mayWeeks = r.cells.map((c, i) => [c, i] as const).filter(([c]) => c?.result);
    expect(mayWeeks.length).toBeGreaterThanOrEqual(4);
    expect(mayWeeks.every(([c]) => c!.monthly && c!.match === 70)).toBe(true);
    expect(r.cells[0]).toMatchObject({ match: 40, monthly: true });
  });
});

describe("heat frame by week", () => {
  const months: FrameMonth[] = Array.from({ length: 12 }, (_, i) => ({ score: 50 + i, tempC: 10 + i, precipMm: 30 + i }));
  const weeks: FrameMonth[] = Array.from({ length: 52 }, (_, i) => ({ score: i, tempC: i / 2, precipMm: 5, pm25: 10 + i }));

  it("has 52 columns, naming the month on its first week only", () => {
    const cols = frameColumns("weeks");
    expect(cols).toHaveLength(52);
    expect(cols[0]!.short).toBe("Jan");
    expect(cols[1]!.short).toBe("");
    expect(cols.filter((c) => c.short).length).toBe(12);
    expect(cols[18]!.name).toMatch(/^Week 19, /);
  });

  it("uses weekly normals when a place has them, and the month's figure for each week otherwise", () => {
    expect(frameValues(months, "comfort", "weeks", weeks)[10]).toBe(10);
    const flat = frameValues(months, "comfort", "weeks");
    expect(flat).toHaveLength(52);
    expect(flat[0]).toBe(50); // January's figure
    expect(flat[51]).toBe(61); // December's
    expect(frameValues(months, "temperature", "weeks", weeks)[4]).toBe(2);
  });

  it("reads air quality as a metric, null where a place has none", () => {
    expect(frameValues(months.map((m) => ({ ...m, pm25: 20 })), "air", "months")[3]).toBe(20);
    expect(frameValues(months, "air", "months").every((v) => v === null)).toBe(true);
    expect(frameValues(months, "air", "weeks", weeks)[2]).toBe(12);
  });

  it("breaks a column's Comfort Index into temperature, rain and air", () => {
    const m: FrameMonth[] = Array.from({ length: 12 }, () => ({ score: 0, tempC: 18, precipMm: 10, pm25: 42.5 }));
    const b = frameBreakdown(m, "months", 2)!;
    expect(b.temp).toBe(100);
    expect(b.rain).toBe(0);
    expect(b.air).toBeCloseTo(20, 5);
    expect(b.score).toBe(80);
    expect(b.airKnown).toBe(true);
    const noAir = frameBreakdown(m.map((x) => ({ ...x, pm25: undefined })), "months", 2)!;
    expect(noAir.airKnown).toBe(false);
    expect(noAir.score).toBe(100);
    const wk = frameBreakdown(m, "weeks", 5, weeks)!;
    expect(wk.per).toBe("week");
    expect(frameBreakdown([{ score: 1 }], "months", 0)).toBeNull();
  });

  it("labels a best run in weeks by its months", () => {
    const run = bestRun(Array.from({ length: 52 }, (_, i) => (i >= 17 && i <= 22 ? 90 : 10)));
    expect(run).toMatchObject({ start: 17, end: 22 });
    expect(bestRunLabel(run, "weeks")).toBe("May–Jun");
  });
});

describe("air quality in the climate vocabulary", () => {
  const month = (pm25?: number): ClimateMonth => ({ score: 70, tempC: 22, precipMm: 20, ...(pm25 !== undefined ? { pm25 } : {}) });
  const traits = (pm25?: number) => monthTraits([month(pm25)], 1)!;

  it("bands a month's PM2.5 and matches the air conditions", () => {
    expect(traits(6).air).toBe("clean");
    expect(traits(180).air).toBe("hazardous");
    expect(matchesFilter(traits(6), { conditions: ["air:clean"], minComfort: 0 })).toBe(true);
    expect(matchesFilter(traits(40), { conditions: ["air:clean"], minComfort: 0 })).toBe(false);
    expect(matchesFilter(traits(180), { conditions: ["air:unhealthy"], minComfort: 0 })).toBe(true);
    expect(matchesFilter(traits(40), { conditions: ["air:clean", "air:poor"], minComfort: 0 })).toBe(true);
  });

  it("never counts a month with no air-quality data as clean", () => {
    expect(traits(undefined).air).toBeUndefined();
    expect(matchesFilter(traits(undefined), { conditions: ["air:clean"], minComfort: 0 })).toBe(false);
    expect(matchesFilter(traits(undefined), { conditions: ["warmth:mild"], minComfort: 0 })).toBe(true);
  });

  it("tints by PM2.5 on its own ramp", () => {
    expect(modeStep("air", traits(3))).toBe(0);
    expect(modeStep("air", traits(30))).toBe(4);
    expect(modeStep("air", traits(150))).toBe(6);
    expect(valueStep("air", 12)).toBe(2);
    expect(modeRampVars("air")[3]).toBe("--smoke-3");
    expect(CONDITIONS.filter((c) => c.group === "air")).toHaveLength(4);
  });
});
