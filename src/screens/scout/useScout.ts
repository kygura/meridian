// Loads what the Scout screen shows. Four independent reads: the context drives most of the page,
// runs, trips and config each fail on their own without taking the page down.

import { useCallback, useEffect, useRef, useState } from "react";
import { JournalLockedError } from "../../lib/journalApi";
import { getAtlasConfig, getAtlasContext, getAtlasRuns, getAtlasTrips, type AtlasConfig, type AtlasContext, type RunSummary } from "../../lib/atlasApi";
import type { Trip } from "../../types";

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Reload. `quiet` keeps the current data on screen instead of showing skeletons. */
  reload: (quiet?: boolean) => Promise<void>;
  /** Replace the data in place (after an edit the server confirmed). */
  set: (next: T | ((prev: T | null) => T | null)) => void;
}

function useResource<T>(load: () => Promise<T>, enabled: boolean, key: unknown): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async (quiet = false) => {
    const mine = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const next = await loadRef.current();
      if (mine !== seq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (mine !== seq.current || err instanceof JournalLockedError) return;
      setError(err instanceof Error ? err.message : "The request failed.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      seq.current++;
      setData(null);
      setLoading(false);
      return;
    }
    void reload();
  }, [enabled, key, reload]);

  return { data, loading, error, reload, set: setData as Resource<T>["set"] };
}

export interface Scout {
  context: Resource<AtlasContext>;
  runs: Resource<RunSummary[]>;
  trips: Resource<Trip[]>;
  config: Resource<{ config: AtlasConfig; updatedAt: string | null }>;
  /** Reload everything, keeping what is on screen. */
  refreshAll: () => void;
}

export function useScout(unlocked: boolean, token: string | null): Scout {
  const context = useResource(() => getAtlasContext(), unlocked, token);
  const runs = useResource(() => getAtlasRuns(10), unlocked, token);
  const trips = useResource(getAtlasTrips, unlocked, token);
  const config = useResource(getAtlasConfig, unlocked, token);
  const refreshAll = useCallback(() => {
    void context.reload(true);
    void runs.reload(true);
    void trips.reload(true);
    void config.reload(true);
  }, [context, runs, trips, config]);
  return { context, runs, trips, config, refreshAll };
}
