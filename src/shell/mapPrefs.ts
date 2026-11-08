import { create } from "zustand";
import { persist } from "zustand/middleware";
import { EMPTY_FILTER, type ClimateFilter, type ClimateMode, type ConditionId } from "../lib/climate";
import type { MetricId, MetricThresholds } from "../lib/cityMetrics";

// Map layer choices, remembered per browser. Shared so other screens (quick log) can
// switch a layer on; the map screen owns the UI.

export type MapLayer = "past" | "planned" | "cities" | "seasons" | "metrics" | "events" | "anomalies";

/** How city labels are written: English, the city's own language, or both. */
export type CityNames = "english" | "native" | "both";

export interface MetricPrefs {
  /** Surface the city dots are coloured by, or "none" for plain ink. */
  colorBy: MetricId | "none";
  /** Per-surface floors (or ceilings for crowds), 0-100. */
  thresholds: MetricThresholds;
}

interface MapPrefs {
  layers: Record<MapLayer, boolean>;
  /** Month for the seasons tint, events and hazards, 1-12. */
  month: number;
  /** What the seasons layer tints countries by. */
  climateMode: ClimateMode;
  /** Conditions cities and countries must meet (seasons layer). */
  climate: ClimateFilter;
  metrics: MetricPrefs;
  /** Hide non-matching cities instead of fading them. */
  onlyMatches: boolean;
  /** Treat cities in countries with a conflict advisory as non-matching. */
  avoidConflicts: boolean;
  /** Finder panel expanded. */
  finderOpen: boolean;
  cityNames: CityNames;
  setCityNames: (names: CityNames) => void;
  setLayer: (key: MapLayer, on: boolean) => void;
  setMonth: (month: number) => void;
  setClimateMode: (mode: ClimateMode) => void;
  setClimate: (filter: ClimateFilter) => void;
  setConditions: (conditions: ConditionId[]) => void;
  setMinComfort: (min: number) => void;
  setMetricColor: (id: MetricId | "none") => void;
  setThreshold: (id: MetricId, value: number | undefined) => void;
  setOnlyMatches: (on: boolean) => void;
  setAvoidConflicts: (on: boolean) => void;
  setFinderOpen: (open: boolean) => void;
  /** Drop every filter (climate, thresholds, conflict exclusion). */
  clearFilters: () => void;
}

const DEFAULT_LAYERS: Record<MapLayer, boolean> = {
  past: true,
  planned: true,
  cities: true,
  seasons: false,
  metrics: false,
  events: false,
  anomalies: false,
};

const clampPct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

export const useMapPrefs = create<MapPrefs>()(
  persist(
    (set) => ({
      layers: DEFAULT_LAYERS,
      month: new Date().getMonth() + 1,
      climateMode: "comfort",
      climate: EMPTY_FILTER,
      metrics: { colorBy: "none", thresholds: {} },
      onlyMatches: false,
      avoidConflicts: false,
      // Open on desktop; on phones the panel would cover the globe.
      finderOpen: typeof window === "undefined" || !window.matchMedia || window.matchMedia("(min-width: 900px)").matches,
      setLayer: (key, on) => set((s) => ({ layers: { ...s.layers, [key]: on } })),
      setMonth: (month) => set({ month: Math.min(12, Math.max(1, Math.round(month))) }),
      setClimateMode: (climateMode) => set({ climateMode }),
      setClimate: (climate) => set({ climate: { conditions: [...climate.conditions], minComfort: clampPct(climate.minComfort) } }),
      setConditions: (conditions) => set((s) => ({ climate: { ...s.climate, conditions } })),
      setMinComfort: (min) => set((s) => ({ climate: { ...s.climate, minComfort: clampPct(min) } })),
      setMetricColor: (colorBy) => set((s) => ({ metrics: { ...s.metrics, colorBy } })),
      setThreshold: (id, value) =>
        set((s) => {
          const thresholds = { ...s.metrics.thresholds };
          if (value === undefined) delete thresholds[id];
          else thresholds[id] = clampPct(value);
          return { metrics: { ...s.metrics, thresholds } };
        }),
      setOnlyMatches: (onlyMatches) => set({ onlyMatches }),
      setAvoidConflicts: (avoidConflicts) => set({ avoidConflicts }),
      setFinderOpen: (finderOpen) => set({ finderOpen }),
      cityNames: "english",
      setCityNames: (cityNames) => set({ cityNames }),
      clearFilters: () =>
        set((s) => ({ climate: EMPTY_FILTER, metrics: { ...s.metrics, thresholds: {} }, avoidConflicts: false })),
    }),
    {
      name: "meridian.map",
      version: 2,
      // Older saves lack the new layers and settings: fill them from the defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<MapPrefs>;
        return {
          ...current,
          ...p,
          layers: { ...DEFAULT_LAYERS, ...(p.layers ?? {}) },
          climate: { ...EMPTY_FILTER, ...(p.climate ?? {}) },
          metrics: { ...current.metrics, ...(p.metrics ?? {}), thresholds: { ...(p.metrics?.thresholds ?? {}) } },
        };
      },
      migrate: (state) => state as MapPrefs,
      partialize: (s) => ({
        layers: s.layers,
        month: s.month,
        climateMode: s.climateMode,
        climate: s.climate,
        metrics: s.metrics,
        onlyMatches: s.onlyMatches,
        avoidConflicts: s.avoidConflicts,
        finderOpen: s.finderOpen,
        cityNames: s.cityNames,
      }),
    }
  )
);
