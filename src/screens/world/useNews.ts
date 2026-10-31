import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../lib/api";
import { useMeridianStore } from "../../store";
import type { TickerItem } from "../../types";

// World headlines (GET /api/news), cached in useMeridianStore.ticker and shared by the
// World screen and the city panel. Fetched on first use and again when older than
// 15 minutes; never polled in the background.

const STALE_MS = 15 * 60 * 1000;

let fetchedAt = 0;
let inflight: Promise<void> | null = null;
let lastError = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function isTickerItem(x: unknown): x is TickerItem {
  return !!x && typeof x === "object" && typeof (x as TickerItem).text === "string";
}

export function loadNews(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && fetchedAt && Date.now() - fetchedAt < STALE_MS) return Promise.resolve();
  inflight = fetch(apiUrl("/api/news"))
    .then((r) => {
      if (!r.ok) throw new Error(`news ${r.status}`);
      return r.json();
    })
    .then((data: unknown) => {
      const items = Array.isArray(data) ? data.filter(isTickerItem) : [];
      useMeridianStore.getState().setTicker(items);
      fetchedAt = Date.now();
      lastError = false;
    })
    .catch(() => {
      lastError = true;
    })
    .finally(() => {
      inflight = null;
      notify();
    });
  notify();
  return inflight;
}

export type NewsStatus = "loading" | "ready" | "error";

export function useNews(): { items: TickerItem[]; status: NewsStatus; refreshing: boolean; reload: () => void } {
  const items = useMeridianStore((s) => s.ticker);
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    void loadNews();
    return () => {
      listeners.delete(l);
    };
  }, []);
  const reload = useCallback(() => void loadNews(true), []);
  const busy = inflight !== null;
  let status: NewsStatus = "ready";
  if (items.length === 0) {
    if (busy) status = "loading";
    else if (lastError) status = "error";
    else if (!fetchedAt) status = "loading";
  }
  return { items, status, refreshing: busy && items.length > 0, reload };
}
