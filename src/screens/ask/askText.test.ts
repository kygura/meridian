import { describe, expect, it } from "vitest";
import type { City, PlaceResult } from "../../types";
import {
  cityNameIndex,
  dimWord,
  draftOutcome,
  findCityMentions,
  humanize,
  journalLocked,
  matchCard,
  pendingActivities,
  proseBlocks,
  replayMatches,
  searchedPlaces,
  toolActivity,
} from "./askText";

const city = (id: string, name: string, population = 1000): City => ({ id, name, country: "X", lat: 0, lng: 0, population }) as City;
const index = cityNameIndex([
  city("lis", "Lisbon"),
  city("nice", "Nice"),
  city("rio", "Rio de Janeiro"),
  city("sj-cr", "San Jose", 300),
  city("sj-us", "San Jose", 900),
  city("jose", "Jose"),
  city("bar", "Bar"),
]);

describe("findCityMentions", () => {
  it("finds capitalised names in order, longest phrase first, bigger city on ties", () => {
    const hits = findCityMentions("Try Rio de Janeiro, then San Jose. Lisbon is great too; Lisbon again.", index);
    expect(hits.map((c) => c.id)).toEqual(["rio", "sj-us", "lis"]);
  });
  it("ignores lower-case words and short names", () => {
    expect(findCityMentions("nice weather at the bar", index)).toEqual([]);
    expect(findCityMentions("Nice in May.", index).map((c) => c.id)).toEqual(["nice"]);
  });
  it("respects the limit", () => {
    expect(findCityMentions("Lisbon Nice Jose", index, 2)).toHaveLength(2);
  });
});

describe("plain words", () => {
  it("never shows field names", () => {
    expect(dimWord("crowdProxy")).toBe("Crowds");
    expect(dimWord("tempC")).toBe("Temperature");
    expect(dimWord("flightCostEurPer1000km")).toBe("Flight cost");
    expect(dimWord("someNewDim")).toBe("Some new dim");
    expect(humanize("draft_journey")).toBe("Draft journey");
    expect(toolActivity("find_similar_windows")).toBe("Finding similar places");
    expect(toolActivity("unknown_tool")).toBe("Working");
  });
});

const place = (over: Partial<PlaceResult> = {}): PlaceResult => ({
  cityId: "opo",
  name: "Porto",
  country: "Portugal",
  lat: 0,
  lng: 0,
  population: 1,
  score: 80,
  summaryLine: "Oct · 81% match · flight ~€90 (mock estimate)",
  replayMatch: {
    match: 81.4,
    month: 10,
    dims: [
      { name: "crowdProxy", contribution: 0.2 },
      { name: "tempC", contribution: 0.4 },
      { name: "precipMm", contribution: 0.3 },
    ],
    scoredOn: ["tempC", "precipMm", "crowdProxy"],
  } as PlaceResult["replayMatch"],
  ...over,
});

describe("tool results", () => {
  const calls = [
    { toolName: "search_places", state: "result", result: [place({ cityId: "lis", name: "Lisbon", replayMatch: undefined })] },
    { toolName: "find_similar_windows", state: "result", result: { places: [place(), place({ cityId: "x", replayMatch: undefined })] } },
    { toolName: "search_journal", state: "result", result: { error: "journal_locked" } },
    { toolName: "draft_journey", state: "result", result: { drafted: 3, duplicates: 0 } },
    { toolName: "get_seasonality", state: "call" },
  ];
  it("pulls structured bits out of a message", () => {
    expect(searchedPlaces(calls).map((p) => p.cityId)).toEqual(["lis"]);
    expect(replayMatches(calls).map((p) => p.cityId)).toEqual(["opo"]);
    expect(journalLocked(calls)).toBe(true);
    expect(journalLocked(calls.slice(0, 2))).toBe(false);
    expect(draftOutcome(calls)).toEqual({ drafted: 3, pending: true });
    expect(pendingActivities(calls)).toEqual(["Checking the best months"]);
  });
  it("builds a compact match card in plain words", () => {
    expect(matchCard(place())).toEqual({ match: 81, month: "October", closest: "Closest on temperature and rainfall", mock: true });
    expect(matchCard(place({ replayMatch: undefined }))).toBeNull();
  });
});

describe("proseBlocks", () => {
  it("splits paragraphs and bullets and drops markdown emphasis", () => {
    const text = "Here are **three** picks:\n\n• Lisbon — mild\n- Porto: cheap\n\n## Note\nPrices are estimates.";
    expect(proseBlocks(text)).toEqual([
      { type: "p", text: "Here are three picks:" },
      { type: "ul", items: ["Lisbon — mild", "Porto: cheap"] },
      { type: "p", text: "Note" },
      { type: "p", text: "Prices are estimates." },
    ]);
  });
});
