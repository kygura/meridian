import { describe, expect, it } from "vitest";
import {
  climateText,
  crowdText,
  matchWord,
  monthsBetween,
  querySentence,
  rangeLabel,
  rangeOfMonths,
  scoreStep,
  shiftLabel,
  tempLabel,
  whyText,
} from "./repeatCopy";
import type { ReplayDimScore } from "../types";

const dim = (name: ReplayDimScore["name"], value: number, templateValue: number, contribution: number): ReplayDimScore => ({
  name,
  value,
  templateValue,
  contribution,
});

describe("month ranges", () => {
  it("builds inclusive ranges and wraps the new year", () => {
    expect(monthsBetween(3, 5)).toEqual([3, 4, 5]);
    expect(monthsBetween(11, 2)).toEqual([11, 12, 1, 2]);
    expect(monthsBetween(6, 6)).toEqual([6]);
  });
  it("finds the range a month list covers", () => {
    expect(rangeOfMonths([5, 3, 4])).toEqual({ from: 3, to: 5 });
    expect(rangeOfMonths([12, 1, 2])).toEqual({ from: 12, to: 2 });
    expect(rangeOfMonths([1, 3])).toBeNull();
    expect(rangeOfMonths([])).toBeNull();
    expect(rangeOfMonths(monthsBetween(1, 12))).toBeNull();
  });
  it("labels ranges in words", () => {
    expect(rangeLabel({ from: 12, to: 2 })).toBe("December to February");
    expect(rangeLabel({ from: 4, to: 4 })).toBe("April");
  });
});

describe("readouts", () => {
  it("reads bends in sentence case", () => {
    expect(tempLabel(0)).toBe("Same temperature");
    expect(tempLabel(-3)).toBe("3°C cooler");
    expect(shiftLabel(2, false, 11)).toBe("2 months later (January)");
    expect(shiftLabel(0, false, 10)).toBe("Same month (October)");
    expect(shiftLabel(1, true, 10)).toBe("Any month");
  });
  it("maps scores to words and ramp steps", () => {
    expect(matchWord(90)).toBe("Near twin");
    expect(matchWord(10)).toBe("Distant");
    expect(scoreStep(0)).toBe(0);
    expect(scoreStep(100)).toBe(6);
    expect(scoreStep(50)).toBe(3);
  });
});

describe("result text", () => {
  const r = {
    dims: [dim("tempC", 21.6, 20, 0.3), dim("precipMm", 3.2, 5, 0.1), dim("dailySpendEur", 80, 96, 0.35), dim("crowdProxy", 40, 62, 0.25)],
  };
  it("summarises climate, crowds and why", () => {
    expect(climateText(r)).toBe("22°C, 3 mm rain");
    expect(crowdText(r)).toBe("Quieter (40 vs 62)");
    expect(whyText(r)).toBe("Mostly climate and budget");
  });
  it("restates a query in one sentence", () => {
    const s = querySentence(
      { template: { journeyId: "j" }, bend: { tempC: 2, spendPct: 0, crowd: -10, monthShift: null }, weights: { climate: 1, spend: 0, crowd: 0, flight: 0 }, constraints: { months: [6, 7], excludeVisited: true } },
      "Lisbon in May"
    );
    expect(s).toBe("Places like Lisbon in May, 2°C warmer, quieter, any month, in June to July, new places only.");
  });
});
