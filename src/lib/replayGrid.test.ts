import { describe, it, expect } from "vitest";
import { buildReplayRows, colToMonth, matchWord, monthToCol, replayMarks } from "./replayGrid";
import type { ReplayResponse, ReplayResult } from "../types";

const res = (cityId: string, month: number, match: number, extra: Partial<ReplayResult> = {}): ReplayResult => ({
  cityId,
  month,
  match,
  dims: [],
  scoredOn: ["comfort"],
  visitedBefore: false,
  ...extra,
});

const dense = (fill: number | null): Array<number | null> => Array.from({ length: 12 }, () => fill);

describe("month <-> column (R3: 1-based months, 0-based columns)", () => {
  it("converts both ways", () => {
    expect(monthToCol(1)).toBe(0);
    expect(monthToCol(12)).toBe(11);
    expect(colToMonth(0)).toBe(1);
    expect(colToMonth(monthToCol(7))).toBe(7);
  });
});

describe("buildReplayRows", () => {
  const ev = { id: "e1", title: "Festa", kind: "festival" as const, cityIds: ["opo"], month: 6, recurring: true, tags: [] };
  const grid = dense(40);
  grid[5] = 70; // stage-1 June
  const resp: ReplayResponse = {
    results: [res("opo", 6, 84, { events: [ev] }), res("lis", 5, 80), res("opo", 7, 60)],
    universeSize: 120,
    template: {},
    grid: [
      { cityId: "opo", months: grid },
      { cityId: "lis", months: [...dense(null).slice(0, 11), 33] },
    ],
  };
  const rows = buildReplayRows(resp);

  it("orders distinct cities by best match", () => {
    expect(rows.map((r) => r.cityId)).toEqual(["opo", "lis"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0]!.best.month).toBe(6);
  });

  it("places ranked pairs at month - 1 with the final match and their events", () => {
    const opo = rows[0]!;
    expect(opo.cells).toHaveLength(12);
    expect(opo.cells[5]).toMatchObject({ match: 84, result: { month: 6 } });
    expect(opo.cells[5]!.events).toEqual([ev]);
    expect(opo.cells[6]!.match).toBe(60);
  });

  it("fills the other months from grid (stage-1) without a result", () => {
    const opo = rows[0]!;
    expect(opo.cells[0]).toEqual({ match: 40, events: [] });
    expect(opo.cells[0]!.result).toBeUndefined();
  });

  it("rounds fractional server scores to whole points", () => {
    const r = buildReplayRows({ results: [res("opo", 6, 95.4)], universeSize: 1, template: {}, grid: [{ cityId: "opo", months: dense(33.6) }] })[0]!;
    expect(r.cells[5]!.match).toBe(95);
    expect(r.cells[0]!.match).toBe(34);
  });

  it("keeps null grid entries as null cells", () => {
    const lis = rows[1]!;
    expect(lis.cells[0]).toBeNull();
    expect(lis.cells[4]!.match).toBe(80);
    expect(lis.cells[11]!.match).toBe(33);
  });

  it("without grid, only ranked pairs have cells", () => {
    const sparse = buildReplayRows({ ...resp, grid: undefined });
    expect(sparse[0]!.cells.filter(Boolean)).toHaveLength(2);
  });
});

describe("replayMarks / matchWord", () => {
  it("marks the template month and the bent target", () => {
    expect(replayMarks(5, 7)).toEqual([
      { col: 4, kind: "template" },
      { col: 6, kind: "target" },
    ]);
  });
  it("no target mark when not bent or when any-month", () => {
    expect(replayMarks(5, 5)).toEqual([{ col: 4, kind: "template" }]);
    expect(replayMarks(5, undefined)).toEqual([{ col: 4, kind: "template" }]);
    expect(replayMarks(undefined, undefined)).toEqual([]);
  });
  it("names the match bins", () => {
    expect(matchWord(0)).toBe("FAR");
    expect(matchWord(50)).toBe("SOME");
    expect(matchWord(100)).toBe("TWIN");
  });
});
