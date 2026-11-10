// Backfills data/climate-normals.json (monthly PM2.5, weekly normals, and fresh monthly
// weather) for every city in the dataset, one 0.25 degree climate cell at a time.
//
//   npm run backfill:climate                       # fill as much as the quota allows, then stop
//   npm run backfill:climate -- --wait             # sleep through hourly/daily limits and keep going
//   npm run backfill:climate -- --max-cells 40     # at most 40 cells
//   npm run backfill:climate -- --budget 2000      # spend at most 2000 weighted calls this run
//   npm run backfill:climate -- --first chiang-mai-thailand,delhi-india   # these cities before the rest
//   npm run backfill:climate -- --dry-run          # print the plan and the quota arithmetic, call nothing
//
// Resumable: every fetched cell is written to the file straight away, and the quota ledger
// (data/cache/open-meteo-ledger.json) survives restarts, so a rerun picks up where it stopped
// and never spends past OPEN_METEO_HOURLY_BUDGET / OPEN_METEO_DAILY_BUDGET (default 3500 / 7000,
// under Open-Meteo's free-tier 5,000 / 10,000 weighted calls).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { loadCities, getCities } from "../server/lib/cities.ts";
import { getDataPath } from "../server/lib/paths.ts";
import {
  AIR_WEIGHT,
  AIR_WINDOW,
  WEATHER_WEIGHT,
  WEATHER_WINDOW,
  limitsFromEnv,
  planBackfill,
  runBackfill,
  type ClimateSink,
} from "../server/lib/climateBackfill.ts";
import { COMMITTED_CLIMATE_FILE, cellKeyFor, emptyClimateFile, parseClimateFile, serializeClimateFile, type ClimateCell } from "../server/lib/climateNormals.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const str = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string): number | undefined => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : undefined;
};

const OUT = getDataPath(COMMITTED_CLIMATE_FILE);

function load() {
  try {
    const f = parseClimateFile(readFileSync(OUT, "utf-8"));
    if (f) return f;
  } catch {
    // first run
  }
  return emptyClimateFile(WEATHER_WINDOW, AIR_WINDOW);
}

function seedIds(): Set<string> {
  try {
    const seed = JSON.parse(readFileSync(getDataPath("seasonality.json"), "utf-8")) as { cities?: Record<string, unknown> };
    return new Set(Object.keys(seed.cities ?? {}));
  } catch {
    return new Set();
  }
}

async function main() {
  loadCities();
  const cities = getCities();
  const file = load();
  file.weatherWindow = WEATHER_WINDOW;
  file.airWindow = AIR_WINDOW;
  const plan = planBackfill(cities, file.cells, { seedIds: seedIds(), firstIds: new Set((str("first") ?? "").split(",").filter(Boolean)) });
  const limits = limitsFromEnv();
  const cellCount = new Set(cities.map((c) => cellKeyFor(c.lat, c.lng))).size;
  const fullCost = plan.reduce((s, p) => s + (p.needsWeather ? WEATHER_WEIGHT : 0) + (p.needsAir ? AIR_WEIGHT : 0), 0);

  console.log(`[climate] ${cities.length} cities in ${cellCount} climate cells; ${Object.keys(file.cells).length} cells on file; ${plan.length} with a gap`);
  console.log(`[climate] a cell costs ~${WEATHER_WEIGHT} (weather) + ~${AIR_WEIGHT} (air) weighted calls; the gaps cost ~${Math.round(fullCost)}`);
  console.log(`[climate] our limits: ${limits.hourly}/hour, ${limits.daily}/day => about ${Math.floor(limits.daily / (WEATHER_WEIGHT + AIR_WEIGHT))} cells/day, ~${Math.ceil(fullCost / limits.daily)} days for everything`);
  if (flag("dry-run")) {
    for (const p of plan.slice(0, 15)) console.log(`  next: ${p.rep.name}, ${p.rep.country} (cell ${p.key}, ${p.cityCount} cities) weather=${p.needsWeather} air=${p.needsAir}`);
    return;
  }

  let lastWrite = 0;
  let dirty = false;
  const flush = () => {
    if (!dirty) return;
    file.generatedAt = new Date().toISOString();
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(`${OUT}.tmp`, serializeClimateFile(file));
    renameSync(`${OUT}.tmp`, OUT);
    dirty = false;
    lastWrite = Date.now();
  };
  const sink: ClimateSink = {
    get: (k) => file.cells[k],
    save: (k, cell: ClimateCell) => {
      file.cells[k] = cell;
      dirty = true;
      if (Date.now() - lastWrite > 3000) flush();
    },
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      flush();
      process.exit(130);
    });
  }

  const res = await runBackfill({
    sink,
    plan,
    runBudget: num("budget") ?? Number.POSITIVE_INFINITY,
    maxCells: num("max-cells"),
    wait: flag("wait"),
    limits,
    log: (l) => console.log(`[climate] ${l}`),
  });
  flush();
  const covered = cities.filter((c) => file.cells[cellKeyFor(c.lat, c.lng)]?.m).length;
  console.log(`[climate] stopped (${res.stoppedBy}): ${res.cellsCompleted} cells completed, ${res.cellsPartial} partial, ~${Math.round(res.spent)} weighted calls spent${res.lastError ? `, last error ${res.lastError}` : ""}`);
  console.log(`[climate] coverage now ${covered}/${cities.length} cities (${Object.keys(file.cells).length} cells); ${res.remainingGaps} cells still have a gap`);
}

void main();
