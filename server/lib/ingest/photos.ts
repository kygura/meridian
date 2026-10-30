// Photo-metadata ingestion (spec-journal §7 source 5). The browser sends only
// {timestamp, lat, lng, hash}; photos are grouped by nearest city (<= 50 km) and day, and each
// run of consecutive days in one city becomes a `stop` candidate. Photos at home (the home city,
// or within HOME_KM of it) are ignored (they are not trips); with no home configured, the city
// with the most photo days is assumed to be home when its photos span HOME_SPAN_DAYS or more (a
// batch from one trip has no home in it). Photos with no city nearby are skipped and reported.

import { z } from "zod";
import { getCityById } from "../cities.js";
import { daysBetween, nearHome, nearestCityId, shortHash, topKey } from "./geo.js";

export const MAX_PHOTOS = 5000;
const MIN_MS = Date.UTC(1990, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);
const HOME_SPAN_DAYS = 60;

/** ISO string, or epoch milliseconds (seconds when below 1e11). */
const timestampSchema = z.union([z.string().min(1).max(40), z.number().finite()]);

const photoSchema = z.object({
  timestamp: timestampSchema,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  hash: z.string().min(1).max(200),
});
export const photosSchema = z.array(photoSchema).max(MAX_PHOTOS);

function when(t: string | number): { ms: number; day: string } | undefined {
  const ms = typeof t === "number" ? (Math.abs(t) < 1e11 ? t * 1000 : t) : Date.parse(t);
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return undefined;
  // An ISO string keeps the local date it was written with; epoch numbers have none (UTC).
  const day = typeof t === "string" && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : new Date(ms).toISOString().slice(0, 10);
  return { ms, day };
}

export interface PhotosParse {
  candidates: unknown[];
  photos: number;
  excludedHome: number;
  homeCityId?: string;
  /** True when no home was configured and the city with the most photo days was assumed to be it. */
  homeInferred: boolean;
  errors: string[];
}

export function parsePhotos(raw: unknown, homeCityId?: string): PhotosParse {
  const photos = photosSchema.parse(raw);
  const result: PhotosParse = { candidates: [], photos: photos.length, excludedHome: 0, homeInferred: false, errors: [] };
  let unlocated = 0;
  let badTime = 0;

  const located: { t: { ms: number; day: string }; cityId: string; lat: number; lng: number; hash: string }[] = [];
  for (const p of photos) {
    const t = when(p.timestamp);
    if (!t) {
      badTime++;
      continue;
    }
    const cityId = nearestCityId(p.lat, p.lng);
    if (!cityId) {
      unlocated++;
      continue;
    }
    located.push({ t, cityId, lat: p.lat, lng: p.lng, hash: p.hash });
  }

  let home = homeCityId && getCityById(homeCityId) ? homeCityId : undefined;
  if (!home) {
    const daysIn = new Map<string, Set<string>>();
    for (const { cityId, t } of located) daysIn.set(cityId, (daysIn.get(cityId) ?? new Set()).add(t.day));
    const top = topKey(new Map([...daysIn].map(([id, ds]) => [id, ds.size])));
    const ds = top ? [...daysIn.get(top)!].sort() : [];
    if (top && daysBetween(ds[0], ds.at(-1)!) >= HOME_SPAN_DAYS) {
      home = top;
      result.homeInferred = true;
    }
  }
  result.homeCityId = home;

  // city → day → earliest photo of that day + count
  const byCity = new Map<string, Map<string, { ms: number; hash: string; n: number }>>();
  for (const { t, cityId, lat, lng, hash } of located) {
    if (cityId === home || nearHome(home, lat, lng)) {
      result.excludedHome++;
      continue;
    }
    const days = byCity.get(cityId) ?? new Map();
    byCity.set(cityId, days);
    const d = days.get(t.day);
    if (!d) days.set(t.day, { ms: t.ms, hash, n: 1 });
    else {
      d.n++;
      if (t.ms < d.ms) Object.assign(d, { ms: t.ms, hash });
    }
  }

  for (const [cityId, days] of byCity) {
    const sorted = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let run: typeof sorted = [];
    const flush = () => {
      if (!run.length) return;
      const arrive = run[0][0], depart = run.at(-1)![0];
      const first = run.reduce((m, [, d]) => (d.ms < m.ms ? d : m), run[0][1]);
      const count = run.reduce((n, [, d]) => n + d.n, 0);
      result.candidates.push({
        kind: "stop",
        payload: { cityId, arrive, depart },
        provenance: { source: "photo", sourceRef: shortHash([first.hash, cityId, arrive, depart], 24), confidence: run.length >= 2 || count >= 10 ? "medium" : "low" },
      });
      run = [];
    };
    for (const entry of sorted) {
      if (run.length && daysBetween(run.at(-1)![0], entry[0]) > 1) flush();
      run.push(entry);
    }
    flush();
  }

  if (unlocated) result.errors.push(`${unlocated} photos had no city within 50 km and were skipped`);
  if (badTime) result.errors.push(`${badTime} photos had an unreadable timestamp and were skipped`);
  return result;
}
