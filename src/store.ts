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
  themeWipe: { active: boolean; x: number; y: number; next: "light" | "dark" } | null;
  toggleTheme: (originX?: number, originY?: number) => void;
  clearThemeWipe: () => void;

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
  createTrip: (name?: string) => string;
  updateTripName: (tripId: string, name: string) => void;
  updateTripStatus: (tripId: string, status: Trip["status"]) => void;
  updateTripColor: (tripId: string, color: Trip["color"]) => void;
  addCityToTrip: (tripId: string, node: TripNode) => void;
  addCityToActiveTrip: (node: TripNode) => void;
  removeNodeFromTrip: (tripId: string, cityId: string) => void;
  reorderTripNodes: (tripId: string, fromIndex: number, toIndex: number) => void;
  duplicateTrip: (tripId: string) => string;
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
  themeWipe: null,
  toggleTheme: (originX, originY) =>
    set((state) => {
      const next = state.theme === "light" ? "dark" : "light";
      const x = originX ?? window.innerWidth / 2;
      const y = originY ?? window.innerHeight / 2;
      return {
        themeWipe: { active: true, x, y, next },
      };
    }),
  clearThemeWipe: () => set({ themeWipe: null }),

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
  createTrip: (name) => {
    const id = `trip-${Date.now()}`;
    const colors = ["a", "b", "c"] as const;
    const trip: Trip = {
      id,
      name: name ?? `TRIP ${useMeridianStore.getState().trips.length + 1}`,
      color: colors[useMeridianStore.getState().trips.length % 3],
      status: "draft",
      nodes: [],
    };
    set((state) => ({ trips: [...state.trips, trip], activeTripId: id }));
    return id;
  },
  updateTripName: (tripId, name) =>
    set((state) => ({
      trips: state.trips.map((t) => (t.id === tripId ? { ...t, name } : t)),
    })),
  updateTripStatus: (tripId, status) =>
    set((state) => ({
      trips: state.trips.map((t) => (t.id === tripId ? { ...t, status } : t)),
    })),
  updateTripColor: (tripId, color) =>
    set((state) => ({
      trips: state.trips.map((t) => (t.id === tripId ? { ...t, color } : t)),
    })),
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
  removeNodeFromTrip: (tripId, cityId) =>
    set((state) => ({
      trips: state.trips.map((t) =>
        t.id === tripId
          ? { ...t, nodes: t.nodes.filter((n) => n.cityId !== cityId) }
          : t
      ),
    })),
  reorderTripNodes: (tripId, fromIndex, toIndex) =>
    set((state) => ({
      trips: state.trips.map((t) => {
        if (t.id !== tripId) return t;
        const nodes = [...t.nodes];
        const [moved] = nodes.splice(fromIndex, 1);
        nodes.splice(toIndex, 0, moved);
        return { ...t, nodes };
      }),
    })),
  duplicateTrip: (tripId) => {
    const id = `trip-${Date.now()}`;
    const source = useMeridianStore.getState().trips.find((t) => t.id === tripId);
    const colors = ["a", "b", "c"] as const;
    const dupe: Trip = source
      ? {
          id,
          name: `${source.name} COPY`,
          color: colors[useMeridianStore.getState().trips.length % 3],
          status: "draft",
          nodes: [...source.nodes],
        }
      : { id, name: "TRIP", color: "a" as const, status: "draft", nodes: [] };
    set((state) => ({ trips: [...state.trips, dupe], activeTripId: id }));
    return id;
  },
  removeTrip: (id) =>
    set((state) => ({
      trips: state.trips.filter((t) => t.id !== id),
      activeTripId: state.activeTripId === id ? null : state.activeTripId,
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
