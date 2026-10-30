// Google Maps Timeline ingestion (spec-journal §7 source 4). Parses the on-device export
// ({semanticSegments:[{visit:{topCandidate:{placeLocation:{latLng}}}}]}, or a bare array of
// those) and the older Takeout "Semantic Location History" ({timelineObjects:[{placeVisit}]}).
// Visits are resolved to the nearest city within 50 km, consecutive visits to one place are
// merged into stays, and stays of >= 1 night away from home become `stop` candidates.
// The raw file is parsed in memory and never stored.

import { getCityById } from "../cities.js";
import { daysBetween, localDayAt, nearHome, nearestCityId, shortHash, topKey } from "./geo.js";

/** Visits to the same place closer together than this belong to one stay. */
const MERGE_GAP_MS = 2 * 86_400_000;

export interface TimelineParse {
  candidates: unknown[];
  visits: number;
  homeCityId?: string;
  /** True when no home was configured and the city with the most nights was assumed to be it. */
  homeInferred: boolean;
  errors: string[];
}

interface Visit {
  startMs: number;
  endMs: number;
  /**
   * Local calendar day: as written for offset-aware or naive strings; UTC ("…Z", legacy Takeout)
   * and epoch times are shifted by a longitude estimate of the local offset.
   */
  startDay: string;
  endDay: string;
  lat: number;
  lng: number;
  name?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** ISO string as given, or ISO from an epoch-ms number/numeric string. */
function iso(v: unknown): string | undefined {
  if (typeof v === "string" && /^\d{10,}$/.test(v)) v = Number(v);
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) < 8.64e15 ? new Date(v).toISOString() : undefined;
  return typeof v === "string" && v.length >= 10 && v.length <= 40 ? v : undefined;
}

/** "38.7223°, -9.1393°" */
function parseLatLng(s: unknown): [number, number] | undefined {
  const m = typeof s === "string" ? /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?\s*$/.exec(s) : null;
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

function toVisit(lat: number | undefined, lng: number | undefined, start: unknown, end: unknown, name?: unknown): Visit | undefined {
  const s = iso(start), e = iso(end);
  if (lat === undefined || lng === undefined || !s || !e) return undefined;
  const startMs = Date.parse(s), endMs = Date.parse(e);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return undefined;
  const dayOf = (v: string, ms: number) => (/z$/i.test(v) ? localDayAt(ms, lng) : v.slice(0, 10));
  return { startMs, endMs, startDay: dayOf(s, startMs), endDay: dayOf(e, endMs), lat, lng, ...(typeof name === "string" && name.trim() ? { name: name.trim().slice(0, 80) } : {}) };
}

function visitOf(entry: unknown): Visit | undefined {
  if (!isObj(entry)) return undefined;
  if (isObj(entry.visit)) {
    const top = isObj(entry.visit.topCandidate) ? entry.visit.topCandidate : {};
    const ll = parseLatLng(isObj(top.placeLocation) ? top.placeLocation.latLng : undefined);
    return toVisit(ll?.[0], ll?.[1], entry.startTime, entry.endTime);
  }
  if (isObj(entry.placeVisit)) {
    const pv = entry.placeVisit;
    const loc = isObj(pv.location) ? pv.location : {};
    const dur = isObj(pv.duration) ? pv.duration : {};
    const e7 = (v: unknown) => (typeof v === "number" ? v / 1e7 : undefined);
    return toVisit(e7(loc.latitudeE7), e7(loc.longitudeE7), dur.startTimestamp ?? dur.startTimestampMs, dur.endTimestamp ?? dur.endTimestampMs, loc.name ?? loc.address);
  }
  return undefined;
}

interface Stay {
  key: string;
  cityId?: string;
  arrive: string;
  depart: string;
  endMs: number;
  lat: number;
  lng: number;
  name?: string;
}

export function parseTimeline(json: unknown, homeCityId?: string): TimelineParse {
  const entries: unknown[] = Array.isArray(json)
    ? json
    : isObj(json)
      ? [...(Array.isArray(json.semanticSegments) ? json.semanticSegments : []), ...(Array.isArray(json.timelineObjects) ? json.timelineObjects : [])]
      : [];
  const result: TimelineParse = { candidates: [], visits: 0, homeInferred: false, errors: [] };
  const visits = entries.map(visitOf).filter((v): v is Visit => !!v).sort((a, b) => a.startMs - b.startMs);
  result.visits = visits.length;
  if (!entries.length) result.errors.push("no semanticSegments or timelineObjects found");
  else if (!visits.length) result.errors.push("no place visits found in this file");

  const stays: Stay[] = [];
  for (const v of visits) {
    const cityId = nearestCityId(v.lat, v.lng);
    // Unresolved places are merged by ~10 km cell so a cabin stay stays one stay.
    const key = cityId ?? `~${v.lat.toFixed(1)},${v.lng.toFixed(1)}`;
    const last = stays.at(-1);
    if (last && last.key === key && v.startMs - last.endMs <= MERGE_GAP_MS) {
      last.endMs = Math.max(last.endMs, v.endMs);
      if (v.endDay > last.depart) last.depart = v.endDay;
    } else stays.push({ key, cityId, arrive: v.startDay, depart: v.endDay, endMs: v.endMs, lat: v.lat, lng: v.lng, name: v.name });
  }

  // Home is a stay key (city id, or ~10 km cell for places no city covers), so a home far from any
  // listed city is excluded too instead of turning every night at home into a trip. A stay within
  // HOME_KM of the home city is home as well (a suburb whose nearest listed city is another one).
  let homeKey = homeCityId && getCityById(homeCityId) ? homeCityId : undefined;
  if (!homeKey) {
    const nights = new Map<string, number>();
    for (const s of stays) nights.set(s.key, (nights.get(s.key) ?? 0) + daysBetween(s.arrive, s.depart));
    homeKey = topKey(nights);
    result.homeInferred = !!homeKey && getCityById(homeKey) !== undefined;
  }
  result.homeCityId = homeKey && getCityById(homeKey) ? homeKey : undefined;

  for (const s of stays) {
    if (s.key === homeKey || nearHome(homeKey, s.lat, s.lng) || daysBetween(s.arrive, s.depart) < 1) continue;
    const common = { kind: "stop", provenance: { source: "timeline", sourceRef: shortHash([s.key, s.arrive, s.depart]), confidence: "medium" } };
    result.candidates.push(
      s.cityId
        ? { ...common, payload: { cityId: s.cityId, arrive: s.arrive, depart: s.depart } }
        : // No city within 50 km: keep the place visible to the reviewer, who resolves it via PATCH.
          { ...common, payload: { cityHint: `${s.name ? `${s.name} ` : ""}(${s.lat.toFixed(3)}, ${s.lng.toFixed(3)})`, arrive: s.arrive, depart: s.depart } },
    );
  }
  return result;
}
