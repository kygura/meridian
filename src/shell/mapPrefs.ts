import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_OVERLAY, normalizeOverlay, type OverlayConfig, type SignalConfig } from "../lib/overlayConfig";

// Map layer choices, remembered per browser. Shared so other screens (quick log) can
// switch a layer on; the map screen owns the UI.

/** "seasons" is the data layer: the country tint plus the filters and signals configured below. */
export type MapLayer = "past" | "planned" | "cities" | "seasons";

interface MapPrefs {
  layers: Record<MapLayer, boolean>;
  /** Month for the data layer, 1-12. */
  month: number;
  /** What the data layer shows (src/lib/overlayConfig.ts). */
  overlay: OverlayConfig;
  setLayer: (key: MapLayer, on: boolean) => void;
  setMonth: (month: number) => void;
  patchOverlay: (patch: Partial<Omit<OverlayConfig, "signals">>) => void;
  patchSignals: (patch: Partial<SignalConfig>) => void;
  /** Clear filters and signals, keep the tint. */
  resetOverlay: () => void;
}

export const useMapPrefs = create<MapPrefs>()(
  persist(
    (set) => ({
      layers: { past: true, planned: true, cities: true, seasons: false },
      month: new Date().getMonth() + 1,
      overlay: DEFAULT_OVERLAY,
      setLayer: (key, on) => set((s) => ({ layers: { ...s.layers, [key]: on } })),
      setMonth: (month) => set({ month: Math.min(12, Math.max(1, Math.round(month))) }),
      patchOverlay: (patch) => set((s) => ({ overlay: normalizeOverlay({ ...s.overlay, ...patch }) })),
      patchSignals: (patch) => set((s) => ({ overlay: normalizeOverlay({ ...s.overlay, signals: { ...s.overlay.signals, ...patch } }) })),
      resetOverlay: () =>
        set((s) => ({ overlay: { ...DEFAULT_OVERLAY, tint: s.overlay.tint, invertTint: s.overlay.invertTint } })),
    }),
    {
      name: "meridian.map",
      // No version bump: a bump without `migrate` makes zustand drop the saved prefs. Older saves
      // simply have no overlay block, and hand-edited or stale ones get coerced here.
      merge: (saved, current) => {
        const s = (saved ?? {}) as Partial<MapPrefs>;
        return { ...current, ...s, overlay: normalizeOverlay(s.overlay) };
      },
    }
  )
);
