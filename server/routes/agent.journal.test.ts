import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCities, getCityById } from "../lib/cities";
import { createJourney } from "../lib/journal";
import { registerJournalFingerprint, setFingerprintDepsFactory, whenFingerprintsSettled } from "../lib/journalFingerprint";
import { setReplayDepsFactory } from "../lib/replayService";
import { buildHolidayIndex } from "../lib/crowd";
import { fixtureFingerprintDeps, SEASONALITY, HOLIDAYS_2024, NOW } from "../lib/__fixtures__/journal";
import { createJournalTools, draftJourneyParams, findSimilarWindowsParams, parseJournalIntent, searchJournalParams } from "../lib/agent/journal-tools";
import { getQueue } from "../lib/imports";
import type { PlaceResult } from "../../src/types";
import agent from "./agent";

const TOKEN = "test-token";
const EXAMPLE = "somewhere like Lisbon last May but warmer and cheaper, in spring";
let TMP: string;
let unregister: () => void;
const savedKey = process.env.OPENAI_API_KEY;

interface Part {
  code: string;
  value: any;
}
const parse = (body: string): Part[] =>
  body
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ code: l.slice(0, l.indexOf(":")), value: JSON.parse(l.slice(l.indexOf(":") + 1)) }));

function chat(text: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return agent.request("/chat", { method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: text }] }) });
}

const LISBON = {
  title: "Lisbon, May 2024",
  startDate: "2024-05-10",
  endDate: "2024-05-17",
  companions: 2,
  rating: 5 as const,
  tags: ["city"],
  stops: [{ cityId: "lisbon-portugal", arrive: "2024-05-10", depart: "2024-05-17", rating: 5 as const, lodging: { name: "Alfama flat", provenance: { source: "manual" as const, confidence: "high" as const }, cost: { amount: 700, currency: "EUR" } } }],
  segments: [],
  experiences: [],
  bookingIds: [],
  provenance: { source: "manual" as const, confidence: "high" as const },
};

beforeAll(() => {
  loadCities();
  unregister = registerJournalFingerprint();
});
afterAll(() => {
  unregister();
  setFingerprintDepsFactory();
});
beforeEach(async () => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-agent-journal-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
  delete process.env.OPENAI_API_KEY;
  setFingerprintDepsFactory(() => ({ ...fixtureFingerprintDeps().deps, getCity: getCityById }));
  setReplayDepsFactory((p) => ({
    journeys: p.journeys,
    settings: { homeCityId: "berlin-germany" },
    seasonality: SEASONALITY,
    getCity: getCityById,
    flightEstimate: async () => ({ priceAmount: 100, currency: "EUR", source: "mock" }),
    eurOf: (a) => a,
    now: () => NOW,
    events: p.events,
    holidayIndex: buildHolidayIndex({ 2024: HOLIDAYS_2024 }),
  }));
});
afterEach(() => {
  setReplayDepsFactory();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.MERIDIAN_TOKEN;
  if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
});

async function seedLisbon() {
  const j = await createJourney(LISBON);
  await whenFingerprintsSettled();
  return j;
}

describe("mock path: the §9 example", () => {
  it("search_journal → find_similar_windows, surfaced as Open Places with replayMatch", async () => {
    const lisbon = await seedLisbon();
    const res = await chat(EXAMPLE, TOKEN);
    expect(res.status).toBe(200);
    const parts = parse(await res.text());
    const calls = parts.filter((p) => p.code === "9");
    const results = parts.filter((p) => p.code === "a");
    expect(calls.map((c) => c.value.toolName)).toEqual(["search_journal", "find_similar_windows"]);
    expect(results).toHaveLength(2);

    expect(calls[0]!.value.args).toEqual({ text: "Lisbon", month: 5 });
    expect(searchJournalParams.safeParse(calls[0]!.value.args).success).toBe(true);
    expect(results[0]!.value.result.journeys[0]).toMatchObject({ id: lisbon.id, title: "Lisbon, May 2024" });

    const sim = calls[1]!.value.args;
    expect(sim).toMatchObject({ journeyId: lisbon.id, bend: { tempC: 3, spendPct: -25 }, months: [3, 4, 5] });
    expect(findSimilarWindowsParams.safeParse(sim).success).toBe(true);

    const out = results[1]!.value.result;
    expect(out.places.length).toBeGreaterThan(0);
    for (const p of out.places as PlaceResult[]) {
      expect([3, 4, 5]).toContain(p.replayMatch!.month);
      expect(p.replayMatch!.dims.length).toBeGreaterThan(0);
      expect(p.replayMatch!.scoredOn.length).toBeGreaterThan(0);
      expect(p).toMatchObject({ cityId: expect.any(String), name: expect.any(String), lat: expect.any(Number), score: expect.any(Number), summaryLine: expect.stringContaining("% match") });
    }
    // The template city has no price; the mock price is flagged in the summary line.
    expect(parts.some((p) => p.code === "0")).toBe(true);
    expect(parts.filter((p) => p.code === "0").map((p) => p.value).join("")).toContain("Lisbon, May 2024");
  });

  it("says so when no journey matches", async () => {
    const parts = parse(await (await chat(EXAMPLE, TOKEN)).text());
    expect(parts.filter((p) => p.code === "9").map((c) => c.value.toolName)).toEqual(["search_journal"]);
    expect(parts.filter((p) => p.code === "0").map((p) => p.value).join("")).toMatch(/couldn't find a journey/);
  });

  it.each([["no token", undefined], ["wrong token", "nope"]])("journal_locked with %s, and the reply explains how to unlock", async (_n, token) => {
    await seedLisbon();
    const parts = parse(await (await chat(EXAMPLE, token)).text());
    const calls = parts.filter((p) => p.code === "9");
    expect(calls.map((c) => c.value.toolName)).toEqual(["search_journal"]);
    expect(parts.find((p) => p.code === "a")!.value.result).toMatchObject({ error: "journal_locked" });
    const text = parts.filter((p) => p.code === "0").map((p) => p.value).join("");
    expect(text).toMatch(/locked/i);
    expect(text).not.toContain("Lisbon, May 2024");
  });

  it.each(["I would like to see images of Tokyo", "Find somewhere like Barcelona but cheaper"])("ordinary chat %j keeps the original mock tool flow", async (msg) => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")); // original flow fetches images
    const parts = parse(await (await chat(msg, undefined)).text());
    spy.mockRestore();
    const names = parts.filter((p) => p.code === "9").map((c) => c.value.toolName);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("search_places");
    expect(names.every((n) => !["search_journal", "find_similar_windows"].includes(n))).toBe(true);
  });

  it("locked when MERIDIAN_TOKEN is unset even if a Bearer is sent", async () => {
    delete process.env.MERIDIAN_TOKEN;
    const parts = parse(await (await chat(EXAMPLE, TOKEN)).text());
    expect(parts.find((p) => p.code === "a")!.value.result).toMatchObject({ error: "journal_locked" });
  });
});

describe("parseJournalIntent", () => {
  it("extracts city, past month, bends and target season", () => {
    expect(parseJournalIntent(EXAMPLE, "Lisbon")).toEqual({ cityName: "Lisbon", pastMonth: 5, bend: { tempC: 3, spendPct: -25 }, months: [3, 4, 5] });
    expect(parseJournalIntent("quieter and cooler than Rome last June, in autumn", "Rome")).toBeUndefined(); // no "like"
    // Ordinary chat must not be hijacked: "like" alone, or a bare "may", is not a reference to the journal.
    expect(parseJournalIntent("I would like to see images of Tokyo", "Tokyo")).toBeUndefined();
    expect(parseJournalIntent("I'd like a cheap trip to Lisbon", "Lisbon")).toBeUndefined();
    expect(parseJournalIntent("Find somewhere like Barcelona but cheaper", "Barcelona")).toBeUndefined();
    expect(parseJournalIntent("Is Barcelona like Madrid in May?", "Barcelona")).toBeUndefined();
    // The verb "may" is not May; "last May" is.
    expect(parseJournalIntent("somewhere like Lisbon when I went, you may suggest cheaper", "Lisbon")?.pastMonth).toBeUndefined();
    expect(parseJournalIntent("somewhere like Lisbon last May", "Lisbon")?.pastMonth).toBe(5);
    expect(parseJournalIntent("Where is cheap in Asia?", undefined)).toBeUndefined();
  });
});

describe("journal tools", () => {
  it("every tool is locked without the token", async () => {
    const t = createJournalTools({ unlocked: false });
    const locked = { error: "journal_locked" };
    expect(await t.searchJournal({})).toMatchObject(locked);
    expect(await t.getFingerprint({ journeyId: "x" })).toMatchObject(locked);
    expect(await t.findSimilarWindows({ journeyId: "x" })).toMatchObject(locked);
    expect(await t.draftJourney({ title: "t", stops: [{ cityHint: "Lisbon", arrive: "2027-05-01", depart: "2027-05-03" }] })).toMatchObject(locked);
    expect((await getQueue()).candidates).toHaveLength(0);
  });

  it("search_journal filters and never throws on bad params", async () => {
    await seedLisbon();
    const t = createJournalTools({ unlocked: true });
    const ids = async (p: object) => ((await t.searchJournal(p as never)) as { journeys: { id: string }[] }).journeys.length;
    expect(await ids({})).toBe(1);
    expect(await ids({ country: "portugal", year: 2024, month: 5, minRating: 5, tags: ["City"] })).toBe(1);
    expect(await ids({ month: 6 })).toBe(0);
    expect(await ids({ cityId: "madrid-spain" })).toBe(0);
    expect(await ids({ minRating: 5, text: "alfama" })).toBe(0); // notes/title/tags/city only
    expect(await t.searchJournal({ month: 13 } as never)).toMatchObject({ error: "invalid_params" });
  });

  it("get_fingerprint returns journey and stop fingerprints; unknown ids are errors", async () => {
    const j = await seedLisbon();
    const t = createJournalTools({ unlocked: true });
    expect(await t.getFingerprint({ journeyId: j.id })).toMatchObject({ fingerprint: { month: 5, tempC: 19.2 } });
    expect(await t.getFingerprint({ journeyId: j.id, stopIndex: 0 })).toMatchObject({ cityId: "lisbon-portugal", fingerprint: { month: 5 } });
    expect(await t.getFingerprint({ journeyId: j.id, stopIndex: 4 })).toEqual({ error: "stop_not_found" });
    expect(await t.getFingerprint({ journeyId: "nope" })).toEqual({ error: "journey_not_found" });
  });

  it("find_similar_windows returns errors, not throws", async () => {
    const t = createJournalTools({ unlocked: true });
    expect(await t.findSimilarWindows({})).toMatchObject({ error: "invalid_params" });
    expect(await t.findSimilarWindows({ journeyId: "nope" })).toEqual({ error: "template_not_found" });
    expect(await t.findSimilarWindows({ journeyId: "x", bend: { tempC: 99 } })).toMatchObject({ error: "invalid_params" });
  });

  it("draft_journey only creates pending manual candidates (deduped), never a journey", async () => {
    const t = createJournalTools({ unlocked: true });
    const args = {
      title: "Porto trip",
      stops: [{ cityHint: "Porto", arrive: "2027-05-01", depart: "2027-05-04" }, { cityId: "lisbon-portugal", arrive: "2027-05-04", depart: "2027-05-06" }],
      segments: [{ mode: "train" as const, fromCityHint: "Porto", toCityId: "lisbon-portugal", departAt: "2027-05-04" }],
    };
    expect(draftJourneyParams.safeParse(args).success).toBe(true);
    const r = await t.draftJourney(args);
    expect(r).toMatchObject({ drafted: 3, duplicates: 0 });
    const q = await getQueue();
    expect(q.candidates).toHaveLength(3);
    for (const c of q.candidates) {
      expect(c.state).toBe("pending");
      expect(c.provenance.source).toBe("manual");
      expect(c.provenance.sourceRef).toMatch(/^agent:[0-9a-f]{16}$/);
    }
    expect(await t.draftJourney(args)).toMatchObject({ drafted: 0, duplicates: 3 });
    expect(await t.draftJourney({ title: "x", stops: [{ cityId: "atlantis", arrive: "2027-05-01", depart: "2027-05-02" }] })).toEqual({ error: "unknown_city", cityId: "atlantis" });
    expect(await t.draftJourney({ title: "x", stops: [] } as never)).toMatchObject({ error: "invalid_params" });
  });
});
