import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCities } from "./cities";
import { putStay, readRotation } from "./rotation";
import { acceptPlan, prepareSolve, priorPresence, uncovered } from "./solverService";
import { DEFAULT_SOLVER_SETTINGS } from "../../src/lib/solver/settings";

const journeys = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("./journal", async (orig) => ({ ...(await orig<typeof import("./journal")>()), listJourneys: async () => journeys.list }));

beforeAll(() => loadCities());

const place = (cityId: string, name: string, country: string, lat: number, lng: number, iata: string) => ({ cityId, name, country, lat, lng, iata });
const LIS = place("lisbon-portugal", "Lisbon", "Portugal", 38.72, -9.14, "LIS");
const OPO = place("porto-portugal", "Porto", "Portugal", 41.15, -8.61, "OPO");

describe("solver service", () => {
  let TMP: string;
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "meridian-solver-service-"));
    process.env.DATA_DIR = TMP;
    journeys.list = [];
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it("uncovered keeps the nights no other range holds", () => {
    expect(uncovered("2027-01-31", "2027-03-15", [{ start: "2027-01-01", end: "2027-02-01" }])).toEqual([{ start: "2027-02-01", end: "2027-03-15" }]);
    expect(uncovered("2027-01-01", "2027-01-31", [{ start: "2027-01-10", end: "2027-01-20" }])).toEqual([
      { start: "2027-01-01", end: "2027-01-10" },
      { start: "2027-01-20", end: "2027-01-31" },
    ]);
    expect(uncovered("2027-01-10", "2027-01-20", [{ start: "2027-01-01", end: "2027-02-01" }])).toEqual([]);
  });

  it("keeps a journal stop's nights that the rotation does not cover", async () => {
    await putStay("lis", { place: LIS, kind: "base", status: "booked", start: "2027-01-01", end: "2027-02-01" } as never, undefined);
    journeys.list = [
      {
        id: "j1",
        stops: [
          { cityId: "paris-france", arrive: "2027-01-31", depart: "2027-03-15" },
          // Overlaps the Paris stop by a few nights; only its own nights are added.
          { cityId: "paris-france", arrive: "2027-03-10", depart: "2027-03-20" },
        ],
      },
    ];
    const stays = (await readRotation()).stays;
    const prior = await priorPresence(stays, "2027-04-01");
    const france = prior.filter((p) => p.country === "France").map((p) => [p.start, p.end]);
    expect(france).toEqual([
      ["2027-02-01", "2027-03-15"],
      ["2027-03-15", "2027-03-20"],
    ]);
  });

  it("refuses to solve around a fixed stay whose place it has no data for", async () => {
    await putStay("gone", { place: place("renamed-place-xx", "Old Town", "Portugal", 38.7, -9.1, "LIS"), kind: "base", status: "booked", start: "2027-03-01", end: "2027-04-01" } as never, undefined);
    const r = await prepareSolve({ settings: { ...DEFAULT_SOLVER_SETTINGS, months: 12, pool: [{ cityId: "lisbon-portugal", kind: "base" }] } as never, start: "2027-01-01", fromCityId: "lisbon-portugal" }, "2027-01-01");
    expect("error" in r && r.error).toMatch(/no data for Old Town \(2027-03-01 to 2027-04-01\)/);
  });

  it("will not write a plan over a stay that was booked after the plan was made", async () => {
    // When the plan was made, Porto was planned for March, so the plan put Valencia there.
    await putStay("opo", { place: OPO, kind: "base", status: "booked", start: "2027-03-01", end: "2027-03-31" } as never, undefined);
    const before = (await readRotation()).stays.map((s) => s.id);
    const plan = {
      stays: [
        { id: "a", cityId: "lisbon-portugal", start: "2027-01-01", end: "2027-03-01", kind: "base" as const, role: "base" as const },
        { id: "b", cityId: "valencia-spain", start: "2027-03-01", end: "2027-03-31", kind: "base" as const, role: "base" as const },
      ],
    };
    const r = await acceptPlan(plan, "run1", new Date("2026-12-01T10:00:00Z"));
    expect("error" in r && r.error).toBe("conflict");
    expect("error" in r && r.message).toMatch(/Porto/);
    // Nothing was written.
    expect((await readRotation()).stays.map((s) => s.id)).toEqual(before);
  });

  it("will not write a plan next to a fixed stay that has since grown", async () => {
    // The plan kept Porto fixed to 1 Mar; it has since been extended to 15 Mar.
    await putStay("opo", { place: OPO, kind: "base", status: "booked", start: "2027-01-01", end: "2027-03-15" } as never, undefined);
    const plan = {
      stays: [
        { id: "opo", cityId: "porto-portugal", start: "2027-01-01", end: "2027-03-01", kind: "base" as const, role: "fixed" as const },
        { id: "b", cityId: "valencia-spain", start: "2027-03-01", end: "2027-03-31", kind: "base" as const, role: "base" as const },
      ],
    };
    const r = await acceptPlan(plan, "run2", new Date("2026-12-01T10:00:00Z"));
    expect("error" in r && r.error).toBe("conflict");
    expect((await readRotation()).stays.map((s) => s.id)).toEqual(["opo"]);
  });
});
