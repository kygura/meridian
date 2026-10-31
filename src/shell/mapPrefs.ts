import { create } from "zustand";
import { persist } from "zustand/middleware";

// Map layer choices, remembered per browser. Shared so other screens (quick log) can
// switch a layer on; the map screen owns the UI.

export type MapLayer = "past" | "planned" | "cities" | "seasons";

interface MapPrefs {
  layers: Record<MapLayer, boolean>;
  /** Month for the seasons tint, 1-12. */
  month: number;
  setLayer: (key: MapLayer, on: boolean) => void;
  setMonth: (month: number) => void;
}

export const useMapPrefs = create<MapPrefs>()(
  persist(
    (set) => ({
      layers: { past: true, planned: true, cities: true, seasons: false },
      month: new Date().getMonth() + 1,
      setLayer: (key, on) => set((s) => ({ layers: { ...s.layers, [key]: on } })),
      setMonth: (month) => set({ month: Math.min(12, Math.max(1, Math.round(month))) }),
    }),
    { name: "meridian.map" }
  )
);
