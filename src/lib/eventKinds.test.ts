import { describe, it, expect } from "vitest";
import { EVENT_KIND_COLOR_VAR, EVENT_KIND_LABELS, eventInMonth, eventKindLabel, eventMonths, isMapDefaultKind, LIVE_EVENT_KINDS, MAP_DEFAULT_KINDS, orderMonths, recurringWhen } from "./eventKinds";

describe("event kinds", () => {
  it("labels every kind, including the ones from before the refocus, and falls back for an unknown one", () => {
    expect(eventKindLabel("nature")).toBe("Nature");
    expect(eventKindLabel("sky")).toBe("Sky");
    expect(eventKindLabel("season")).toBe("Season");
    expect(eventKindLabel("eclipse")).toBe("Solar eclipse");
    expect(eventKindLabel("festival")).toBe("Festival");
    expect(eventKindLabel("sport")).toBe("Sport");
    expect(eventKindLabel("culture")).toBe("Culture");
    expect(eventKindLabel("something-new")).toBe("Event");
    expect(Object.keys(EVENT_KIND_LABELS).sort()).toEqual(Object.keys(EVENT_KIND_COLOR_VAR).sort());
  });

  it("keeps seasons (tourism and climate) off the map by default and everything else on", () => {
    expect(isMapDefaultKind("season")).toBe(false);
    for (const k of ["festival", "nature", "sky", "eclipse", "culture", "sport", "other", "unknown"]) expect(isMapDefaultKind(k)).toBe(true);
    expect(MAP_DEFAULT_KINDS).not.toContain("season");
    expect(LIVE_EVENT_KINDS).toEqual(["festival", "nature", "sky", "eclipse", "season"]);
  });
});

describe("event months", () => {
  it("uses months when present and valid, else the single month", () => {
    expect(eventMonths({ month: 3, months: [3, 4] })).toEqual([3, 4]);
    expect(eventMonths({ month: 3 })).toEqual([3]);
    expect(eventMonths({ month: 3, months: [] })).toEqual([3]);
    expect(eventMonths({ month: 3, months: [0, 13, 3.5] })).toEqual([3]);
  });

  it("matches a month against every month of the event", () => {
    expect(eventInMonth({ month: 12, months: [12, 1, 2] }, 1)).toBe(true);
    expect(eventInMonth({ month: 12, months: [12, 1, 2] }, 3)).toBe(false);
    expect(eventInMonth({ month: 6 }, 6)).toBe(true);
  });

  it("orders months from where a run begins", () => {
    expect(orderMonths([2, 12, 1])).toEqual([12, 1, 2]);
    expect(orderMonths([9, 10])).toEqual([9, 10]);
    expect(orderMonths([12, 1, 6])).toEqual([6, 12, 1]);
    expect(orderMonths(new Set([4]))).toEqual([4]);
    expect(orderMonths([])).toEqual([]);
    expect(orderMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toHaveLength(12);
    expect(orderMonths([0, 13, 5])).toEqual([5]);
  });

  it("describes a recurring event's months for a label", () => {
    expect(recurringWhen({ month: 3 })).toBe("Every year");
    expect(recurringWhen({ month: 3, months: [3, 4] })).toBe("Mar to Apr");
    expect(recurringWhen({ month: 9, months: [9, 10, 11, 12, 1, 2, 3] })).toBe("Sep to Mar");
  });
});
