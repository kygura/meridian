import { expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertScanRecords, convertWishlist, loadLegacyDir, monthsFromPeriods } from "./legacy";

const here = dirname(fileURLToPath(import.meta.url));
const legacyDir = join(here, "fixtures", "legacy");

test("monthsFromPeriods maps names, numbers and ranges to month numbers", () => {
  expect(monthsFromPeriods(["Aug"])).toEqual([8]);
  expect(monthsFromPeriods(["Dec", "Jan", "Feb"])).toEqual([1, 2, 12]);
  expect(monthsFromPeriods(["September", 3, "13", "nope"])).toEqual([3, 9]);
  expect(monthsFromPeriods(["Nov-Jan"])).toEqual([1, 11, 12]);
  expect(monthsFromPeriods(undefined)).toEqual([]);
});

test("convertWishlist dedupes by IATA and maps user_requested to a watched wish", () => {
  const { entries, duplicates, skipped } = convertWishlist([
    { destination: "A", iata: "pix", status: "scouted", intent_tags: ["surf"], avoid_periods: ["Aug"], notes: "first" },
    { destination: "A again", iata: "PIX", status: "scouted", intent_tags: ["surf", "ocean"], avoid_periods: ["Dec"], notes: "second" },
    {
      destination: "Thailand",
      iata: "BKK",
      source: "user_requested",
      intent_tags: [],
      requested_by: 4242,
      target_budget_eur: 1200
    },
    { destination: "No code" }
  ]);
  expect(duplicates).toBe(1);
  expect(skipped).toBe(1);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toEqual({
    place: { iata: "PIX" },
    source: "scouted",
    intentTags: ["surf", "ocean"],
    avoidMonths: [8, 12],
    notes: "first"
  });
  expect(entries[1]?.source).toBe("wished");
  expect(entries[1]?.watch).toEqual({ active: true, targetBudgetEur: { max: 1200 }, chatId: "4242" });
});

test("convertScanRecords skips distorted, unpriced and repeated results", () => {
  const flight = (over: Record<string, unknown> = {}) => ({
    flight_id: "x",
    source: "kiwi",
    origin: "MAD",
    destination: "LIS",
    travel_window_start: "2026-05-25",
    travel_window_end: "2026-06-03",
    price_economy_eur: 100,
    snapshot_date: "2026-05-09",
    search_error: null,
    ...over
  });
  const record = {
    scan_date: "2026-05-09",
    results: [
      { flight: flight(), annotation: { distortion_flag: false } },
      { flight: flight(), annotation: { distortion_flag: false } },
      { flight: flight({ price_economy_eur: 90 }), annotation: { distortion_flag: true } },
      { flight: flight({ price_economy_eur: null }), annotation: { distortion_flag: false } },
      { flight: flight({ search_error: "timeout" }), annotation: { distortion_flag: false } },
      { flight: flight({ destination: "LIS", travel_window_start: "2026-06-10", snapshot_date: undefined }), annotation: {} }
    ]
  };
  const { fares, skipped } = convertScanRecords([record]);
  expect(skipped).toBe(4);
  expect(fares).toEqual([
    { origin: "MAD", destination: "LIS", priceEur: 100, departDate: "2026-05-25", returnDate: "2026-06-03", snapshotDate: "2026-05-09", source: "kiwi" },
    { origin: "MAD", destination: "LIS", priceEur: 100, departDate: "2026-06-10", returnDate: "2026-06-03", snapshotDate: "2026-05-09", source: "kiwi" }
  ]);
});

test("loadLegacyDir converts a legacy repository folder (fixtures/legacy)", () => {
  const { payload, summary } = loadLegacyDir(legacyDir);

  expect(Object.keys(payload.config ?? {}).sort()).toEqual(
    ["discoveryWeights", "hardFilters", "profile", "scoringWeights", "tripPreferences", "tripProfiles"].sort()
  );
  expect(payload.config?.hardFilters).toEqual({
    maxStops: 2,
    maxTravelTimeHours: 50,
    maxLayoverWaitHours: 6,
    budgetEconomyEur: { min: 10, max: 2500 },
    fallbackOrigins: ["AGP", "MAD", "LPA"],
    lastminuteWindowDays: 21
  });
  expect(payload.config?.scoringWeights).toEqual({
    priceVsBaseline: 0.3,
    weather: 0.25,
    crowd: 0.25,
    surf: 0.15,
    isolation: 0.05,
    opportunityThreshold: 7.5
  });
  expect(payload.config?.discoveryWeights?.tourismSeason).toBe(0.3);
  expect(payload.config?.discoveryWeights?.repeatWindowDays).toBe(45);
  expect(payload.config?.tripPreferences?.gates).toEqual({
    minCompositeScore: 3,
    minWeatherScore: 3,
    allowPeakCrowds: false,
    minIsolationScore: 2
  });
  expect(payload.config?.tripPreferences?.planning).toEqual({ maxFullPlans: 1, maxAlternatives: 1, tripBudgetEur: null });
  expect(payload.config?.tripPreferences?.activities?.budgetPerDayEur).toBe(60);
  expect(payload.config?.profile?.intentTags).toContain("surf");
  const surf = payload.config?.tripProfiles?.find((p) => p.id === "surf");
  expect(surf?.relevantMonths).toEqual([3, 4, 5, 9, 10, 11]);
  expect(surf?.maxResults).toBe(3);
  expect(surf).not.toHaveProperty("sample_origins");

  // Wishlist: five legacy entries, all scouted, months converted from names.
  expect(payload.wishlist).toHaveLength(5);
  expect(summary.wishlist.entries).toBe(5);
  const iatas = payload.wishlist?.map((e) => ("iata" in e.place ? e.place.iata : "")) ?? [];
  expect(new Set(iatas).size).toBe(iatas.length);
  const pix = payload.wishlist?.find((e) => "iata" in e.place && e.place.iata === "PIX");
  expect(pix?.source).toBe("scouted");
  expect(pix?.avoidMonths).toEqual([8]);
  expect(pix?.watch).toBeUndefined();
  const sal = payload.wishlist?.find((e) => "iata" in e.place && e.place.iata === "SAL");
  expect(sal?.avoidMonths).toEqual([1, 2, 12]);

  // Fares: priced, non-distorted results from the scan records, in the contract shape.
  expect(summary.fares.scanFiles).toBe(1);
  expect(payload.fares?.length).toBeGreaterThan(0);
  for (const f of payload.fares ?? []) {
    expect(f.origin).toMatch(/^[A-Z]{3}$/);
    expect(f.destination).toMatch(/^[A-Z]{3}$/);
    expect(f.priceEur).toBeGreaterThan(0);
    expect(f.departDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f).not.toHaveProperty("price_economy_eur");
  }
  const mentawai = payload.fares?.find((f) => f.destination === "PDG" && f.departDate === "2026-05-25");
  expect(mentawai).toMatchObject({ origin: "MAD", priceEur: 1237, returnDate: "2026-06-03", source: "kiwi" });
});

test("loadLegacyDir rejects a directory with no legacy data", () => {
  expect(() => loadLegacyDir(join(here, "nope"))).toThrow(/No legacy data/);
});
