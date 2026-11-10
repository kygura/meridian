import { create } from "zustand";
import { persist } from "zustand/middleware";
import { TRIP_COLORS, randomTripColor } from "./lib/tripColors";
import { mergeTrips } from "./lib/tripTransfer";
import { withMonths } from "./lib/season";
import { DEFAULT_DEPARTURE } from "./lib/tripPlan";
import { planOnlyNode, type NodeItinerary } from "./lib/itinerary";
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
  MonthSpan,
  LegPlan,
  TripOption,
  ShortlistEntry,
  TickerItem,
  MetricSurface,
  Journey,
  Alert,
  Watch,
  ReplayQuery,
} from "./types";

/** Quick-log sheet state. `prefillStops` = city ids to start with (e.g. "Log a visit" in the city panel). */
export interface QuickLogState {
  open: boolean;
  journeyId?: string;
  prefillStops?: string[];
}

/** The replay window an alert points at: the watch's query plus the alert's city and month. */
export interface ReplayPrefill {
  query: ReplayQuery;
  cityId: string;
  month: number;
}

export interface MeridianState {
  /** Resolved theme, mirrored here by src/shell/theme.ts. Read-only for screens. */
  theme: "light" | "dark";

  // Cities
  cities: City[];
  setCities: (cities: City[]) => void;

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
  /** Place a stop in the season (or clear it with undefined). */
  setStopMonths: (tripId: string, index: number, months: MonthSpan | undefined) => void;
  /** The trip's own season, used while no stop is placed. */
  setTripSeason: (tripId: string, season: MonthSpan | undefined) => void;
  /** Plan the season for a year, or back to any year with undefined. */
  setTripYear: (tripId: string, year: number | undefined) => void;
  /** Where trips leave from unless a trip sets its own (persisted; default LPA). */
  homeDeparture: TripNode;
  setHomeDeparture: (node: TripNode) => void;
  /** The trip's own departure, or undefined to follow homeDeparture. */
  setTripDeparture: (tripId: string, node: TripNode | undefined) => void;
  /** Fly back to the departure after the last stop (default true). */
  setTripReturnHome: (tripId: string, returnHome: boolean) => void;
  reorderTripNodes: (tripId: string, fromIndex: number, toIndex: number) => void;
  /** Itinerary (ADR 0010): set or clear (undefined) a stop's dates, stay, activities, notes. */
  patchStop: (tripId: string, index: number, patch: Partial<NodeItinerary>) => void;
  /** The plan for the leg arriving at stop `slot`, or "home" for the leg back. undefined clears it. */
  setLegPlan: (tripId: string, slot: number | "home", plan: LegPlan | undefined) => void;
  /** How many people travel (1-9), for search links. */
  setTripTravellers: (tripId: string, travellers: number) => void;
  duplicateTrip: (tripId: string) => string;
  removeTrip: (id: string) => void;
  /** Add trips from a file; same-id trips are replaced. Returns counts for the toast. */
  importTrips: (trips: Trip[]) => { added: number; replaced: number };

  // Agent-generated trip candidates (origin: "agent" trips awaiting confirmation)
  setAgentCandidates: (options: TripOption[]) => void;
  confirmCandidate: (tripId: string) => void;
  /** Dismiss one agent candidate. */
  discardCandidate: (tripId: string) => void;
  discardAgentCandidates: () => void;

  // Metric surfaces cache
  surfaces: Record<string, MetricSurface>;
  setSurface: (id: string, surface: MetricSurface) => void;

  // Shortlist
  shortlist: ShortlistEntry[];
  setShortlist: (entries: ShortlistEntry[]) => void;
  addToShortlist: (entry: ShortlistEntry) => void;
  removeFromShortlist: (cityId: string) => void;

  // News headlines (World screen, city panel)
  ticker: TickerItem[];
  setTicker: (items: TickerItem[]) => void;

  // Seasonality cache (shared by When to go, the map and the city panel; not persisted —
  // climate data is served, fine to rebuild per session; null = confirmed uncovered)
  seasonality: Record<string, SeasonMonth[] | null>;
  setSeasonality: (cityId: string, months: SeasonMonth[] | null) => void;
  mergeSeasonality: (record: Record<string, SeasonMonth[] | null>) => void;
  seasonalityRegions: RegionSeason[] | null;
  setSeasonalityRegions: (regions: RegionSeason[]) => void;
  /** Year range the comfort scores average over, as served (e.g. "2015-2024"); null until known. */
  seasonalityWindow: string | null;
  setSeasonalityWindow: (window: string | null) => void;
  seasonsShowRegions: boolean;
  setSeasonsShowRegions: (on: boolean) => void;

  // Booking sheet (offers themselves stay component-local)
  bookingModal: { open: boolean; target: BookingTarget | null };
  openBookingModal: (target: BookingTarget) => void;
  closeBookingModal: () => void;

  // Bookings cache (server is source of truth — A1; NOT in the localStorage
  // partialize allow-list, rehydrates from the API)
  bookings: Booking[];
  setBookings: (bookings: Booking[]) => void;
  fetchBookings: () => Promise<void>;
  applyBookingCancelled: (id: string) => void;

  // Journal & Replay (DESIGN-journal.md §1.3). Not persisted: the server is the
  // source of truth and the token lives in journalApi (localStorage).
  journalLocked: boolean;
  /** Set with journalLocked: "token_not_configured" = server has no MERIDIAN_TOKEN. */
  journalLockReason: "token_not_configured" | null;
  setJournalLocked: (locked: boolean, reason?: "token_not_configured" | null) => void;
  journeys: Journey[] | null;
  setJourneys: (journeys: Journey[] | null) => void;
  upsertJourney: (journey: Journey) => void;
  removeJourney: (id: string) => void;
  importPending: number;
  setImportPending: (n: number) => void;
  alertsUnseen: number;
  alerts: Alert[];
  setAlerts: (alerts: Alert[]) => void;
  watches: Watch[];
  setWatches: (watches: Watch[]) => void;
  quickLog: QuickLogState;
  openQuickLog: (opts?: { journeyId?: string; prefillStops?: string[] }) => void;
  closeQuickLog: () => void;
  /** Set by "View" on an alert; Plan › Repeat a trip applies it once and clears it. */
  replayPrefill: ReplayPrefill | null;
  setReplayPrefill: (p: ReplayPrefill | null) => void;
}

/** Persisted keys (localStorage "meridian-trips"). Anything else found there is dropped on load. */
const PERSIST_VERSION = 1;

/** Old default names ("TRIP 3", "Lisbon COPY") in the new sentence-case wording. */
export function modernTripName(name: string): string {
  const numbered = /^TRIP (\d+)$/.exec(name);
  if (numbered) return `Trip ${numbered[1]}`;
  if (name === "TRIP") return "Trip";
  if (name.endsWith(" COPY")) return `${modernTripName(name.slice(0, -5))} (copy)`;
  return name;
}

function isNode(n: unknown): n is TripNode {
  if (!n || typeof n !== "object") return false;
  const o = n as Record<string, unknown>;
  return typeof o.cityId === "string" && typeof o.name === "string" && Number.isFinite(o.lat) && Number.isFinite(o.lng);
}

export function migratePersisted(
  persisted: unknown,
  _version: number
): Pick<MeridianState, "trips" | "activeTripId"> & Partial<Pick<MeridianState, "homeDeparture">> {
  const p = (persisted && typeof persisted === "object" ? persisted : {}) as Record<string, unknown>;
  const trips = Array.isArray(p.trips)
    ? (p.trips as Trip[])
        .filter((t) => t && typeof t === "object" && typeof t.id === "string" && Array.isArray(t.nodes))
        .map((t) => ({ ...t, name: typeof t.name === "string" ? modernTripName(t.name) : "Trip" }))
    : [];
  const activeTripId = typeof p.activeTripId === "string" && trips.some((t) => t.id === p.activeTripId) ? p.activeTripId : null;
  return isNode(p.homeDeparture) ? { trips, activeTripId, homeDeparture: p.homeDeparture } : { trips, activeTripId };
}

export const useMeridianStore = create<MeridianState>()(
  persist(
    (set, get) => ({
      theme: "light",

      // Cities
      cities: [],
      setCities: (cities) => set({ cities }),

      // Trips
      trips: [],
      activeTripId: null,
      setActiveTrip: (id) => set({ activeTripId: id }),
      createTrip: (name) => {
        const id = `trip-${Date.now()}`;
        const state = get();
        const trip: Trip = {
          id,
          name: name ?? `Trip ${state.trips.length + 1}`,
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
      setStopMonths: (tripId, index, months) =>
        set((state) => ({
          trips: state.trips.map((t) =>
            t.id === tripId && t.nodes[index]
              ? { ...t, nodes: t.nodes.map((n, i) => (i === index ? withMonths(n, months) : n)) }
              : t
          ),
        })),
      setTripSeason: (tripId, season) =>
        set((state) => ({
          trips: state.trips.map((t) => {
            if (t.id !== tripId) return t;
            const { season: _old, ...rest } = t;
            return season ? { ...rest, season } : rest;
          }),
        })),
      setTripYear: (tripId, year) =>
        set((state) => ({
          trips: state.trips.map((t) => {
            if (t.id !== tripId) return t;
            const { year: _old, ...rest } = t;
            return year ? { ...rest, year } : rest;
          }),
        })),
      homeDeparture: DEFAULT_DEPARTURE,
      setHomeDeparture: (node) => set({ homeDeparture: node }),
      setTripDeparture: (tripId, node) =>
        set((state) => ({
          trips: state.trips.map((t) => {
            if (t.id !== tripId) return t;
            const { departure: _old, ...rest } = t;
            return node ? { ...rest, departure: node } : rest;
          }),
        })),
      setTripReturnHome: (tripId, returnHome) =>
        set((state) => ({
          trips: state.trips.map((t) => {
            if (t.id !== tripId) return t;
            const { returnHome: _old, ...rest } = t;
            return returnHome ? rest : { ...rest, returnHome: false };
          }),
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
            name: `Trip ${state.trips.length + 1}`,
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
      patchStop: (tripId, index, patch) =>
        set((state) => ({
          trips: state.trips.map((t) => {
            if (t.id !== tripId || !t.nodes[index]) return t;
            const next = { ...t.nodes[index], ...patch };
            for (const k of Object.keys(patch) as (keyof NodeItinerary)[]) if (patch[k] === undefined) delete next[k];
            return { ...t, nodes: t.nodes.map((n, i) => (i === index ? next : n)) };
          }),
        })),
      setLegPlan: (tripId, slot, plan) =>
        set((state) => ({
          trips: state.trips.map((t) => {
            if (t.id !== tripId) return t;
            if (slot === "home") {
              const { homeLeg: _old, ...rest } = t;
              return plan ? { ...rest, homeLeg: plan } : rest;
            }
            if (!t.nodes[slot]) return t;
            const { travel: _old, ...node } = t.nodes[slot];
            return { ...t, nodes: t.nodes.map((n, i) => (i === slot ? (plan ? { ...node, travel: plan } : node) : n)) };
          }),
        })),
      setTripTravellers: (tripId, travellers) =>
        set((state) => ({
          trips: state.trips.map((t) => {
            if (t.id !== tripId) return t;
            const { travellers: _old, ...rest } = t;
            const n = Math.max(1, Math.min(9, Math.round(travellers)));
            return n > 1 ? { ...rest, travellers: n } : rest;
          }),
        })),
      duplicateTrip: (tripId) => {
        const id = `trip-${Date.now()}`;
        const state = get();
        const source = state.trips.find((t) => t.id === tripId);
        const dupe: Trip = source
          ? {
              id,
              name: `${source.name} (copy)`,
              color: randomTripColor(state.trips.map((t) => t.color)),
              status: "draft",
              // A copy is a plan to reuse: places, months and transport modes, not one year's dates and bookings.
              nodes: source.nodes.map(planOnlyNode),
            }
          : {
              id,
              name: "Trip",
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
      importTrips: (incoming) => {
        const { trips, added, replaced } = mergeTrips(get().trips, incoming);
        set((state) => ({ trips, activeTripId: state.activeTripId ?? incoming[0]?.id ?? null }));
        return { added, replaced };
      },

      // Agent-generated trip candidates
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
      discardCandidate: (tripId) =>
        set((state) => {
          const trips = state.trips.filter((t) => !(t.id === tripId && t.origin === "agent"));
          return {
            trips,
            activeTripId: state.activeTripId === tripId ? null : state.activeTripId,
          };
        }),
      discardAgentCandidates: () =>
        set((state) => {
          const remaining = state.trips.filter((t) => t.origin !== "agent");
          const activeStillValid = remaining.some((t) => t.id === state.activeTripId);
          return {
            trips: remaining,
            activeTripId: activeStillValid ? state.activeTripId : null,
          };
        }),

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

      // News headlines
      ticker: [],
      setTicker: (items) => set({ ticker: items }),

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
      seasonalityWindow: null,
      setSeasonalityWindow: (window) => {
        if (window) set({ seasonalityWindow: window });
      },
      seasonsShowRegions: false,
      setSeasonsShowRegions: (on) => set({ seasonsShowRegions: on }),

      // Booking sheet
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
      applyBookingCancelled: (id) =>
        set((state) => ({
          bookings: state.bookings.map((b) =>
            b.id === id
              ? { ...b, status: "cancelled" as const, cancelledAt: new Date().toISOString() }
              : b
          ),
        })),

      // Journal & Replay
      journalLocked: false,
      journalLockReason: null,
      setJournalLocked: (locked, reason = null) =>
        set({ journalLocked: locked, journalLockReason: locked ? reason : null }),
      journeys: null,
      setJourneys: (journeys) => set({ journeys }),
      upsertJourney: (journey) =>
        set((state) => {
          const list = state.journeys;
          // An unloaded list stays unloaded: a partial list must never stand in for the full one.
          if (!list) return {};
          return {
            journeys: list.some((j) => j.id === journey.id)
              ? list.map((j) => (j.id === journey.id ? journey : j))
              : [...list, journey],
          };
        }),
      removeJourney: (id) =>
        set((state) => ({ journeys: state.journeys?.filter((j) => j.id !== id) ?? null })),
      importPending: 0,
      setImportPending: (n) => set({ importPending: n }),
      alertsUnseen: 0,
      alerts: [],
      setAlerts: (alerts) => set({ alerts, alertsUnseen: alerts.filter((a) => !a.seen).length }),
      watches: [],
      setWatches: (watches) => set({ watches }),
      quickLog: { open: false },
      openQuickLog: (opts) => set({ quickLog: { open: true, ...opts } }),
      closeQuickLog: () => set({ quickLog: { open: false } }),
      replayPrefill: null,
      setReplayPrefill: (p) => set({ replayPrefill: p }),
    }),
    {
      name: "meridian-trips",
      version: PERSIST_VERSION,
      // v0 → v1: keep only trips + activeTripId, and reword the old upper-case default names.
      migrate: (persisted, version) => migratePersisted(persisted, version) as unknown as MeridianState,
      // Same-version loads also drop unknown keys, so stale fields never reach the store.
      merge: (persisted, current) => ({ ...current, ...migratePersisted(persisted, PERSIST_VERSION) }),
      partialize: (state) => ({
        trips: state.trips.filter((t) => t.origin !== "agent"),
        activeTripId: state.activeTripId,
        homeDeparture: state.homeDeparture,
      }),
    }
  )
);
