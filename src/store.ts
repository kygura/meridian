import { create } from "zustand";
import { persist } from "zustand/middleware";
import { TRIP_COLORS, randomTripColor } from "./lib/tripColors";
import type { SeasonMonth, RegionSeason } from "./lib/seasonalityApi";
import {
  listBookings as listBookingsApi,
  type Booking,
  type BookingTarget,
} from "./lib/bookingApi";
import type {
  City,
  Trip,
  TripNode,
  TripOption,
  ShortlistEntry,
  TickerItem,
  CityMetrics,
  MeridianScore,
  MetricSurface,
  LayerKey,
} from "./types";

export interface CandidateFilters {
  maxBudget: number;
  maxStops: number;
  maxDays: number;
}

const DEFAULT_CANDIDATE_FILTERS: CandidateFilters = {
  maxBudget: 800,
  maxStops: 3,
  maxDays: 14,
};

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
  updateTripColor: (tripId: string, color: string) => void;
  addCityToTrip: (tripId: string, node: TripNode) => void;
  addCityToActiveTrip: (node: TripNode) => void;
  removeNodeAt: (tripId: string, index: number) => void;
  replaceNodeAt: (tripId: string, index: number, node: TripNode) => void;
  reorderTripNodes: (tripId: string, fromIndex: number, toIndex: number) => void;
  duplicateTrip: (tripId: string) => string;
  removeTrip: (id: string) => void;

  // On-globe route drawing
  drawMode: boolean;
  setDrawMode: (on: boolean) => void;

  // Agent-generated trip candidates (origin: "agent" trips awaiting confirmation)
  candidateFilters: CandidateFilters;
  setCandidateFilters: (patch: Partial<CandidateFilters>) => void;
  setAgentCandidates: (options: TripOption[]) => void;
  confirmCandidate: (tripId: string) => void;
  discardAgentCandidates: () => void;

  // Overlay modals
  tripsOverlayOpen: boolean;
  setTripsOverlayOpen: (open: boolean) => void;
  toggleTripsOverlay: () => void;
  candidatesOverlayOpen: boolean;
  setCandidatesOverlayOpen: (open: boolean) => void;
  toggleCandidatesOverlay: () => void;

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

  // Seasonality cache (shared by SeasonalityPage + SeasonStrip; not persisted —
  // climate data is served, fine to rebuild per session; null = confirmed uncovered)
  seasonality: Record<string, SeasonMonth[] | null>;
  setSeasonality: (cityId: string, months: SeasonMonth[] | null) => void;
  mergeSeasonality: (record: Record<string, SeasonMonth[] | null>) => void;
  seasonalityRegions: RegionSeason[] | null;
  setSeasonalityRegions: (regions: RegionSeason[]) => void;
  seasonsShowRegions: boolean;
  setSeasonsShowRegions: (on: boolean) => void;

  // Booking checkout modal (DESIGN-booking.md §7.3 — mirrors the
  // candidatesOverlayOpen pattern; offers themselves stay component-local)
  bookingModal: { open: boolean; target: BookingTarget | null };
  openBookingModal: (target: BookingTarget) => void;
  closeBookingModal: () => void;

  // Bookings cache (server is source of truth — A1; NOT in the localStorage
  // partialize allow-list, rehydrates from the API)
  bookings: Booking[];
  setBookings: (bookings: Booking[]) => void;
  fetchBookings: () => Promise<void>;
  bookingsPanelOpen: boolean;
  setBookingsPanelOpen: (open: boolean) => void;
  activeBookingId: string | null;
  openBookingTicket: (id: string | null) => void;
  applyBookingCancelled: (id: string) => void;
}

const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  trips: true,
  routes: true,
  cities: true,
  weather: false,
  cost: false,
  conflict: false,
  disaster: false,
};

export const useMeridianStore = create<MeridianState>()(
  persist(
    (set, get) => ({
      // Theme
      theme: "light",
      themeWipe: null,
      toggleTheme: (originX, originY) =>
        set((state) => {
          const next = state.theme === "light" ? "dark" : "light";
          const x = originX ?? window.innerWidth / 2;
          const y = originY ?? window.innerHeight / 2;
          return { themeWipe: { active: true, x, y, next } };
        }),
      clearThemeWipe: () => set({ themeWipe: null }),

      // Cities
      cities: [],
      setCities: (cities) => set({ cities }),

      // Selection
      selectedCityId: null,
      selectCity: (id) => set({ selectedCityId: id, rightDrawerOpen: id !== null }),

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
        const state = get();
        const trip: Trip = {
          id,
          name: name ?? `TRIP ${state.trips.length + 1}`,
          color: randomTripColor(state.trips.map((t) => t.color)),
          status: "draft",
          nodes: [],
        };
        set((s) => ({ trips: [...s.trips, trip], activeTripId: id }));
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
          const trip: Trip = {
            id,
            name: `TRIP ${state.trips.length + 1}`,
            color: randomTripColor(state.trips.map((t) => t.color)),
            status: "draft",
            nodes: [node],
          };
          return { trips: [...state.trips, trip], activeTripId: id };
        }),
      removeNodeAt: (tripId, index) =>
        set((state) => ({
          trips: state.trips.map((t) =>
            t.id === tripId
              ? { ...t, nodes: t.nodes.filter((_, i) => i !== index) }
              : t
          ),
        })),
      replaceNodeAt: (tripId, index, node) =>
        set((state) => ({
          trips: state.trips.map((t) =>
            t.id === tripId
              ? { ...t, nodes: t.nodes.map((n, i) => (i === index ? node : n)) }
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
        const state = get();
        const source = state.trips.find((t) => t.id === tripId);
        const dupe: Trip = source
          ? {
              id,
              name: `${source.name} COPY`,
              color: randomTripColor(state.trips.map((t) => t.color)),
              status: "draft",
              nodes: [...source.nodes],
            }
          : {
              id,
              name: "TRIP",
              color: randomTripColor([]),
              status: "draft",
              nodes: [],
            };
        set((s) => ({ trips: [...s.trips, dupe], activeTripId: id }));
        return id;
      },
      removeTrip: (id) =>
        set((state) => ({
          trips: state.trips.filter((t) => t.id !== id),
          activeTripId: state.activeTripId === id ? null : state.activeTripId,
        })),

      // On-globe route drawing
      drawMode: false,
      setDrawMode: (on) => set({ drawMode: on }),

      // Agent-generated trip candidates
      candidateFilters: DEFAULT_CANDIDATE_FILTERS,
      setCandidateFilters: (patch) =>
        set((state) => ({
          candidateFilters: { ...state.candidateFilters, ...patch },
        })),
      setAgentCandidates: (options) =>
        set((state) => {
          const manualTrips = state.trips.filter((t) => t.origin !== "agent");
          const candidates: Trip[] = options.map((opt, i) => ({
            id: opt.id,
            name: opt.label,
            color: TRIP_COLORS[i % TRIP_COLORS.length],
            status: "draft",
            nodes: opt.nodes,
            origin: "agent",
            estimate: opt.estimate,
          }));
          return {
            trips: [...manualTrips, ...candidates],
            activeTripId: candidates[0]?.id ?? state.activeTripId,
          };
        }),
      confirmCandidate: (tripId) =>
        set((state) => ({
          trips: state.trips.map((t) =>
            t.id === tripId ? { ...t, origin: "manual", status: "scouting" } : t
          ),
        })),
      discardAgentCandidates: () =>
        set((state) => {
          const remaining = state.trips.filter((t) => t.origin !== "agent");
          const activeStillValid = remaining.some((t) => t.id === state.activeTripId);
          return {
            trips: remaining,
            activeTripId: activeStillValid ? state.activeTripId : null,
          };
        }),

      // Overlay modals
      tripsOverlayOpen: false,
      setTripsOverlayOpen: (open) => set({ tripsOverlayOpen: open }),
      toggleTripsOverlay: () =>
        set((state) => ({ tripsOverlayOpen: !state.tripsOverlayOpen })),
      candidatesOverlayOpen: false,
      setCandidatesOverlayOpen: (open) => set({ candidatesOverlayOpen: open }),
      toggleCandidatesOverlay: () =>
        set((state) => ({ candidatesOverlayOpen: !state.candidatesOverlayOpen })),

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

      // Seasonality cache
      seasonality: {},
      setSeasonality: (cityId, months) =>
        set((state) => ({
          seasonality: { ...state.seasonality, [cityId]: months },
        })),
      mergeSeasonality: (record) =>
        set((state) => ({
          seasonality: { ...state.seasonality, ...record },
        })),
      seasonalityRegions: null,
      setSeasonalityRegions: (regions) => set({ seasonalityRegions: regions }),
      seasonsShowRegions: false,
      setSeasonsShowRegions: (on) => set({ seasonsShowRegions: on }),

      // Booking checkout modal
      bookingModal: { open: false, target: null },
      openBookingModal: (target) => set({ bookingModal: { open: true, target } }),
      closeBookingModal: () => set({ bookingModal: { open: false, target: null } }),

      // Bookings cache
      bookings: [],
      setBookings: (bookings) => set({ bookings }),
      fetchBookings: async () => {
        try {
          set({ bookings: await listBookingsApi() });
        } catch {
          // Server unreachable — keep the existing cache.
        }
      },
      bookingsPanelOpen: false,
      setBookingsPanelOpen: (open) =>
        set(open ? { bookingsPanelOpen: true } : { bookingsPanelOpen: false, activeBookingId: null }),
      activeBookingId: null,
      openBookingTicket: (id) =>
        set(id ? { activeBookingId: id, bookingsPanelOpen: true } : { activeBookingId: null }),
      applyBookingCancelled: (id) =>
        set((state) => ({
          bookings: state.bookings.map((b) =>
            b.id === id
              ? { ...b, status: "cancelled" as const, cancelledAt: new Date().toISOString() }
              : b
          ),
        })),
    }),
    {
      name: "meridian-trips",
      partialize: (state) => ({
        trips: state.trips.filter((t) => t.origin !== "agent"),
        activeTripId: state.activeTripId,
      }),
    }
  )
);
