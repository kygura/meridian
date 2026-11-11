import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCities } from "../cities";
import { putSolverSettings } from "../solverStore";
import { putSettings } from "../rotation";
import { createSolverTools } from "./solver-tools";
import { DEFAULT_SOLVER_SETTINGS } from "../../../src/lib/solver/settings";

beforeAll(() => loadCities());

describe("solve_rotation agent tool", () => {
  let TMP: string;
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "meridian-solver-tool-"));
    process.env.DATA_DIR = TMP;
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it("is owner-only", async () => {
    const r = await createSolverTools({ unlocked: false }).solveRotation({});
    expect(r).toMatchObject({ error: "owner_only" });
  });

  it("says when the pool is empty", async () => {
    const r = await createSolverTools({ unlocked: true }).solveRotation({});
    expect(r).toMatchObject({ error: "empty_pool" });
  });

  it("runs the solver and explains each option, changing nothing", async () => {
    await putSettings({ name: "Mine", horizonMonths: 12, home: { cityId: "las-palmas-spain", name: "Las Palmas", country: "Spain", lat: 28.1, lng: -15.43, iata: "LPA" } }, undefined);
    await putSolverSettings({
      ...DEFAULT_SOLVER_SETTINGS,
      pool: [
        { cityId: "tbilisi-georgia", kind: "base" },
        { cityId: "chiang-mai-thailand", kind: "base" },
        { cityId: "mexico-city-mexico", kind: "base" },
      ],
    } as never);
    const r = (await createSolverTools({ unlocked: true }).solveRotation({ addCityIds: ["lisbon-portugal"], results: 2, start: "2027-01-01" })) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    const proposals = r.proposals as { option: number; components: { name: string; why: string }[]; stays: { place: string; alternatives: unknown[] }[] }[];
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals[0].components.map((c) => c.name)).toContain("Visa margin");
    expect(proposals[0].components.every((c) => c.why.length > 0)).toBe(true);
    expect(String(r.howToAccept)).toMatch(/Nothing has changed/);
  });
});
