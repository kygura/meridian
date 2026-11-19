import { describe, expect, it } from "vitest";
import {
  ORIGIN_TEXT,
  buildConfigPatch,
  comfortStep,
  configToForm,
  issuesToErrors,
  parseEuro,
  parseList,
  planThisText,
  runKindLabel,
  runSummaryText,
  runTopText,
  stripCells,
  timeAgo,
  tripDatesText,
  vsMedianText,
  watchBudgetText,
  windowText,
} from "./atlasFormat";
import type { AtlasConfig, RunSummary } from "./atlasApi";

const config = {
  profile: { persona: "Slow traveller", intentTags: ["surf", "hiking"], avoid: ["resorts"] },
  hardFilters: { maxStops: 1, maxTravelTimeHours: 14, maxLayoverWaitHours: 6, budgetEconomyEur: { min: 100, max: 600 }, fallbackOrigins: ["LPA", "MAD"], lastminuteWindowDays: 14 },
  windows: { a: { minDays: 3, maxDays: 21 }, b: { minDays: 45, maxDays: 120 } },
  tripPreferences: { activities: { budgetPerDayEur: 80 } },
} as unknown as AtlasConfig;

describe("windowText", () => {
  it("shows the year once inside one year", () => {
    expect(windowText({ from: "2026-12-01", to: "2026-12-20" })).toBe("1 Dec to 20 Dec 2026");
  });
  it("shows both years across a year end", () => {
    expect(windowText({ from: "2026-12-20", to: "2027-01-10" })).toBe("20 Dec 2026 to 10 Jan 2027");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  it("reads minutes, hours and days", () => {
    expect(timeAgo("2026-11-18T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-11-18T11:30:00Z", now)).toBe("30 min ago");
    expect(timeAgo("2026-11-18T11:00:00Z", now)).toBe("1 hour ago");
    expect(timeAgo("2026-11-16T12:00:00Z", now)).toBe("2 days ago");
    expect(timeAgo("not a date", now)).toBe("");
  });
});

describe("origin text", () => {
  it("names every way the origin is found", () => {
    expect(ORIGIN_TEXT["rotation-current"]).toBe("where you are now (Rotation)");
    expect(Object.keys(ORIGIN_TEXT).sort()).toEqual(["fallback", "rotation-current", "rotation-home", "rotation-next"]);
  });
});

describe("comfortStep", () => {
  it("maps 0 to 100 onto ramp steps 0 to 6", () => {
    expect(comfortStep(0)).toBe(0);
    expect(comfortStep(50)).toBe(3);
    expect(comfortStep(100)).toBe(6);
    expect(comfortStep(140)).toBe(6);
    expect(comfortStep(-5)).toBe(0);
    expect(comfortStep(Number.NaN)).toBe(0);
  });
});

describe("stripCells", () => {
  const place = {
    avoidMonths: [8],
    season: {
      year: [10, 20, 40, 60, 80, 95, 100, 90, 70, 50, 30, 15],
      bestMonths: [6, 7],
      months: [{ month: 7, comfort: 100, crowd: 40, signal: { cityId: "x", month: 7, quiet: 2, conditions: 5, events: [{ title: "Festival" }], note: "Busy harbour", sources: [], researchedAt: "" } }],
      avoidNow: false,
    },
  };
  it("builds twelve cells with best, avoided and signal marks", () => {
    const cells = stripCells(place);
    expect(cells).toHaveLength(12);
    expect(cells[0]).toMatchObject({ month: 1, comfort: 10, step: 1, best: false, avoided: false });
    expect(cells[6]).toMatchObject({ month: 7, comfort: 100, step: 6, best: true });
    expect(cells[6].signal?.quiet).toBe(2);
    expect(cells[6].title).toContain("one of the best months");
    expect(cells[6].title).toContain("quiet 2 of 5");
    expect(cells[6].title).toContain("events: Festival");
    expect(cells[7]).toMatchObject({ avoided: true });
    expect(cells[7].title).toContain("avoid");
  });
  it("leaves comfort empty when there is no climate data", () => {
    const cells = stripCells({ avoidMonths: [], season: { year: null, bestMonths: [], months: [], avoidNow: false } });
    expect(cells.every((c) => c.comfort === null && c.step === null)).toBe(true);
    expect(cells[0].title).toContain("no climate data");
  });
});

describe("runs", () => {
  const scan: RunSummary = { id: "scan-1", kind: "scan", mode: "scheduled", at: "x", origin: "LPA", counts: { flights: 12, scored: 10, rejected: 2, passed: 6, watchHits: 1 }, top: { flightId: "f", destination: "Lisbon", priceEur: 213.6, composite: 7.2 } };
  it("summarises a scan", () => {
    expect(runSummaryText(scan)).toBe("12 fares, 6 passed, 2 rejected, 1 watch hit");
    expect(runTopText(scan)).toBe("Lisbon, 214 EUR");
    expect(runKindLabel(scan)).toBe("Scan, scheduled");
  });
  it("uses singular and omits zero counts", () => {
    expect(runSummaryText({ ...scan, counts: { flights: 1, passed: 0 } })).toBe("1 fare, 0 passed");
  });
  it("summarises a discovery", () => {
    const d: RunSummary = { id: "d", kind: "discovery", mode: "discovery", at: "x", origin: null, counts: { candidates: 5, passed: 3, unresolved: 1 } };
    expect(runSummaryText(d)).toBe("5 candidates, 3 added, 1 not found");
    expect(runTopText(d)).toBeNull();
  });
  it("summarises fire runs", () => {
    const ok: RunSummary = { id: "f", kind: "fire", mode: "research", at: "x", origin: null, counts: {}, status: "fired" };
    expect(runSummaryText(ok)).toMatch(/^Started/);
    expect(runKindLabel(ok)).toBe("Run requested, research");
    expect(runSummaryText({ ...ok, status: "failed", detail: "The routine trigger answered 401." })).toBe("Not started. The routine trigger answered 401.");
  });
});

describe("small wording", () => {
  it("describes the fare against the median", () => {
    expect(vsMedianText(-18.4)).toBe("18% under the median");
    expect(vsMedianText(7)).toBe("7% over the median");
    expect(vsMedianText(0.2)).toBe("at the median");
    expect(vsMedianText(null)).toBe("no baseline yet");
  });
  it("words watch budgets", () => {
    expect(watchBudgetText(undefined)).toBe("Any fare");
    expect(watchBudgetText({ max: 300 })).toBe("Up to 300 EUR");
    expect(watchBudgetText({ min: 100 })).toBe("From 100 EUR");
    expect(watchBudgetText({ min: 100, max: 300 })).toBe("100 to 300 EUR");
  });
  it("parses euro amounts", () => {
    expect(parseEuro("")).toBeUndefined();
    expect(parseEuro(" 250 ")).toBe(250);
    expect(parseEuro("abc")).toBeNaN();
    expect(parseEuro("-5")).toBeNaN();
  });
  it("words the plan request", () => {
    expect(planThisText({ name: "Lisbon", from: "2026-12-01", to: "2026-12-20" })).toBe("Plan a trip to Lisbon between 2026-12-01 and 2026-12-20");
  });
  it("shows trip dates from the first stop", () => {
    expect(tripDatesText({ nodes: [{ arrive: "2026-12-01", depart: "2026-12-08" }] as never })).toBe("1 Dec to 8 Dec 2026");
    expect(tripDatesText({ nodes: [{}] as never })).toBe("Dates not set");
  });
});

describe("parseList", () => {
  it("trims, drops empties and repeats", () => {
    expect(parseList(" surf, hiking ,, Surf ,diving ")).toEqual(["surf", "hiking", "diving"]);
    expect(parseList("")).toEqual([]);
  });
});

describe("buildConfigPatch", () => {
  it("sends nothing when nothing changed", () => {
    const { patch, errors } = buildConfigPatch(config, configToForm(config));
    expect(patch).toEqual({});
    expect(errors).toEqual({});
  });

  it("sends only the changed fields, nested", () => {
    const form = { ...configToForm(config), maxStops: "0", budgetMax: "750", aMax: "28", intentTags: "surf, hiking, diving", activityBudget: "100" };
    const { patch, errors } = buildConfigPatch(config, form);
    expect(errors).toEqual({});
    expect(patch).toEqual({
      profile: { intentTags: ["surf", "hiking", "diving"] },
      hardFilters: { budgetEconomyEur: { max: 750 }, maxStops: 0 },
      windows: { a: { maxDays: 28 } },
      tripPreferences: { activities: { budgetPerDayEur: 100 } },
    });
  });

  it("ignores a list that only changed in spacing", () => {
    const { patch } = buildConfigPatch(config, { ...configToForm(config), intentTags: "surf,hiking", fallbackOrigins: "lpa , mad" });
    expect(patch).toEqual({});
  });

  it("uppercases and checks airport codes", () => {
    expect(buildConfigPatch(config, { ...configToForm(config), fallbackOrigins: "lis, opo" }).patch.hardFilters?.fallbackOrigins).toEqual(["LIS", "OPO"]);
    expect(buildConfigPatch(config, { ...configToForm(config), fallbackOrigins: "Lisbon" }).errors.fallbackOrigins).toMatch(/3-letter/);
    expect(buildConfigPatch(config, { ...configToForm(config), fallbackOrigins: "" }).errors.fallbackOrigins).toMatch(/at least one/);
  });

  it("reports bad numbers and ranges per field", () => {
    expect(buildConfigPatch(config, { ...configToForm(config), maxStops: "1.5" }).errors.maxStops).toMatch(/whole/);
    expect(buildConfigPatch(config, { ...configToForm(config), maxTravelTimeHours: "" }).errors.maxTravelTimeHours).toMatch(/number/);
    expect(configToForm(config).maxLayoverWaitHours).toBe("6");
    expect(buildConfigPatch(config, { ...configToForm(config), maxLayoverWaitHours: "4" }).patch).toEqual({ hardFilters: { maxLayoverWaitHours: 4 } });
    expect(buildConfigPatch(config, { ...configToForm(config), maxLayoverWaitHours: "-1" }).errors.maxLayoverWaitHours).toBeTruthy();
    expect(buildConfigPatch(config, { ...configToForm(config), budgetMin: "900" }).errors.budgetMax).toMatch(/below the minimum/);
    expect(buildConfigPatch(config, { ...configToForm(config), bMin: "200" }).errors.bMax).toMatch(/before the earliest/);
    expect(buildConfigPatch(config, { ...configToForm(config), persona: " " }).errors.persona).toBeTruthy();
  });
});

describe("issuesToErrors", () => {
  it("maps known paths to fields and keeps the rest as general lines", () => {
    const { fields, general } = issuesToErrors([
      { path: ["hardFilters", "maxStops"], message: "Too big" },
      { path: ["windows", "a"], message: "minDays exceeds maxDays" },
      { path: ["scoringWeights", "weather"], message: "Odd" },
    ]);
    expect(fields).toEqual({ maxStops: "Too big", aMax: "minDays exceeds maxDays" });
    expect(general).toEqual(["scoringWeights.weather: Odd"]);
  });
  it("tolerates a missing list", () => {
    expect(issuesToErrors(undefined)).toEqual({ fields: {}, general: [] });
  });
});
