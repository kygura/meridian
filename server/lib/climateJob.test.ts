import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function daysOf(from: number, to: number) {
  const out: string[] = [];
  for (let y = from; y <= to; y++) for (let d = new Date(Date.UTC(y, 0, 1)); d.getUTCFullYear() === y; d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

const fetchFn = (async (url: string) => {
  if (url.includes("air-quality-api")) {
    const time = daysOf(2023, 2025).flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, "0")}:00`));
    return { ok: true, status: 200, json: async () => ({ hourly: { time, pm2_5: time.map(() => 33) } }) } as unknown as Response;
  }
  const time = daysOf(2015, 2024);
  return {
    ok: true,
    status: 200,
    json: async () => ({ daily: { time, temperature_2m_max: time.map(() => 24), temperature_2m_min: time.map(() => 16), precipitation_sum: time.map(() => 1) } }),
  } as unknown as Response;
}) as unknown as typeof fetch;

describe("nightly climate job", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-climate-job-"));
    process.env.DATA_DIR = dir;
  });
  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it("fills the next gaps within its budget and serves them through the seasonality readers", async () => {
    const job = await import("./climateJob");
    const seasonality = await import("./seasonality");
    const { cellKeyFor } = await import("./climateNormals");
    const { getCities } = await import("./cities");
    seasonality.resetSeasonalityCache();

    const res = await job.runClimateJobOnce({ maxCells: 2, fetchFn, delayMs: 0 });
    expect(res).toBeDefined();
    expect(res!.cellsCompleted).toBe(2);
    expect(res!.stoppedBy).toBe("max-cells");

    // Saved through the document store, so it survives a restart.
    const file = join(dir, "cache", "climate-runtime.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf-8")) as { cells: Record<string, { at?: string; aq?: string; w?: unknown }> };
    const keys = Object.keys(saved.cells);
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(saved.cells[k]!.aq).toBeDefined();
      expect(saved.cells[k]!.w).toBeDefined();
    }

    // A city in a freshly filled cell now has months with PM2.5 and 52 weeks.
    const city = getCities().find((c) => keys.includes(cellKeyFor(c.lat, c.lng)))!;
    const peek = seasonality.peekCitySeasonality(city.id);
    expect(peek.kind).toBe("hit");
    if (peek.kind === "hit") {
      expect(peek.months).toHaveLength(12);
      expect(peek.months[0]!.pm25).toBe(33);
    }
    expect(seasonality.getCityWeeks(city.id)).toHaveLength(52);

    // The ledger records what was spent, so the next run (or the script) sees it.
    const ledger = JSON.parse(readFileSync(join(dir, "cache", "open-meteo-ledger.json"), "utf-8")) as { spent: Array<[number, number]> };
    expect(ledger.spent).toHaveLength(4);

    // A second run picks different gaps rather than redoing these.
    const again = await job.runClimateJobOnce({ maxCells: 1, fetchFn, delayMs: 0 });
    expect(again!.cellsCompleted).toBe(1);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf-8")).cells)).toHaveLength(3);
  });

  it("schedules the next run at the configured UTC hour", async () => {
    const { msUntilHourUtc, startClimateJob, climateJobBudget } = await import("./climateJob");
    expect(msUntilHourUtc(3, new Date("2026-11-10T01:00:00Z"))).toBe(2 * 3_600_000);
    expect(msUntilHourUtc(3, new Date("2026-11-10T03:00:00Z"))).toBe(24 * 3_600_000); // already 03:00: tomorrow
    expect(msUntilHourUtc(3, new Date("2026-11-10T20:30:00Z"))).toBe(6.5 * 3_600_000);
    expect(climateJobBudget({ CLIMATE_JOB_BUDGET: "900" } as NodeJS.ProcessEnv)).toBe(900);
    expect(climateJobBudget({} as NodeJS.ProcessEnv)).toBe(2500);
    // Disabled: nothing scheduled, nothing to stop.
    expect(() => startClimateJob({ CLIMATE_JOB: "off" } as NodeJS.ProcessEnv)()).not.toThrow();
  });
});
