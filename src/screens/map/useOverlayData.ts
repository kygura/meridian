import { useCallback, useEffect, useState } from "react";
import { loadClimate, loadEvents, loadMetrics, type ClimateData, type MetricsData } from "../../lib/overlayApi";
import type { MeridianEvent } from "../../types";

// Loads the bulk overlay datasets the data layer needs, each only once something asks
// for it (the climate file, the social/political/infrastructure indices, the events list).

export interface OverlayNeeds {
  climate: boolean;
  metrics: boolean;
  events: boolean;
}

export interface OverlayDatasets {
  climate: ClimateData | null;
  metrics: MetricsData | null;
  events: MeridianEvent[] | null;
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

export function useOverlayData(need: OverlayNeeds): OverlayDatasets {
  const [climate, setClimate] = useState<ClimateData | null>(null);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [events, setEvents] = useState<MeridianEvent[] | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [attempt, setAttempt] = useState(0);

  const run = useCallback(<T,>(name: string, wanted: boolean, have: unknown, load: () => Promise<T>, set: (v: T) => void) => {
    if (!wanted || have) return undefined;
    let live = true;
    load()
      .then((v) => {
        if (!live) return;
        set(v);
        setFailed((f) => (f.has(name) ? new Set([...f].filter((x) => x !== name)) : f));
      })
      .catch(() => live && setFailed((f) => new Set(f).add(name)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => run("climate", need.climate, climate, loadClimate, setClimate), [run, need.climate, climate, attempt]);
  useEffect(() => run("metrics", need.metrics, metrics, loadMetrics, setMetrics), [run, need.metrics, metrics, attempt]);
  useEffect(() => run("events", need.events, events, loadEvents, setEvents), [run, need.events, events, attempt]);

  const loading =
    (need.climate && !climate && !failed.has("climate")) ||
    (need.metrics && !metrics && !failed.has("metrics")) ||
    (need.events && !events && !failed.has("events"));
  const hasFailed = (need.climate && failed.has("climate")) || (need.metrics && failed.has("metrics")) || (need.events && failed.has("events"));

  return {
    climate,
    metrics,
    events,
    loading,
    failed: hasFailed,
    retry: () => {
      setFailed(new Set());
      setAttempt((n) => n + 1);
    },
  };
}
