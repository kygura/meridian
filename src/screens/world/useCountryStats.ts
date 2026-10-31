import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "../../lib/api";
import { countryKey } from "../../lib/countryNames";
import { fetchRegions } from "../../lib/seasonalityApi";
import { useMeridianStore } from "../../store";
import type { MetricSurface } from "../../types";

// Country-level conditions for the World screen's region cards: metric surfaces
// (GET /api/metrics/surface/:id, averaged over each country's cities) plus this month's
// weather from the seasonality region aggregates. Cached in useMeridianStore.

const SURFACES = ["stability", "cost", "tourism", "weather"] as const;
export type SurfaceId = (typeof SURFACES)[number];

export interface CountryStats {
  /** 0-100 averages per surface; undefined when the country has no values. */
  values: Partial<Record<SurfaceId, number>>;
  /** Comfort score (0-100) for the current month, when known. */
  weatherNow?: number;
}

export type StatsStatus = "loading" | "ready" | "error";

export function useCountryStats(): { stats: (country: string) => CountryStats | null; status: StatsStatus; retry: () => void } {
  const surfaces = useMeridianStore((s) => s.surfaces);
  const regions = useMeridianStore((s) => s.seasonalityRegions);
  const cities = useMeridianStore((s) => s.cities);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const missing = SURFACES.filter((id) => !useMeridianStore.getState().surfaces[id]);
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
    if (!useMeridianStore.getState().seasonalityRegions)
      fetchRegions()
        .then((r) => useMeridianStore.getState().setSeasonalityRegions(r))
        .catch(() => {
          /* weather-now is optional; the year-round surface stands in */
        });
    return () => {
      live = false;
    };
  }, [attempt]);

  const table = useMemo(() => {
    const countryOf = new Map(cities.map((c) => [c.id, countryKey(c.country)]));
    const sums = new Map<string, Partial<Record<SurfaceId, { sum: number; n: number }>>>();
    for (const id of SURFACES) {
      const surf = surfaces[id];
      if (!surf) continue;
      for (const v of surf.values) {
        const key = countryOf.get(v.locationId);
        if (!key || typeof v.normalized !== "number") continue;
        const row = sums.get(key) ?? {};
        const cell = row[id] ?? { sum: 0, n: 0 };
        cell.sum += v.normalized;
        cell.n += 1;
        row[id] = cell;
        sums.set(key, row);
      }
    }
    const month = new Date().getMonth();
    const now = new Map<string, number>();
    for (const r of regions ?? []) {
      const s = r.months[month]?.score;
      if (typeof s === "number") now.set(countryKey(r.region), s);
    }
    const out = new Map<string, CountryStats>();
    for (const [key, row] of sums) {
      const values: Partial<Record<SurfaceId, number>> = {};
      for (const id of SURFACES) if (row[id]) values[id] = Math.round(row[id]!.sum / row[id]!.n);
      out.set(key, { values, weatherNow: now.get(key) });
    }
    for (const [key, s] of now) if (!out.has(key)) out.set(key, { values: {}, weatherNow: s });
    return out;
  }, [surfaces, regions, cities]);

  const ready = SURFACES.every((id) => surfaces[id]) && cities.length > 0;
  const status: StatsStatus = ready ? "ready" : error ? "error" : "loading";
  const stats = useCallback((country: string) => table.get(countryKey(country)) ?? null, [table]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { stats, status, retry };
}
