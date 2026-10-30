import { describe, expect, it } from "vitest";
import {
  agoText,
  alertComparison,
  alertDeltaPct,
  alertTickerItem,
  alertWhere,
  candidateDay,
  candidateSummary,
  cityFixes,
  clusterChain,
  clusterDates,
  clusterMembers,
  flagTexts,
  formatDelta,
  inboxErrorText,
  isMockSource,
  kindLabel,
  looseCandidates,
  mergeTicker,
  queueMeta,
  replayPath,
  ruleText,
  searchJourneys,
  suggestedJourneys,
} from "./inbox";
import type { Alert, City, ImportCandidate, ImportCluster, Journey, TickerItem, Watch } from "../types";

const city = (id: string, iata: string): City => ({ id, name: id[0].toUpperCase() + id.slice(1), iata, country: "PT", lat: 0, lng: 0, population: 1 } as City);
const cities = new Map([city("lisbon", "LIS"), city("porto", "OPO")].map((c) => [c.id, c]));
const prov = { source: "jsonld", sourceRef: "m1", confidence: "high" } as const;
const cand = (over: Partial<ImportCandidate>): ImportCandidate => ({ id: "c1", kind: "segment", payload: {}, provenance: prov, state: "pending", createdAt: "2024-06-01T00:00:00Z", ...over });

describe("candidates", () => {
  it("summarises a flight, a stay, and unresolved hints", () => {
    const f = cand({ payload: { mode: "flight", carrier: "TAP Air Portugal", number: "TP1023", fromCityId: "lisbon", toCityId: "porto", departAt: "2024-05-14T08:00" } });
    expect(kindLabel(f)).toBe("FLIGHT");
    expect(candidateSummary(f, cities)).toBe("TP1023 LIS → OPO · 14 MAY");
    const train = cand({ payload: { mode: "train", carrier: "CP", number: "122", fromCityId: "lisbon", toCityId: "porto", departAt: "2024-05-06" } });
    expect(candidateSummary(train, cities)).toBe("CP 122 LIS → OPO · 6 MAY");
    const stay = cand({ kind: "lodging", payload: { name: "Hotel Baixa", cityId: "lisbon", arrive: "2024-05-14", depart: "2024-05-17" } });
    expect(kindLabel(stay)).toBe("STAY");
    expect(candidateSummary(stay, cities)).toBe("Hotel Baixa · LIS · 14 MAY – 17 MAY");
    const bad = cand({ flags: ["unresolved-city"], payload: { mode: "train", fromCityId: "lisbon", toCityHint: "Oporto Cty", departAt: "2024-05-15" } });
    expect(kindLabel(bad)).toBe("TRAIN");
    expect(candidateSummary(bad, cities)).toBe("LIS → Oporto Cty · 15 MAY");
    expect(cityFixes(bad)).toEqual([{ field: "toCityId", hint: "Oporto Cty" }]);
    expect(flagTexts(bad)).toEqual(['UNRESOLVED CITY "Oporto Cty"']);
    expect(cityFixes(cand({ kind: "stop", payload: { cityHint: "Faro", arrive: "2024-05-01" } }))).toEqual([{ field: "cityId", hint: "Faro" }]);
    expect(cityFixes(stay)).toEqual([]);
  });
  it("dates a candidate", () => {
    expect(candidateDay(cand({ payload: { departAt: "2024-05-14T08:00" } }))).toBe("2024-05-14");
    expect(candidateDay(cand({ kind: "stop", payload: { arrive: "2024-05-01" } }))).toBe("2024-05-01");
    expect(candidateDay(cand({ payload: {} }))).toBe("2024-06-01");
  });
});

describe("clusters", () => {
  const cl: ImportCluster = { id: "cl1", title: "Lisbon & Porto, May 2024", startDate: "2024-05-12", endDate: "2024-05-20", candidateIds: ["b", "a"], cityIds: ["lisbon", "porto"], lowConfidence: false };
  const a = cand({ id: "a" });
  const b = cand({ id: "b" });
  const z = cand({ id: "z" });
  it("orders members and finds loose candidates", () => {
    expect(clusterMembers(cl, [a, b, z]).map((c) => c.id)).toEqual(["b", "a"]);
    expect(looseCandidates([cl], [a, b, z]).map((c) => c.id)).toEqual(["z"]);
    expect(looseCandidates([cl], [cand({ id: "q", state: "discarded" })])).toEqual([]);
  });
  it("formats dates, chain and meta", () => {
    expect(clusterDates("2024-05-12", "2024-05-20")).toBe("12–20 MAY 2024");
    expect(clusterDates("2024-05-28", "2024-06-02")).toBe("28 MAY – 2 JUN 2024");
    expect(clusterDates("2023-12-31", "2024-01-03")).toBe("31 DEC 2023 – 3 JAN 2024");
    expect(clusterDates("2024-05-12", "2024-05-12")).toBe("12 MAY 2024");
    expect(clusterChain(cl, cities)).toBe("LIS → OPO");
    expect(queueMeta(37, 6)).toBe("37 ITEMS IN 6 SUGGESTED JOURNEYS");
    expect(queueMeta(1, 1)).toBe("1 ITEM IN 1 SUGGESTED JOURNEY");
    expect(queueMeta(2, 0)).toBe("2 ITEMS");
  });
});

describe("merge targets", () => {
  const j = (id: string, title: string, startDate: string, endDate: string, status: Journey["status"] = "confirmed", city = "lisbon"): Journey =>
    ({ id, title, startDate, endDate, status, stops: [{ cityId: city, arrive: startDate, depart: endDate }] }) as unknown as Journey;
  const cluster = { startDate: "2024-05-12", endDate: "2024-05-20" };
  const js = [j("near", "Spring", "2024-05-01", "2024-05-05"), j("far", "Winter", "2023-01-01", "2023-01-05"), j("draft", "Draft", "2024-05-10", "2024-05-11", "draft"), j("pick", "Picked", "2023-02-01", "2023-02-02", "confirmed", "porto")];
  it("suggests the server's pick first, then confirmed journeys within 14 days", () => {
    expect(suggestedJourneys(cluster, js).map((x) => x.id)).toEqual(["near"]);
    expect(suggestedJourneys(cluster, js, "pick").map((x) => x.id)).toEqual(["pick", "near"]);
  });
  it("searches by title or city", () => {
    expect(searchJourneys("win", js, cities).map((x) => x.id)).toEqual(["far"]);
    expect(searchJourneys("opo", js, cities).map((x) => x.id)).toEqual(["pick"]);
    expect(searchJourneys("  ", js, cities)).toEqual([]);
  });
});

describe("errors", () => {
  it("maps server codes to plain words", () => {
    expect(inboxErrorText({ code: "not_pending", status: 409 })).toMatch(/ALREADY REVIEWED/);
    expect(inboxErrorText({ code: "unresolved", status: 409 })).toMatch(/UNRESOLVED/);
    expect(inboxErrorText({ code: "journey_changed", status: 409 })).toMatch(/CHANGED/);
    expect(inboxErrorText({ status: 413 })).toMatch(/TOO LARGE/);
    expect(inboxErrorText({ code: "fx_unavailable", status: 422 })).toMatch(/EXCHANGE RATE/);
    expect(inboxErrorText({ name: "JournalNetworkError" })).toMatch(/REACH/);
    expect(inboxErrorText(undefined)).toMatch(/WRONG/);
  });
});

describe("alerts", () => {
  const alert = (over: Partial<Alert> = {}): Alert => ({ id: "a1", watchId: "w1", cityId: "porto", month: 6, priceEur: 184, baselineEur: 210, source: "mock", createdAt: "2026-10-28T10:00:00Z", seen: false, ...over });
  const watch = { id: "w1", label: "Like Lisbon May", query: { template: { journeyId: "j 1", stopIndex: 2 }, bend: {}, weights: { climate: 1, spend: 0, crowd: 0, flight: 0 } }, leadWeeks: [6, 14], priceRule: "below_my_median", active: true } as unknown as Watch;
  const now = new Date("2026-10-30T10:00:00Z");

  it("computes and formats the delta against the baseline", () => {
    expect(alertDeltaPct(alert())).toBe(-12);
    expect(alertDeltaPct(alert({ baselineEur: 0 }))).toBe(0);
    expect(formatDelta(-12)).toBe("−12 %");
    expect(formatDelta(3)).toBe("+3 %");
    expect(formatDelta(0)).toBe("0 %");
  });
  it("labels city, month, source and age", () => {
    expect(alertWhere(alert(), cities)).toBe("OPO · JUN");
    expect(isMockSource("mock")).toBe(true);
    expect(isMockSource("duffel")).toBe(false);
    expect(agoText("2026-10-28T10:00:00Z", now)).toBe("2 DAYS AGO");
    expect(agoText("2026-10-30T07:00:00Z", now)).toBe("3 H AGO");
    expect(agoText("2026-10-30T09:59:40Z", now)).toBe("JUST NOW");
    expect(agoText(undefined, now)).toBe("NEVER");
  });
  it("builds a good-glyph ticker item", () => {
    expect(alertTickerItem(alert(), watch, cities, now)).toEqual({
      glyph: "good",
      location: "OPO · JUN",
      text: "Watch “Like Lisbon May”: €184, 12 % under what you usually pay",
      time: "2d",
      alertId: "a1",
    });
  });
  it("never calls a fixed cap 'usual'", () => {
    const cap = { ...watch, priceRule: { maxEur: 100000 } } as Watch;
    const a = alert({ priceEur: 112, baselineEur: 100000 });
    expect(alertComparison(a, cap)).toEqual({ vs: "under your €100,000 cap", delta: null });
    expect(alertTickerItem(a, cap, cities, now).text).toBe("Watch “Like Lisbon May”: €112, under your €100,000 cap");
    expect(alertComparison(alert(), watch)).toEqual({ vs: "vs €210 usual", delta: "−12 %" });
    expect(alertComparison(alert({ baselineEur: 0 }), watch)).toBeNull();
    expect(alertTickerItem(alert({ baselineEur: 0 }), watch, cities, now).text).toBe("Watch “Like Lisbon May”: €184");
  });
  it("merges unseen alerts first, only when unlocked", () => {
    const news: TickerItem[] = [{ glyph: "info", location: "X", text: "n", time: "1h" }];
    const alerts = [alert({ id: "old", createdAt: "2026-10-01T00:00:00Z" }), alert({ id: "seen", seen: true }), alert({ id: "new" })];
    expect(mergeTicker(news, alerts, [watch], cities, false)).toBe(news);
    const merged = mergeTicker(news, alerts, [watch], cities, true, now);
    expect(merged.map((m) => ("alertId" in m ? m.alertId : "news"))).toEqual(["new", "old", "news"]);
    expect(merged[0].glyph).toBe("good");
  });
  it("describes rules and replay paths", () => {
    expect(ruleText("below_my_median")).toBe("BELOW WHAT I USUALLY PAY");
    expect(ruleText("deal_low")).toBe("PROVIDER SAYS LOW");
    expect(ruleText({ maxEur: 100000 })).toBe("UNDER €100,000");
    expect(replayPath(watch)).toBe("/journal/replay/j%201/2");
    expect(replayPath(undefined)).toBe("/journal/replay");
  });
});
