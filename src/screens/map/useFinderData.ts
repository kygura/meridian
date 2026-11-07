import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../lib/api";
import { fetchAllCitySeasonality } from "../../lib/seasonalityApi";
import type { ClimateMonth } from "../../lib/climate";
import type { MetricId } from "../../lib/cityMetrics";
import { useMeridianStore } from "../../store";
import type { MapAnomaly, MapEventPoint, MetricSurface } from "../../types";

// Data the map finder and the events / anomalies layers need, fetched only while the
// layer that uses it is on and cached for the session.

export type FeedStatus = "idle" | "loading" | "ready" | "error";

let climateCache: Record<string, ClimateMonth[]> | null = null;
let climateInflight: Promise<Record<string, ClimateMonth[]>> | null = null;

/** Every covered city's 12 months (GET /api/seasonality/cities). */
export function useAllCityClimate(enabled: boolean) {
  const [data, setData] = useState(climateCache);
  const [status, setStatus] = useState<FeedStatus>(climateCache ? "ready" : "idle");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || climateCache) return;
    let live = true;
    setStatus("loading");
    climateInflight ??= fetchAllCitySeasonality().then((r) => (climateCache = r.cities as Record<string, ClimateMonth[]>));
    climateInflight
      .then((d) => {
        if (!live) return;
        setData(d);
        setStatus("ready");
      })
      .catch(() => {
        climateInflight = null;
        if (live) setStatus("error");
      });
    return () => {
      live = false;
    };
  }, [enabled, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, status, retry };
}

/** Metric surfaces into useMeridianStore.surfaces (shared with the World screen). */
export function useMetricSurfaces(ids: MetricId[]) {
  const surfaces = useMeridianStore((s) => s.surfaces);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    const missing = key ? key.split(",").filter((id) => !useMeridianStore.getState().surfaces[id]) : [];
    if (!missing.length) return;
    let live = true;
    setError(false);
    Promise.all(
      missing.map((id) =>
        fetch(apiUrl(`/api/metrics/surface/${id}`))
          .then((r) => {
            if (!r.ok) throw new Error(`surface ${r.status}`);
            return r.json() as Promise<MetricSurface>;
          })
          .then((s) => {
            if (s && Array.isArray(s.values)) useMeridianStore.getState().setSurface(id, s);
          })
      )
    ).catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [key, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { surfaces, error, retry };
}

const eventsCache = new Map<number, MapEventPoint[]>();
let anomaliesCache: { asOf: string; note?: string; items: MapAnomaly[] } | null = null;

function useCachedFeed<T>(enabled: boolean, cacheKey: string, read: () => T | undefined, load: () => Promise<T>) {
  const [data, setData] = useState<T | undefined>(read);
  const [status, setStatus] = useState<FeedStatus>(() => (read() ? "ready" : "idle"));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const hit = read();
    if (hit) {
      setData(hit);
      setStatus("ready");
      return;
    }
    let live = true;
    setStatus("loading");
    load()
      .then((d) => {
        if (!live) return;
        setData(d);
        setStatus("ready");
      })
      .catch(() => live && setStatus("error"));
    return () => {
      live = false;
    };
    // read/load close over cacheKey only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cacheKey, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, status, retry };
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(path));
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
}

/** Events in a month, one point per city (GET /api/overlays/events). */
export function useMonthEvents(enabled: boolean, month: number) {
  return useCachedFeed(
    enabled,
    String(month),
    () => eventsCache.get(month),
    () =>
      getJson<{ events?: MapEventPoint[] }>(`/api/overlays/events?month=${month}`).then((b) => {
        const list = Array.isArray(b.events) ? b.events : [];
        eventsCache.set(month, list);
        return list;
      })
  );
}

/** Every conflict advisory and seasonal hazard; filtered by month on the client. */
export function useAnomalies(enabled: boolean) {
  return useCachedFeed(
    enabled,
    "all",
    () => anomaliesCache ?? undefined,
    () =>
      getJson<{ asOf?: string; note?: string; items?: MapAnomaly[] }>("/api/overlays/anomalies").then((b) => {
        anomaliesCache = { asOf: b.asOf ?? "", note: b.note, items: Array.isArray(b.items) ? b.items : [] };
        return anomaliesCache;
      })
  );
}
