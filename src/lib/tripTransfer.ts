import type { Trip, TripNode } from "../types";
import { isMonthSpan } from "./season";

/** File format for moving trips between browsers: Settings › Trips › Export / Import. */
export const TRIP_FILE_KIND = "meridian-trips";
export const TRIP_FILE_VERSION = 1;

export interface TripFile {
  kind: typeof TRIP_FILE_KIND;
  version: number;
  exportedAt: string;
  trips: Trip[];
}

const STATUSES: Trip["status"][] = ["draft", "scouting", "confirmed"];

function isNode(n: unknown): n is TripNode {
  if (!n || typeof n !== "object") return false;
  const o = n as Record<string, unknown>;
  return (
    typeof o.cityId === "string" &&
    typeof o.name === "string" &&
    typeof o.lat === "number" &&
    typeof o.lng === "number" &&
    (o.iata === undefined || typeof o.iata === "string") &&
    (o.months === undefined || isMonthSpan(o.months))
  );
}

function toTrip(t: unknown): Trip | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || typeof o.name !== "string" || !Array.isArray(o.nodes)) return null;
  if (!o.nodes.every(isNode)) return null;
  return {
    id: o.id,
    name: o.name,
    color: typeof o.color === "string" ? o.color : "#1d4ed8",
    status: STATUSES.includes(o.status as Trip["status"]) ? (o.status as Trip["status"]) : "draft",
    nodes: (o.nodes as TripNode[]).map(({ cityId, name, iata, lat, lng, months }) =>
      months ? { cityId, name, iata, lat, lng, months: { start: months.start, end: months.end } } : { cityId, name, iata, lat, lng }
    ),
    origin: "manual",
    ...(isMonthSpan(o.season) ? { season: { start: o.season.start, end: o.season.end } } : {}),
    ...(Number.isInteger(o.year) && (o.year as number) >= 2000 && (o.year as number) <= 2100 ? { year: o.year as number } : {}),
  };
}

/** Serialize user-owned trips (agent candidates are left out, as in persistence). */
export function serializeTrips(trips: Trip[], now = new Date()): string {
  const file: TripFile = {
    kind: TRIP_FILE_KIND,
    version: TRIP_FILE_VERSION,
    exportedAt: now.toISOString(),
    trips: trips.filter((t) => t.origin !== "agent").map(({ estimate: _e, ...t }) => t),
  };
  return JSON.stringify(file, null, 2);
}

/** Parse a trips file. Accepts the export format or a bare array of trips. Throws on bad input. */
export function parseTripFile(text: string): Trip[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  let raw: unknown[];
  if (Array.isArray(data)) raw = data;
  else if (data && typeof data === "object" && (data as Record<string, unknown>).kind === TRIP_FILE_KIND) {
    const trips = (data as Record<string, unknown>).trips;
    if (!Array.isArray(trips)) throw new Error("The file has no trips list.");
    raw = trips;
  } else throw new Error("That isn't a Meridian trips file.");
  const trips = raw.map(toTrip);
  const bad = trips.filter((t) => t === null).length;
  if (bad) throw new Error(`${bad} trip${bad === 1 ? " is" : "s are"} malformed; nothing was imported.`);
  return trips as Trip[];
}

/** Imported trips replace existing ones with the same id; the rest are appended in file order. */
export function mergeTrips(existing: Trip[], incoming: Trip[]): { trips: Trip[]; added: number; replaced: number } {
  const byId = new Map(incoming.map((t) => [t.id, t]));
  let replaced = 0;
  const trips = existing.map((t) => {
    const next = byId.get(t.id);
    if (!next) return t;
    byId.delete(t.id);
    replaced++;
    return next;
  });
  const added = [...byId.values()];
  return { trips: [...trips, ...added], added: added.length, replaced };
}
