import { describe, expect, it } from "vitest";
import type { City, Journey, ReplayQuery } from "../../../types";
import {
  agoText,
  alertCompareText,
  alertTitle,
  checkedText,
  leadSentence,
  listText,
  querySentence,
  ruleSentence,
  runReportText,
  sortAlerts,
} from "./watchText";

const cities = new Map<string, City>([
  ["lis", { id: "lis", name: "Lisbon" } as City],
  ["opo", { id: "opo", name: "Porto" } as City],
  ["mad", { id: "mad", name: "Madrid" } as City],
]);
const journeys = [{ id: "j1", title: "Portugal spring", stops: [{ cityId: "lis" }, { cityId: "opo" }] }] as unknown as Journey[];

describe("watchText", () => {
  it("joins lists in plain English", () => {
    expect(listText([])).toBe("");
    expect(listText(["a"])).toBe("a");
    expect(listText(["a", "b"])).toBe("a and b");
    expect(listText(["a", "b", "c"])).toBe("a, b and c");
  });

  it("writes rules and lead times as sentences", () => {
    expect(ruleSentence("below_my_median")).toBe("Alert me when the fare is below what you usually pay.");
    expect(ruleSentence("deal_low")).toMatch(/low fare/);
    expect(ruleSentence({ maxEur: 1200 })).toBe("Alert me when the fare is under €1,200.");
    expect(leadSentence([6, 14])).toBe("For departures 6 to 14 weeks from now.");
  });

  it("describes the query", () => {
    const q: ReplayQuery = {
      template: { journeyId: "j1", stopIndex: 1 },
      bend: {},
      weights: { climate: 1, spend: 0, crowd: 0, flight: 0 },
      constraints: { months: [6, 7], fromCityId: "mad" },
    };
    expect(querySentence(q, cities, journeys)).toBe("Places like Porto on Portugal spring, in June or July, flying from Madrid.");
    const whole: ReplayQuery = { ...q, template: { journeyId: "j1" }, constraints: undefined, bend: { monthShift: null } };
    expect(querySentence(whole, cities, journeys)).toBe("Places like your trip Portugal spring, in any month.");
    const row: ReplayQuery = { ...q, constraints: { cityIds: ["opo"], months: [6] } };
    expect(querySentence(row, cities, null)).toBe("Fares to Porto, in June.");
  });

  it("says how long ago", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    expect(agoText("2026-06-10T11:59:40Z", now)).toBe("just now");
    expect(agoText("2026-06-10T11:00:00Z", now)).toBe("1 hour ago");
    expect(agoText("2026-06-09T10:00:00Z", now)).toBe("yesterday");
    expect(agoText("2026-06-06T12:00:00Z", now)).toBe("4 days ago");
    expect(checkedText(undefined, now)).toBe("Not checked yet");
  });

  it("titles and compares alerts", () => {
    expect(alertTitle({ cityId: "opo", month: 6 }, cities)).toBe("Porto in June");
    expect(alertCompareText({ priceEur: 82, baselineEur: 100 })).toBe("18% below what you usually pay (€100)");
    expect(alertCompareText({ priceEur: 82, baselineEur: 100 }, { priceRule: { maxEur: 90 } })).toBe("Under your €90 limit");
    expect(alertCompareText({ priceEur: 82, baselineEur: 0 })).toBeNull();
  });

  it("sorts alerts newest first", () => {
    const a = [{ id: "1", createdAt: "2026-01-01" }, { id: "2", createdAt: "2026-02-01" }] as never[];
    expect(sortAlerts(a).map((x: { id: string }) => x.id)).toEqual(["2", "1"]);
  });

  it("summarises a run", () => {
    expect(runReportText({ watches: 0 })).toBe("No active watches to check.");
    expect(runReportText({ watches: 2, alerts: [] })).toBe("Checked 2 watches. No new alerts.");
    expect(runReportText({ watches: 1, alerts: [{}], errors: [{}] })).toBe("Checked 1 watch. 1 new alert. 1 couldn't be checked.");
  });
});
