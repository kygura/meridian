import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../lib/api";
import { fetchCitySeasonality, SeasonalityUnavailableError, type SeasonMonth } from "../../lib/seasonalityApi";
import { useMeridianStore } from "../../store";
import type { MetricValue } from "../../types";

// Data hooks for the city panel: metrics (GET /api/metrics/city/:id) and the
// seasonality strip (shares useMeridianStore.seasonality with When to go).

export type LoadStatus = "loading" | "ready" | "error";

const metricsCache = new Map<string, Record<string, MetricValue>>();

export function useCityMetrics(cityId: string) {
  const [data, setData] = useState<Record<string, MetricValue> | null>(() => metricsCache.get(cityId) ?? null);
  const [status, setStatus] = useState<LoadStatus>(() => (metricsCache.has(cityId) ? "ready" : "loading"));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (metricsCache.has(cityId)) {
      setData(metricsCache.get(cityId)!);
      setStatus("ready");
      return;
    }
    let live = true;
    setStatus("loading");
    fetch(apiUrl(`/api/metrics/city/${encodeURIComponent(cityId)}`))
      .then((r) => {
        if (!r.ok) throw new Error(`metrics ${r.status}`);
        return r.json();
      })
      .then((body: { metrics?: Record<string, MetricValue> }) => {
        const m = body?.metrics && typeof body.metrics === "object" ? body.metrics : {};
        metricsCache.set(cityId, m);
        if (!live) return;
        setData(m);
        setStatus("ready");
      })
      .catch(() => {
        if (live) setStatus("error");
      });
    return () => {
      live = false;
    };
  }, [cityId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, status, retry };
}

export type SeasonState =
  | { status: "loading" }
  | { status: "ready"; months: SeasonMonth[] }
  | { status: "none" }
  | { status: "error"; unavailable: boolean };

export function useCitySeasonality(cityId: string): SeasonState & { retry: () => void } {
  const cached = useMeridianStore((s) => s.seasonality[cityId]);
  const [error, setError] = useState<null | { unavailable: boolean }>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (cached !== undefined) return;
    let live = true;
    setError(null);
    fetchCitySeasonality(cityId)
      .then((months) => {
        useMeridianStore.getState().setSeasonality(cityId, months);
      })
      .catch((e) => {
        if (live) setError({ unavailable: e instanceof SeasonalityUnavailableError });
      });
    return () => {
      live = false;
    };
  }, [cityId, cached, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (cached === null) return { status: "none", retry };
  if (cached) return { status: "ready", months: cached, retry };
  if (error) return { status: "error", unavailable: error.unavailable, retry };
  return { status: "loading", retry };
}

/** Server labels are Title Case ("Very Stable"); copy is sentence case. */
export function sentenceCase(s: string | undefined): string {
  if (!s) return "";
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Readable rows for the panel, in display order. */
export const CITY_METRICS: { id: string; label: string; hint: string }[] = [
  { id: "weather", label: "Weather", hint: "Year-round comfort" },
  { id: "stability", label: "Safety", hint: "Political stability" },
  { id: "cost", label: "Cost of living", hint: "Higher is more affordable" },
  { id: "tourism", label: "Crowds", hint: "Tourism pressure" },
  { id: "connectivity", label: "Internet", hint: "Connection quality" },
  { id: "quality", label: "Quality of life", hint: "Overall livability" },
];
