import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ZodError } from "zod";
import type { Journey } from "../../src/types";
import { loadCities } from "./cities";
import { setFxFetch, FxUnavailableError, type FxFetch } from "./fx";
import {
  listJourneys,
  getJourney,
  createJourney,
  updateJourney,
  deleteJourney,
  getSettings,
  saveSettings,
  onJourneySaved,
  JournalValidationError,
} from "./journal";
import type { JourneyInputRaw } from "./journalSchemas";

let TMP: string;

const LISBON_TRIP: JourneyInputRaw = {
  title: "Lisbon & Porto",
  startDate: "2024-05-02",
  endDate: "2024-05-09",
  stops: [
    { cityId: "lisbon-portugal", arrive: "2024-05-02", depart: "2024-05-06", lodging: { name: "Alfama flat", kind: "apartment", cost: { amount: 400, currency: "EUR" } } },
    { cityId: "porto-portugal", arrive: "2024-05-06", depart: "2024-05-09" },
  ],
  segments: [
    { mode: "flight", fromCityId: "london-united-kingdom", toCityId: "lisbon-portugal", departAt: "2024-05-02T09:40", carrier: "TAP", number: "TP1351", cost: { amount: 120, currency: "GBP" } },
    { mode: "flight", fromCityId: "porto-portugal", toCityId: "london-united-kingdom", departAt: "2024-05-09", cost: { amount: 95, currency: "EUR" } },
  ],
  experiences: [],
  tags: ["city", "food"],
  bookingIds: [],
  provenance: { source: "manual", confidence: "high" },
};

const gbpFetch = vi.fn<FxFetch>(async () => ({ ok: true, status: 200, json: async () => ({ date: "2024-05-02", rates: { EUR: 1.17 } }) }));

beforeAll(() => loadCities());

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-journal-"));
  process.env.DATA_DIR = TMP;
  setFxFetch(gbpFetch);
});

afterEach(() => {
  setFxFetch();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("journal CRUD", () => {
  it("create assigns id/timestamps, defaults manual to confirmed, normalizes Money", async () => {
    const j = await createJourney(LISBON_TRIP);
    expect(j.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(j.createdAt).toBe(j.updatedAt);
    expect(j.status).toBe("confirmed");
    expect(j.stops[0].lodging?.cost).toEqual({ amount: 400, currency: "EUR", eur: 400, rateDate: "2024-05-02" });
    expect(j.segments[0].cost).toEqual({ amount: 120, currency: "GBP", eur: 140.4, rateDate: "2024-05-02" });
    expect(j.segments[1].cost?.eur).toBe(95);
    expect(j.stops[0].lodging?.provenance).toEqual({ source: "manual", confidence: "high" });

    const file = JSON.parse(readFileSync(join(TMP, "journal.json"), "utf-8"));
    expect(file.version).toBe(1);
    expect(file.journeys).toHaveLength(1);
  });

  it("non-manual provenance defaults to draft", async () => {
    const j = await createJourney({ ...LISBON_TRIP, provenance: { source: "gmail", sourceRef: "m1", confidence: "medium" } });
    expect(j.status).toBe("draft");
  });

  it("2 stops + 2 flights: create → edit → delete", async () => {
    const j = await createJourney(LISBON_TRIP);
    expect(j.stops).toHaveLength(2);
    expect(j.segments).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 5));
    const edited = await updateJourney(j.id, { ...LISBON_TRIP, title: "Portugal, May", rating: 5 });
    expect(edited?.id).toBe(j.id);
    expect(edited?.title).toBe("Portugal, May");
    expect(edited?.rating).toBe(5);
    expect(edited?.createdAt).toBe(j.createdAt);
    expect(edited!.updatedAt > j.updatedAt).toBe(true);
    expect((await getJourney(j.id))?.title).toBe("Portugal, May");

    expect(await deleteJourney(j.id)).toBe(true);
    expect(await getJourney(j.id)).toBeUndefined();
    expect(await deleteJourney(j.id)).toBe(false);
    expect(await listJourneys()).toEqual([]);
  });

  it("update of an unknown id returns undefined", async () => {
    expect(await updateJourney("nope", LISBON_TRIP)).toBeUndefined();
  });

  it("persists across a restart (fresh module instance re-reads the file)", async () => {
    const j = await createJourney(LISBON_TRIP);
    vi.resetModules();
    const fresh = await import("./journal");
    expect((await fresh.getJourney(j.id))?.title).toBe("Lisbon & Porto");
    expect(await fresh.listJourneys()).toHaveLength(1);
  });

  it("concurrent creates are all kept", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => createJourney({ ...LISBON_TRIP, title: `T${i}` })));
    expect(await listJourneys()).toHaveLength(8);
  });

  it("list filters by year and tag, newest first", async () => {
    await createJourney(LISBON_TRIP);
    await createJourney({
      ...LISBON_TRIP,
      title: "Berlin NYE",
      startDate: "2022-12-30",
      endDate: "2023-01-02",
      stops: [{ cityId: "berlin-germany", arrive: "2022-12-30", depart: "2023-01-02" }],
      segments: [],
      tags: ["party"],
    });
    expect((await listJourneys()).map((j) => j.title)).toEqual(["Lisbon & Porto", "Berlin NYE"]);
    expect((await listJourneys({ year: 2023 })).map((j) => j.title)).toEqual(["Berlin NYE"]);
    expect((await listJourneys({ year: 2024, tag: "food" })).map((j) => j.title)).toEqual(["Lisbon & Porto"]);
    expect(await listJourneys({ tag: "nope" })).toEqual([]);
  });
});

describe("validation", () => {
  it("shape errors throw ZodError", async () => {
    await expect(createJourney({ ...LISBON_TRIP, stops: [] })).rejects.toBeInstanceOf(ZodError);
    await expect(createJourney({ ...LISBON_TRIP, startDate: "2024-02-30" })).rejects.toBeInstanceOf(ZodError);
  });

  it("semantic errors throw JournalValidationError with issue paths", async () => {
    const cases: [JourneyInputRaw, (string | number)[]][] = [
      [{ ...LISBON_TRIP, startDate: "2024-05-10" }, ["endDate"]],
      [{ ...LISBON_TRIP, stops: [{ cityId: "atlantis-nowhere", arrive: "2024-05-02", depart: "2024-05-09" }] }, ["stops", 0, "cityId"]],
      [{ ...LISBON_TRIP, stops: [{ cityId: "lisbon-portugal", arrive: "2024-05-01", depart: "2024-05-03" }] }, ["stops", 0]],
      [{ ...LISBON_TRIP, stops: [LISBON_TRIP.stops[1], LISBON_TRIP.stops[0]] }, ["stops", 1, "arrive"]],
      [{ ...LISBON_TRIP, segments: [{ ...LISBON_TRIP.segments![0], toCityId: "atlantis-nowhere" }] }, ["segments", 0, "toCityId"]],
    ];
    for (const [input, path] of cases) {
      const err = await createJourney(input).catch((e) => e);
      expect(err, JSON.stringify(path)).toBeInstanceOf(JournalValidationError);
      expect((err as JournalValidationError).issues.map((i) => i.path)).toContainEqual(path);
    }
  });

  it("arriveAt compares instants when both sides carry an offset (eastbound date-line flight)", async () => {
    const seg = (departAt: string, arriveAt: string): JourneyInputRaw => ({ ...LISBON_TRIP, segments: [{ ...LISBON_TRIP.segments![0]!, departAt, arriveAt }] });
    // Auckland 09:45 +12 → Rarotonga 15:30 −10 the previous local day: ~6h later in real time.
    const ok = await createJourney(seg("2024-05-03T09:45+12:00", "2024-05-02T15:30-10:00"));
    expect(ok.segments[0]!.arriveAt).toBe("2024-05-02T15:30-10:00");
    await expect(createJourney(seg("2024-05-02T10:00+0000", "2024-05-02T09:00Z"))).rejects.toBeInstanceOf(JournalValidationError);
    // Without offsets only the local dates are comparable.
    await expect(createJourney(seg("2024-05-03T09:45", "2024-05-02T15:30"))).rejects.toBeInstanceOf(JournalValidationError);
    expect((await createJourney(seg("2024-05-02T10:00", "2024-05-02T09:00"))).segments[0]!.arriveAt).toBe("2024-05-02T09:00");
  });

  it("FX unavailable → FxUnavailableError and nothing stored", async () => {
    setFxFetch(async () => { throw new Error("offline"); });
    await expect(createJourney(LISBON_TRIP)).rejects.toBeInstanceOf(FxUnavailableError);
    expect(await listJourneys()).toEqual([]);
  });
});

describe("onJourneySaved", () => {
  it("listeners can set the fingerprint; update keeps it unless a listener replaces it", async () => {
    const fp = { month: 5, weekOfYear: 18, durationNights: 7, tags: [], status: {} as never, computedAt: "x", inputsHash: "h1" };
    const seen: (Journey | undefined)[] = [];
    const off = onJourneySaved((j, prev) => {
      seen.push(prev);
      if (!prev) j.fingerprint = fp;
    });
    try {
      const j = await createJourney(LISBON_TRIP);
      expect(j.fingerprint?.inputsHash).toBe("h1");
      const u = await updateJourney(j.id, { ...LISBON_TRIP, title: "x" });
      expect(u?.fingerprint?.inputsHash).toBe("h1");
      expect(seen[1]?.id).toBe(j.id);
    } finally {
      off();
    }
  });

  it("a throwing listener does not fail the save", async () => {
    const off = onJourneySaved(() => { throw new Error("weather quota"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const j = await createJourney(LISBON_TRIP);
      expect(await getJourney(j.id)).toBeTruthy();
    } finally {
      off();
      spy.mockRestore();
    }
  });
});

describe("settings", () => {
  it("round-trips homeCityId and validates it", async () => {
    expect(await getSettings()).toEqual({});
    await saveSettings({ homeCityId: "london-united-kingdom" });
    expect(await getSettings()).toEqual({ homeCityId: "london-united-kingdom" });
    await expect(saveSettings({ homeCityId: "atlantis-nowhere" })).rejects.toBeInstanceOf(JournalValidationError);
  });
});
