import type { PlaceRef } from "./client";
import { UsageError } from "./args";

/**
 * Reads a place argument:
 * - three uppercase letters: an airport code ({ iata })
 * - lowercase words joined by hyphens, like "lisbon-portugal": a Meridian city id ({ cityId })
 * - anything else: a name to search ({ query })
 */
export function parsePlaceRef(input: string): PlaceRef {
  const value = input.trim();
  if (!value) throw new UsageError("A place is required.");
  if (/^[A-Z]{3}$/.test(value)) return { iata: value };
  if (/^[\p{Ll}\p{N}]+(?:-[\p{Ll}\p{N}]+)+$/u.test(value)) return { cityId: value };
  return { query: value };
}

export function describePlace(place: PlaceRef): string {
  if ("cityId" in place) return place.cityId;
  if ("iata" in place) return place.iata;
  return place.query;
}
