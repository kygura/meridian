// Pure helpers for planned trips (Trips › Upcoming, trip editor).
// Leg estimates come from lib/geo; booking matching from lib/bookingApi.

import { flightPath, estimateFlightHours, estimateLegCostUSD, type FlightHub } from "./geo";
import { findLegBooking, type Booking } from "./bookingApi";
import type { City, ShortlistEntry, Trip, TripNode } from "../types";

export interface TripLeg {
  index: number;
  from: TripNode;
  to: TripNode;
  km: number;
  hours: number;
  cost: number;
  via?: string;
  /** Both ends have an airport code, so the leg can be booked. */
  bookable: boolean;
}

/** Leg index of the flight from the departure to the first stop (bookings key on it). */
export const OUTBOUND_LEG = -1;
/** Leg index of the flight from the last stop back to the departure. */
export const RETURN_LEG = -2;

/** Default departure for every trip until the user picks another: Las Palmas de Gran Canaria. */
export const DEFAULT_DEPARTURE: TripNode = {
  cityId: "las-palmas-spain",
  name: "Las Palmas",
  iata: "LPA",
  lat: 28.1,
  lng: -15.43,
};

/** The trip's own departure, else the user's home departure, else LPA. */
export function tripDeparture(trip: Pick<Trip, "departure">, home?: TripNode | null): TripNode {
  return trip.departure ?? home ?? DEFAULT_DEPARTURE;
}

export interface TripRoute {
  departure: TripNode;
  /** Departure → first stop; absent with no stops or when the trip starts at home. */
  outbound?: TripLeg;
  /** Stop-to-stop legs (index 0..n-2). */
  legs: TripLeg[];
  /** Last stop → departure; absent when returnHome is false or the trip already ends at home. */
  inbound?: TripLeg;
  /** Every leg in flying order: outbound, stop legs, return. */
  all: TripLeg[];
}

function leg(index: number, from: TripNode, to: TripNode, hubs: FlightHub[]): TripLeg {
  const path = flightPath([from.lng, from.lat], [to.lng, to.lat], hubs);
  return {
    index,
    from,
    to,
    km: Math.round(path.distanceKm),
    hours: estimateFlightHours(path.distanceKm),
    cost: estimateLegCostUSD(path.distanceKm),
    via: path.via,
    bookable: Boolean(from.iata && to.iata),
  };
}

/** The full route flown from the departure: out to the first stop, between stops, and home. */
export function tripRoute(
  trip: Pick<Trip, "nodes" | "departure" | "returnHome">,
  home?: TripNode | null,
  hubs: FlightHub[] = []
): TripRoute {
  const departure = tripDeparture(trip, home);
  const nodes = trip.nodes;
  const legs = tripLegs(nodes, hubs);
  if (nodes.length === 0) return { departure, legs, all: legs };
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const outbound = first.cityId !== departure.cityId ? leg(OUTBOUND_LEG, departure, first, hubs) : undefined;
  const inbound =
    trip.returnHome !== false && last.cityId !== departure.cityId ? leg(RETURN_LEG, last, departure, hubs) : undefined;
  const all = [...(outbound ? [outbound] : []), ...legs, ...(inbound ? [inbound] : [])];
  return { departure, outbound, legs, inbound, all };
}

export interface TripTotals {
  km: number;
  hours: number;
  cost: number;
  legs: number;
}

/** Large airport hubs used to route legs that are too long for a nonstop. */
export function hubsFromCities(cities: City[]): FlightHub[] {
  return cities
    .filter((c) => c.hub === "large" && c.iata)
    .map((c) => ({ coord: [c.lng, c.lat] as [number, number], label: c.iata! }));
}

/** One leg per pair of consecutive stops, with time, distance and a cost estimate. */
export function tripLegs(nodes: TripNode[], hubs: FlightHub[] = []): TripLeg[] {
  const out: TripLeg[] = [];
  for (let i = 0; i < nodes.length - 1; i++) out.push(leg(i, nodes[i], nodes[i + 1], hubs));
  return out;
}

export function tripTotals(legs: TripLeg[]): TripTotals {
  return {
    km: legs.reduce((a, l) => a + l.km, 0),
    hours: legs.reduce((a, l) => a + l.hours, 0),
    cost: legs.reduce((a, l) => a + l.cost, 0),
    legs: legs.length,
  };
}

/**
 * Legs of a trip that have a live (not cancelled) booking. Pass the route's legs to count
 * the flights to and from the departure too; without them only stop-to-stop legs count.
 */
export function bookedLegCount(trip: Trip, bookings: Booking[], legs?: Pick<TripLeg, "index">[]): number {
  const indices = legs ? legs.map((l) => l.index) : trip.nodes.slice(1).map((_, i) => i);
  let n = 0;
  for (const i of indices) {
    const b = findLegBooking(bookings, trip.id, i);
    if (b && b.status === "booked") n++;
  }
  return n;
}

/** "Lisbon → Porto → Madrid"; long chains collapse the middle: "Lisbon → Porto → 3 more → Rome". */
export function stopChain(nodes: TripNode[], max = 4): string {
  const names = nodes.map((n) => n.name);
  if (names.length <= max) return names.join(" → ");
  const head = names.slice(0, max - 2);
  const hidden = names.length - (max - 1);
  return [...head, `${hidden} more`, names[names.length - 1]].join(" → ");
}

/** Whole days between the estimate's start and end dates, or null without dates. */
export function tripDays(trip: Trip): number | null {
  const r = trip.estimate?.dateRange;
  if (!r) return null;
  const ms = new Date(r.end).getTime() - new Date(r.start).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** "Mar 4 – Mar 12", or null without dates. */
export function tripDateRange(trip: Trip, locale?: string): string | null {
  const r = trip.estimate?.dateRange;
  if (!r) return null;
  const s = new Date(r.start);
  const e = new Date(r.end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  const fmt = (d: Date) => d.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  return `${fmt(s)} – ${fmt(e)}`;
}

/** "$1,240" (whole dollars, tabular in the UI). */
export function formatUSD(n: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `$${Math.round(n).toLocaleString("en-US")}`;
  }
}

export function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString("en-US")} km`;
}

/** "2h 15m", "45m" — plain words for flight time. */
export function formatFlightTime(hours: number): string {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export const STATUS_LABEL: Record<Trip["status"], string> = {
  draft: "Draft",
  scouting: "Scouting",
  confirmed: "Confirmed",
};

/**
 * Display name for a trip. Older saves named trips "TRIP 3" and copies "X COPY" (the store
 * migrates these on load, but names can also arrive from elsewhere); show those in sentence
 * case. A blank name reads "Untitled trip". Anything the user typed is shown as-is.
 */
export function displayTripName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Untitled trip";
  const numbered = /^TRIP (\d+)$/.exec(trimmed);
  if (numbered) return `Trip ${numbered[1]}`;
  const copy = /^(.*) COPY$/.exec(trimmed);
  if (copy) return `${displayTripName(copy[1])} (copy)`;
  return trimmed;
}

/** Next free "Trip N" name. */
export function nextTripName(trips: Pick<Trip, "name">[]): string {
  const used = new Set(trips.map((t) => displayTripName(t.name).toLowerCase()));
  let n = trips.length + 1;
  while (used.has(`trip ${n}`)) n++;
  return `Trip ${n}`;
}

/** Name for a duplicated trip: "Lisbon loop (copy)". */
export function copyTripName(name: string): string {
  const base = displayTripName(name);
  return base.endsWith("(copy)") ? base : `${base} (copy)`;
}

export function cityToNode(city: Pick<City, "id" | "name" | "iata" | "lat" | "lng">): TripNode {
  return { cityId: city.id, name: city.name, iata: city.iata, lat: city.lat, lng: city.lng };
}

export function shortlistToNode(e: ShortlistEntry): TripNode {
  return { cityId: e.cityId, name: e.name, iata: e.iata, lat: e.lat, lng: e.lng };
}

/** Offer "Return to <first stop>" when the trip has 2+ stops and doesn't end where it started. */
export function canReturnToStart(nodes: TripNode[]): boolean {
  return nodes.length >= 2 && nodes[nodes.length - 1].cityId !== nodes[0].cityId;
}

/** Stable React keys for stops, even when a city appears twice (round trips). */
export function stopKeys(nodes: TripNode[]): string[] {
  const seen = new Map<string, number>();
  return nodes.map((n) => {
    const k = seen.get(n.cityId) ?? 0;
    seen.set(n.cityId, k + 1);
    return `${n.cityId}#${k}`;
  });
}

export function flightsSearchUrl(a: TripNode, b: TripNode): string {
  const q = `flights from ${a.iata ?? a.name} to ${b.iata ?? b.name}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

export function staysSearchUrl(n: TripNode): string {
  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(n.name)}`;
}

/**
 * Index a dragged row should move to: the number of other rows whose vertical
 * midpoint is above the pointer. `from` is the dragged row's current index.
 */
export function dropIndex(pointerY: number, midpoints: number[], from: number): number {
  let n = 0;
  midpoints.forEach((m, i) => {
    if (i !== from && m < pointerY) n++;
  });
  return n;
}
