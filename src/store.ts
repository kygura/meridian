import { create } from "zustand";
import type {
  City,
  Trip,
  TripNode,
  ShortlistEntry,
  TickerItem,
  CityMetrics,
  MeridianScore,
  MetricSurface,
  LayerKey,
} from "./types";

export interface MeridianState {
  // Theme
  theme: "light" | "dark";
  toggleTheme: () => void;

  // Cities
  cities: City[];
  setCities: (cities: City[]) => void;

  // Selection
  selectedCityId: string | null;
  selectCity: (id: string | null) => void;

  // Drawers
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;
  toggleLeftDrawer: () => void;
  setRightDrawer: (open: boolean) => void;

  // Command palette overlay
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  toggleCommand: () => void;

  // Trips
  trips: Trip[];
  activeTripId: string | null;
  setActiveTrip: (id: string) => void;
  addCityToTrip: (tripId: string, node: TripNode) => void;
  addCityToActiveTrip: (node: TripNode) => void;
  removeTrip: (id: string) => void;

  // Layers
  layers: Record<LayerKey, boolean>;
  toggleLayer: (key: LayerKey) => void;

  // Metric surfaces cache
  surfaces: Record<string, MetricSurface>;
  setSurface: (id: string, surface: MetricSurface) => void;

  // Shortlist
  shortlist: ShortlistEntry[];
  setShortlist: (entries: ShortlistEntry[]) => void;
  addToShortlist: (entry: ShortlistEntry) => void;
  removeFromShortlist: (cityId: string) => void;

  // Ticker
  ticker: TickerItem[];
  setTicker: (items: TickerItem[]) => void;

  // City metrics cache
  cityMetrics: Record<string, CityMetrics>;
  setCityMetrics: (cityId: string, metrics: CityMetrics) => void;

  // Scores cache
  cityScores: Record<string, MeridianScore>;
  setCityScore: (cityId: string, score: MeridianScore) => void;
}

const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  trips: true,
  routes: true,
  cities: true,
  weather: false,
  stability: false,
  density: false,
  tourism: false,
  quality: false,
  cost: false,
  internet: false,
  conflict: false,
  disaster: false,
};

export const useMeridianStore = create<MeridianState>((set) => ({
  // Theme
  theme: "light",
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      return { theme: next };
    }),

  // Cities
  cities: [],
  setCities: (cities) => set({ cities }),

  // Selection
  selectedCityId: null,
  selectCity: (id) =>
    set({ selectedCityId: id, rightDrawerOpen: id !== null }),

  // Drawers
  leftDrawerOpen: false,
  rightDrawerOpen: false,
  toggleLeftDrawer: () =>
    set((state) => ({ leftDrawerOpen: !state.leftDrawerOpen })),
  setRightDrawer: (open) => set({ rightDrawerOpen: open }),

  // Command palette overlay
  commandOpen: false,
  setCommandOpen: (open) => set({ commandOpen: open }),
  toggleCommand: () => set((state) => ({ commandOpen: !state.commandOpen })),

  // Trips
  trips: [],
  activeTripId: null,
  setActiveTrip: (id) => set({ activeTripId: id }),
  addCityToTrip: (tripId, node) =>
    set((state) => ({
      trips: state.trips.map((t) =>
        t.id === tripId ? { ...t, nodes: [...t.nodes, node] } : t
      ),
    })),
  addCityToActiveTrip: (node) =>
    set((state) => {
      if (state.trips.some((t) => t.id === state.activeTripId)) {
        return {
          trips: state.trips.map((t) =>
            t.id === state.activeTripId
              ? { ...t, nodes: [...t.nodes, node] }
              : t
          ),
        };
      }
      const id = `trip-${Date.now()}`;
      const colors = ["a", "b", "c"] as const;
      const trip: Trip = {
        id,
        name: `TRIP ${state.trips.length + 1}`,
        color: colors[state.trips.length % 3],
        status: "draft",
        nodes: [node],
      };
      return { trips: [...state.trips, trip], activeTripId: id };
    }),
  removeTrip: (id) =>
    set((state) => ({
      trips: state.trips.filter((t) => t.id !== id),
    })),

  // Layers
  layers: DEFAULT_LAYERS,
  toggleLayer: (key) =>
    set((state) => ({
      layers: { ...state.layers, [key]: !state.layers[key] },
    })),

  // Metric surfaces cache
  surfaces: {},
  setSurface: (id, surface) =>
    set((state) => ({
      surfaces: { ...state.surfaces, [id]: surface },
    })),

  // Shortlist
  shortlist: [],
  setShortlist: (entries) => set({ shortlist: entries }),
  addToShortlist: (entry) =>
    set((state) => ({ shortlist: [...state.shortlist, entry] })),
  removeFromShortlist: (cityId) =>
    set((state) => ({
      shortlist: state.shortlist.filter((s) => s.cityId !== cityId),
    })),

  // Ticker
  ticker: [],
  setTicker: (items) => set({ ticker: items }),

  // City metrics cache
  cityMetrics: {},
  setCityMetrics: (cityId, metrics) =>
    set((state) => ({
      cityMetrics: { ...state.cityMetrics, [cityId]: metrics },
    })),

  // Scores cache
  cityScores: {},
  setCityScore: (cityId, score) =>
    set((state) => ({
      cityScores: { ...state.cityScores, [cityId]: score },
    })),
}));
