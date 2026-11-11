// Offline pipeline: fetches Open-Meteo historical daily climate data for a
// curated set of cities, aggregates it to monthly means, scores comfort per
// month, and writes the committed data/seasonality.json dataset.
//
// Usage:
//   bun run build:seasonality             # default coverage (~600 cities)
//   bun run build:seasonality --all       # every city in the DB
//   bun run build:seasonality --limit 50  # cap coverage to N cities
//
// Resumable: progress is written to data/cache/seasonality-progress.json
// after every batch, and data/seasonality.json is rewritten from that
// progress after every batch too — so a killed/interrupted run always
// leaves a valid (partial) dataset on disk, and a rerun skips cities that
// already completed.
//
// Rate limits (Open-Meteo, non-commercial, see docs/research-apis.md):
// ~600 calls/min, 5k/hr, 10k/day. Requests batch multiple cities per call
// via comma-separated latitude/longitude, with a polite delay between
// batches and retry-with-backoff on 429/5xx.

import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadCities, getCities } from "../server/lib/cities.ts";
import { aggregateDailyToMonthly, rescoreMonths } from "../server/lib/seasonality.ts";

const WINDOW_START_YEAR = 2015;
const WINDOW_END_YEAR = 2024;
const START_DATE = `${WINDOW_START_YEAR}-01-01`;
const END_DATE = `${WINDOW_END_YEAR}-12-31`;
const WINDOW = `${WINDOW_START_YEAR}-${WINDOW_END_YEAR}`;

const BATCH_SIZE = 15;
const BATCH_DELAY_MS = 500;
const MAX_RETRIES = 4;
const DEFAULT_TARGET = 600;

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const OUT_PATH = join(DATA_DIR, "seasonality.json");
const CACHE_DIR = join(DATA_DIR, "cache");
const PROGRESS_PATH = join(CACHE_DIR, "seasonality-progress.json");

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : undefined;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Default coverage: all capitals + all large-hub cities, then filled with
 * the highest-population remaining cities until ~600 total (or --limit N).
 * --all bypasses this selection and uses every city in the DB.
 */
function selectCities(cities) {
  if (ALL) return LIMIT ? cities.slice(0, LIMIT) : cities;

  const seen = new Set();
  const picked = [];
  const add = (c) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    picked.push(c);
  };

  for (const c of cities) if (c.capital) add(c);
  for (const c of cities) if (c.hub === "large") add(c);

  const target = LIMIT ?? DEFAULT_TARGET;
  const byPopulation = [...cities].sort((a, b) => b.population - a.population);
  for (const c of byPopulation) {
    if (picked.length >= target) break;
    add(c);
  }

  return picked.slice(0, target);
}

function loadProgress() {
  try {
    return JSON.parse(readFileSync(PROGRESS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveProgress(progress) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(PROGRESS_PATH, JSON.stringify(progress));
}

function writeDataset(progress) {
  const cities = {};
  for (const [id, months] of Object.entries(progress)) {
    cities[id] = { months };
  }
  const dataset = {
    version: 1,
    generatedAt: new Date().toISOString(),
    window: WINDOW,
    cities,
  };
  writeFileSync(OUT_PATH, JSON.stringify(dataset));
  return dataset;
}

async function fetchBatch(batch, attempt = 1) {
  const lat = batch.map((c) => c.lat.toFixed(4)).join(",");
  const lng = batch.map((c) => c.lng.toFixed(4)).join(",");
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}` +
    `&start_date=${START_DATE}&end_date=${END_DATE}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=UTC`;

  const res = await fetch(url);

  if (res.status === 429 || res.status >= 500) {
    if (attempt > MAX_RETRIES) {
      throw new Error(`Open-Meteo ${res.status} after ${MAX_RETRIES} retries`);
    }
    const retryAfter = Number(res.headers.get("retry-after")) || attempt * 3;
    console.warn(`[seasonality] ${res.status}, retrying in ${retryAfter}s (attempt ${attempt})`);
    await sleep(retryAfter * 1000);
    return fetchBatch(batch, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Open-Meteo ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = await res.json();
  return Array.isArray(body) ? body : [body];
}

async function main() {
  loadCities();
  const allCities = getCities();
  const selected = selectCities(allCities);
  console.log(
    `[seasonality] selected ${selected.length} cities (--all=${ALL} --limit=${LIMIT ?? "none"})`
  );

  const progress = loadProgress();
  const remaining = selected.filter((c) => !progress[c.id]);
  console.log(
    `[seasonality] ${Object.keys(progress).length} already done, ${remaining.length} remaining`
  );

  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    const batch = remaining.slice(i, i + BATCH_SIZE);
    try {
      const results = await fetchBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        const city = batch[j];
        const daily = results[j]?.daily;
        if (!daily?.time) {
          console.warn(`[seasonality] no data for ${city.id}, skipping`);
          continue;
        }
        const records = daily.time
          .map((date, k) => {
            const max = daily.temperature_2m_max[k];
            const min = daily.temperature_2m_min[k];
            const precip = daily.precipitation_sum[k];
            return {
              date,
              tempC: max != null && min != null ? (max + min) / 2 : null,
              precipMm: precip ?? 0,
            };
          })
          .filter((r) => r.tempC != null);

        if (records.length === 0) {
          console.warn(`[seasonality] empty records for ${city.id}, skipping`);
          continue;
        }

        const monthly = aggregateDailyToMonthly(records);
        progress[city.id] = rescoreMonths(monthly.map((m) => ({ score: 0, tempC: m.tempC, precipMm: m.precipMm })));
      }
      saveProgress(progress);
      writeDataset(progress);
      console.log(
        `[seasonality] ${Math.min(i + BATCH_SIZE, remaining.length)}/${remaining.length} done` +
          ` (${Object.keys(progress).length} total cities)`
      );
    } catch (err) {
      console.error(`[seasonality] batch starting at ${batch[0]?.id} failed:`, err.message);
      // Leave this batch's cities out of `progress` — they'll be retried
      // automatically on the next run.
    }
    await sleep(BATCH_DELAY_MS);
  }

  const dataset = writeDataset(progress);
  const count = Object.keys(dataset.cities).length;
  console.log(`[seasonality] wrote ${count} cities to ${OUT_PATH}`);
}

main();
