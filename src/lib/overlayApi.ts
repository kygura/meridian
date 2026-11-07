import { apiUrl } from "./api";
import type { ClimateMonth, CityProfile, SocietyVar } from "./overlayConfig";
import type { MeridianEvent } from "../types";

// Bulk overlay data (GET /api/overlay/*), fetched once per kind and kept for the session.

export interface ClimateData {
  window: string | null;
  cities: Record<string, ClimateMonth[]>;
}

export interface MetricsData {
  metrics: Partial<Record<SocietyVar, Record<string, number>>>;
  confidence: Record<string, string>;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

const once = <T>(load: () => Promise<T>) => {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((e) => {
      pending = null;
      throw e;
    });
    return pending;
  };
};

export const loadClimate = once(async (): Promise<ClimateData> => {
  const body = await getJson<{ window?: unknown; cities?: Record<string, [number, number, number][]> }>("/api/overlay/climate");
  const cities: ClimateData["cities"] = {};
  for (const [id, months] of Object.entries(body.cities ?? {})) {
    if (Array.isArray(months) && months.length === 12)
      cities[id] = months.map(([score, tempC, precipMm]) => ({ score, tempC, precipMm }));
  }
  return { window: typeof body.window === "string" && body.window ? body.window : null, cities };
});

export const loadMetrics = once(async (): Promise<MetricsData> => {
  const body = await getJson<Partial<MetricsData>>("/api/overlay/metrics");
  return { metrics: body.metrics ?? {}, confidence: body.confidence ?? {} };
});

export const loadEvents = once(async (): Promise<MeridianEvent[]> => {
  const body = await getJson<{ events?: MeridianEvent[] }>("/api/overlay/events");
  return Array.isArray(body.events) ? body.events : [];
});

/** One profile per city id from whichever datasets have loaded. */
export function buildProfiles(climate: ClimateData | null, metrics: MetricsData | null): Map<string, CityProfile> {
  const out = new Map<string, CityProfile>();
  const get = (id: string) => {
    let p = out.get(id);
    if (!p) out.set(id, (p = { scores: {} }));
    return p;
  };
  if (climate) for (const [id, months] of Object.entries(climate.cities)) get(id).climate = months;
  if (metrics)
    for (const [key, byCity] of Object.entries(metrics.metrics) as [SocietyVar, Record<string, number>][])
      for (const [id, v] of Object.entries(byCity)) get(id).scores[key] = v;
  return out;
}
