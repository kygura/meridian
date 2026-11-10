// Trip legs: the route from the departure, each leg's transport mode and its estimates.
// Pure and free of browser imports, so the server can build the same route for the
// calendar feed and the shared page (ADR 0010). lib/tripPlan re-exports all of it.

import { flightPath, haversineKm, estimateFlightHours, estimateLegCostUSD, type FlightHub } from "./geo";
import type { LegMode, LegPlan, LegRecord, Trip, TripNode } from "../types";

export const LEG_MODES: LegMode[] = ["flight", "train", "bus", "ferry", "drive"];

export const MODE_LABEL: Record<LegMode, string> = {
  flight: "Flight",
  train: "Train",
  bus: "Bus",
  ferry: "Ferry",
  drive: "Drive",
};

export function isLegMode(m: unknown): m is LegMode {
  return typeof m === "string" && (LEG_MODES as string[]).includes(m);
}

/** A city's landmass group (City.landmass), or undefined when it isn't known. */
export type LandmassOf = (cityId: string) => number | undefined;

// ── Default mode ─────────────────────────────────────────────────────
// By distance, and by whether the two cities share a landmass (Natural Earth, via
// data/city-geo.json). It is a starting point, not knowledge of what runs there:
// Meridian has no timetable or rail-network data, so the traveller can change it.

/** Up to this far over land, a car or taxi. */
export const DRIVE_MAX_KM = 100;
/** Up to this far over land, a bus. */
export const BUS_MAX_KM = 250;
/** Up to this far over land, a train; beyond it, a flight. */
export const TRAIN_MAX_KM = 700;
/** Up to this far across water, a ferry; beyond it, a flight. */
export const FERRY_MAX_KM = 300;
/** Without landmass data the sea can't be ruled out, so ground is only assumed this close. */
export const UNKNOWN_GROUND_MAX_KM = 400;

export interface ModeChoice {
  mode: LegMode;
  /** Why, in a few words, for the UI. */
  reason: string;
}

function groundByDistance(km: number): LegMode {
  return km <= DRIVE_MAX_KM ? "drive" : km <= BUS_MAX_KM ? "bus" : "train";
}

export function defaultLegMode(from: TripNode, to: TripNode, km: number, landmassOf?: LandmassOf): ModeChoice {
  const canFly = Boolean(from.iata && to.iata);
  const a = landmassOf?.(from.cityId);
  const b = landmassOf?.(to.cityId);
  if (a !== undefined && b !== undefined) {
    if (a !== b) {
      if (km <= FERRY_MAX_KM) return { mode: "ferry", reason: "sea crossing, close enough for a ferry" };
      return { mode: "flight", reason: "sea crossing" };
    }
    if (km <= TRAIN_MAX_KM || !canFly) {
      return { mode: groundByDistance(km), reason: canFly || km <= TRAIN_MAX_KM ? "same landmass" : "same landmass, no airport" };
    }
    return { mode: "flight", reason: "too far for a day on the ground" };
  }
  // No landmass data for one of the ends.
  if (km <= UNKNOWN_GROUND_MAX_KM) return { mode: groundByDistance(km), reason: "short distance" };
  if (!canFly && km <= TRAIN_MAX_KM) return { mode: "train", reason: "no airport" };
  return { mode: "flight", reason: "long distance" };
}

// ── Estimates for ground and sea legs ────────────────────────────────
// Every figure here is a stated assumption, shown next to the number it produces.
// None of it is a fare or a timetable.

/** Roads and rails don't run straight: the usual detour over the straight-line distance. */
export const GROUND_DETOUR = 1.25;
/** Ferries dodge headlands and follow lanes. */
export const SEA_DETOUR = 1.1;

interface ModeModel {
  /** Average speed door to door, km/h. */
  kmh: number;
  /** Fixed time: boarding, stations, port. Hours. */
  fixedHours: number;
  /** USD per km travelled, per person (per car for "drive"). */
  usdPerKm: number;
}

export const GROUND_MODEL: Record<Exclude<LegMode, "flight">, ModeModel> = {
  train: { kmh: 80, fixedHours: 0.5, usdPerKm: 0.1 },
  bus: { kmh: 55, fixedHours: 0.25, usdPerKm: 0.05 },
  drive: { kmh: 65, fixedHours: 0, usdPerKm: 0.12 },
  ferry: { kmh: 30, fixedHours: 1, usdPerKm: 0.25 },
};

export interface LegEstimate {
  /** Distance travelled (after the detour factor), km. */
  km: number;
  hours: number;
  /** USD, one way. Per person, except "drive" which is per car. */
  cost: number;
  /** How the figures were made, in plain words. */
  method: string;
}

export function estimateGroundLeg(mode: Exclude<LegMode, "flight">, straightKm: number): LegEstimate {
  const m = GROUND_MODEL[mode];
  const detour = mode === "ferry" ? SEA_DETOUR : GROUND_DETOUR;
  const km = Math.round(straightKm * detour);
  const hours = m.fixedHours + km / m.kmh;
  const cost = Math.round(km * m.usdPerKm);
  const per = mode === "drive" ? "per car, fuel and running costs" : "per person";
  const fixed = m.fixedHours ? ` plus ${m.fixedHours * 60} min` : "";
  return {
    km,
    hours,
    cost,
    method:
      `Rough estimate, not a fare or a timetable: ${Math.round(straightKm)} km in a straight line × ${detour} for the route, ` +
      `at ${m.kmh} km/h${fixed}, and $${m.usdPerKm.toFixed(2)} per km (${per}).`,
  };
}

export const FLIGHT_METHOD =
  "Rough estimate, not a fare: great-circle distance at 830 km/h plus 36 min, and $45 + $0.11 per km one way in economy.";

// ── Legs and routes ──────────────────────────────────────────────────

export interface TripLeg {
  index: number;
  from: TripNode;
  to: TripNode;
  /** Distance travelled: great circle for flights, with the detour factor otherwise. */
  km: number;
  hours: number;
  /** Estimated one-way cost in USD. */
  cost: number;
  via?: string;
  mode: LegMode;
  /** The mode is the default for the distance and geography, not the traveller's choice. */
  modeIsDefault: boolean;
  /** Why the default mode was chosen. */
  modeReason: string;
  /** How km, hours and cost were estimated. */
  method: string;
  /** A booking made elsewhere and recorded on this leg. */
  record?: LegRecord;
  /** A flight between two airports: it can be searched and booked. */
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
  /** Every leg in travel order: outbound, stop legs, return. */
  all: TripLeg[];
}

/** A leg's plan counts only while it still leaves from the city it was written for. */
export function matchingPlan(plan: LegPlan | undefined, from: TripNode): LegPlan | undefined {
  return plan && plan.fromCityId === from.cityId ? plan : undefined;
}

function hasRecord(r: LegRecord | undefined): r is LegRecord {
  return !!r && Object.values(r).some((v) => v !== undefined && v !== "");
}

export function buildLeg(
  index: number,
  from: TripNode,
  to: TripNode,
  hubs: FlightHub[] = [],
  plan?: LegPlan,
  landmassOf?: LandmassOf
): TripLeg {
  const straight = haversineKm([from.lng, from.lat], [to.lng, to.lat]);
  const choice = defaultLegMode(from, to, straight, landmassOf);
  const own = matchingPlan(plan, from);
  const mode = own?.mode ?? choice.mode;
  const record = hasRecord(own?.booked) ? own!.booked : undefined;
  const common = { index, from, to, mode, modeIsDefault: !own?.mode, modeReason: choice.reason, record };
  if (mode === "flight") {
    const path = flightPath([from.lng, from.lat], [to.lng, to.lat], hubs);
    return {
      ...common,
      km: Math.round(path.distanceKm),
      hours: estimateFlightHours(path.distanceKm),
      cost: estimateLegCostUSD(path.distanceKm),
      via: path.via,
      method: FLIGHT_METHOD,
      bookable: Boolean(from.iata && to.iata),
    };
  }
  const e = estimateGroundLeg(mode, straight);
  return { ...common, km: e.km, hours: e.hours, cost: e.cost, method: e.method, bookable: false };
}

/** One leg per pair of consecutive stops, with time, distance and a cost estimate. */
export function tripLegs(nodes: TripNode[], hubs: FlightHub[] = [], landmassOf?: LandmassOf): TripLeg[] {
  const out: TripLeg[] = [];
  for (let i = 0; i < nodes.length - 1; i++) out.push(buildLeg(i, nodes[i], nodes[i + 1], hubs, nodes[i + 1].travel, landmassOf));
  return out;
}

/** The full route from the departure: out to the first stop, between stops, and home. */
export function tripRoute(
  trip: Pick<Trip, "nodes" | "departure" | "returnHome" | "homeLeg">,
  home?: TripNode | null,
  hubs: FlightHub[] = [],
  landmassOf?: LandmassOf
): TripRoute {
  const departure = tripDeparture(trip, home);
  const nodes = trip.nodes;
  const legs = tripLegs(nodes, hubs, landmassOf);
  if (nodes.length === 0) return { departure, legs, all: legs };
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const outbound =
    first.cityId !== departure.cityId ? buildLeg(OUTBOUND_LEG, departure, first, hubs, first.travel, landmassOf) : undefined;
  const inbound =
    trip.returnHome !== false && last.cityId !== departure.cityId
      ? buildLeg(RETURN_LEG, last, departure, hubs, trip.homeLeg, landmassOf)
      : undefined;
  const all = [...(outbound ? [outbound] : []), ...legs, ...(inbound ? [inbound] : [])];
  return { departure, outbound, legs, inbound, all };
}

export interface TripTotals {
  /** All legs, every mode. */
  km: number;
  hours: number;
  cost: number;
  legs: number;
  /** Flights only. */
  flights: number;
  flightCost: number;
  flightHours: number;
  /** Train, bus, ferry and drive legs. */
  groundLegs: number;
  groundCost: number;
  groundHours: number;
}

export function tripTotals(legs: TripLeg[]): TripTotals {
  const flights = legs.filter((l) => l.mode === "flight");
  const ground = legs.filter((l) => l.mode !== "flight");
  const sum = (ls: TripLeg[], k: "km" | "hours" | "cost") => ls.reduce((a, l) => a + l[k], 0);
  return {
    km: sum(legs, "km"),
    hours: sum(legs, "hours"),
    cost: sum(legs, "cost"),
    legs: legs.length,
    flights: flights.length,
    flightCost: sum(flights, "cost"),
    flightHours: sum(flights, "hours"),
    groundLegs: ground.length,
    groundCost: sum(ground, "cost"),
    groundHours: sum(ground, "hours"),
  };
}

/**
 * Where a leg's plan is stored: on the stop it arrives at, or `home` for the way back.
 * Returns the stop index, or "home".
 */
export function legPlanSlot(legIndex: number): number | "home" {
  if (legIndex === RETURN_LEG) return "home";
  return legIndex === OUTBOUND_LEG ? 0 : legIndex + 1;
}
