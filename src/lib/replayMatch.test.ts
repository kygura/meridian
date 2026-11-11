import { describe, expect, it } from "vitest";
import { matchSummary, replayPlaces } from "./replayMatch";
import type { PlaceResult } from "../types";

const rm: NonNullable<PlaceResult["replayMatch"]> = {
  match: 83.6,
  month: 4,
  dims: [
    { name: "tempC", value: 20, templateValue: 21, contribution: 0.2 },
    { name: "dailySpendEur", value: 90, templateValue: 100, contribution: 0.55 },
    { name: "crowdProxy", value: 40, templateValue: 50, contribution: 0.25 },
    { name: "precipMm", value: 10, templateValue: 10, contribution: 0 },
  ],
  scoredOn: ["tempC", "dailySpendEur", "crowdProxy"],
};

describe("matchSummary", () => {
  it("rounds, names the month, orders the top dims, and lists what was scored", () => {
    const s = matchSummary(rm)!;
    expect(s.match).toBe(84);
    expect(s.month).toBe("APR");
    expect(s.top).toEqual([
      { name: "dailySpendEur", label: "SPEND", pct: 55 },
      { name: "crowdProxy", label: "CROWD", pct: 25 },
      { name: "tempC", label: "TEMPERATURE", pct: 20 },
    ]);
    expect(s.scoredOn).toEqual(["TEMPERATURE", "SPEND", "CROWD"]);
  });
  it("is null when the place has no replay breakdown (card unchanged)", () => {
    expect(matchSummary(undefined)).toBeNull();
  });
});

describe("agent request helpers", () => {
  it("collects replay places from find_similar_windows results only", () => {
    const place = { cityId: "porto", name: "Porto", replayMatch: rm } as PlaceResult;
    const plain = { cityId: "x", name: "X" } as PlaceResult;
    const got = replayPlaces([
      { toolName: "search_places", state: "result", result: { places: [place] } },
      { toolName: "find_similar_windows", state: "call" },
      { toolName: "find_similar_windows", state: "result", result: { places: [place, plain] } },
      { toolName: "find_similar_windows", state: "result", result: { error: "journal_locked" } },
    ]);
    expect(got).toEqual([place]);
    expect(replayPlaces(undefined)).toEqual([]);
  });
});
