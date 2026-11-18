// Northern and southern lights (ADR 0021). Two parts:
//   season  computed from each city's geomagnetic latitude (dipole approximation): cities at 62
//           degrees or more get a recurring season over the months with long dark nights.
//   alert   live: NOAA SWPC's planetary K-index forecast. When the predicted Kp in the next
//           three days reaches 5, a dated alert goes on cities at 55 degrees or more.

import type { City } from "../../../src/types.js";
import { httpGet, type SourceDef, type StoredEvent } from "./common.js";
import { orderMonths } from "../../../src/lib/eventKinds.js";

export const SWPC_KP_FORECAST = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
/** Geomagnetic north pole, dipole approximation (degrees). */
export const GEOMAGNETIC_POLE = { lat: 80.7, lng: -72.7 };
export const SEASON_MIN_GEOMAGNETIC_LAT = 62;
export const ALERT_MIN_GEOMAGNETIC_LAT = 55;
export const ALERT_KP = 5;
export const ALERT_WINDOW_HOURS = 72;
export const AURORA_INTERVAL_MS = 3 * 60 * 60 * 1000;

const rad = (d: number) => (d * Math.PI) / 180;

/** Geomagnetic latitude in degrees (positive north), by the centred-dipole formula. */
export function geomagneticLatitude(lat: number, lng: number): number {
  const s = Math.sin(rad(lat)) * Math.sin(rad(GEOMAGNETIC_POLE.lat)) + Math.cos(rad(lat)) * Math.cos(rad(GEOMAGNETIC_POLE.lat)) * Math.cos(rad(lng - GEOMAGNETIC_POLE.lng));
  return (Math.asin(Math.max(-1, Math.min(1, s))) * 180) / Math.PI;
}

/** Months with long dark nights where the lights are likely: September to March in the north, March to September in the south. */
export const NORTH_MONTHS = orderMonths([9, 10, 11, 12, 1, 2, 3]);
export const SOUTH_MONTHS = orderMonths([3, 4, 5, 6, 7, 8, 9]);

export function auroraSeasonEvents(cities: City[]): StoredEvent[] {
  const north = cities.filter((c) => geomagneticLatitude(c.lat, c.lng) >= SEASON_MIN_GEOMAGNETIC_LAT);
  const south = cities.filter((c) => geomagneticLatitude(c.lat, c.lng) <= -SEASON_MIN_GEOMAGNETIC_LAT);
  const out: StoredEvent[] = [];
  const make = (id: string, title: string, list: City[], months: number[], tags: string[]) => {
    if (!list.length) return;
    out.push({
      id,
      title,
      kind: "sky",
      cityIds: list.map((c) => c.id).sort(),
      month: months[0]!,
      months,
      recurring: true,
      tags,
      note: `Geomagnetic latitude ${SEASON_MIN_GEOMAGNETIC_LAT} degrees or more, in the months with long dark nights.`,
      source: "meridian",
      feed: "aurora",
    });
  };
  make("aurora-season-north", "Northern lights season", north, NORTH_MONTHS, ["aurora", "northern-lights", "sky"]);
  make("aurora-season-south", "Southern lights season", south, SOUTH_MONTHS, ["aurora", "southern-lights", "sky"]);
  return out;
}

export interface KpPoint {
  time: Date;
  kp: number;
  observed: string;
}

/** The forecast array of { time_tag, kp, observed }; the times carry no zone and are UTC. Rows that do not parse are skipped. */
export function parseKpForecast(json: unknown): KpPoint[] {
  if (!Array.isArray(json)) throw new Error("unexpected SWPC response");
  const out: KpPoint[] = [];
  for (const r of json as { time_tag?: unknown; kp?: unknown; observed?: unknown }[]) {
    const t = typeof r?.time_tag === "string" ? Date.parse(r.time_tag.endsWith("Z") ? r.time_tag : `${r.time_tag}Z`) : NaN;
    const kp = Number(r?.kp);
    if (Number.isFinite(t) && Number.isFinite(kp)) out.push({ time: new Date(t), kp, observed: String(r.observed ?? "") });
  }
  return out;
}

/** The highest predicted Kp in the next 72 hours, and when it first happens. */
export function peakKp(points: KpPoint[], now: Date): KpPoint | undefined {
  const end = now.getTime() + ALERT_WINDOW_HOURS * 3_600_000;
  const ahead = points.filter((p) => p.time.getTime() >= now.getTime() - 3 * 3_600_000 && p.time.getTime() <= end && p.observed !== "observed");
  let best: KpPoint | undefined;
  for (const p of ahead) if (!best || p.kp > best.kp) best = p;
  return best;
}

export function auroraAlertEvent(points: KpPoint[], cities: City[], now: Date): StoredEvent | undefined {
  const peak = peakKp(points, now);
  if (!peak || peak.kp < ALERT_KP) return undefined;
  const ids = cities.filter((c) => Math.abs(geomagneticLatitude(c.lat, c.lng)) >= ALERT_MIN_GEOMAGNETIC_LAT).map((c) => c.id).sort();
  if (!ids.length) return undefined;
  const date = peak.time.toISOString().slice(0, 10);
  const kp = Math.round(peak.kp * 10) / 10;
  return {
    id: `aurora-alert-${date}`,
    title: `Aurora alert (Kp ${kp})`,
    kind: "sky",
    cityIds: ids,
    month: Number(date.slice(5, 7)),
    date,
    recurring: false,
    tags: ["aurora", "aurora-alert", "sky"],
    note: `NOAA SWPC forecasts Kp ${kp} on ${date} (UTC), for places at ${ALERT_MIN_GEOMAGNETIC_LAT} degrees geomagnetic latitude or more.`,
    source: "noaa-swpc",
    sourceUrl: "https://www.swpc.noaa.gov/products/aurora-30-minute-forecast",
    feed: "aurora",
  };
}

export const auroraSource: SourceDef = {
  id: "aurora",
  intervalMs: AURORA_INTERVAL_MS,
  mayBeEmpty: true,
  async run(ctx) {
    const season = auroraSeasonEvents(ctx.cities);
    const seasonCities = new Set(season.flatMap((e) => e.cityIds)).size;
    const detail: Record<string, number | string> = { seasonCities };
    const events = [...season];
    try {
      const points = parseKpForecast(await (await httpGet(SWPC_KP_FORECAST, ctx, "NOAA SWPC")).json());
      const alert = auroraAlertEvent(points, ctx.cities, ctx.now);
      const peak = peakKp(points, ctx.now);
      detail.peakKpNext3Days = peak ? Math.round(peak.kp * 10) / 10 : "none";
      if (alert) {
        events.push(alert);
        detail.alertCities = alert.cityIds.length;
      }
    } catch (err) {
      // The seasons are computed and stay; only the live alert is missing until the next run.
      detail.liveError = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    }
    return { events, detail };
  },
};
