// What a stay might cost, when no price has been entered (ADR 0010).
//
// Meridian has no real per-city accommodation prices (the map's "cost" layer is
// synthesized, so it is not used here). The only real basis it holds is the owner's own
// journal: what past stays actually cost per night. So a stop is estimated only when the
// journal has stays in the same city, or at least two in the same country; anything else
// is "not estimated" rather than a made-up number.

import { daysBetween } from "./itinerary";
import type { Journey } from "../types";

export interface PastNight {
  cityId: string;
  /** EUR per night, from the journal's ECB-converted lodging cost. */
  eurPerNight: number;
}

/** Every journal stay with a known cost and at least one night. */
export function pastNights(journeys: Journey[] | null | undefined): PastNight[] {
  const out: PastNight[] = [];
  for (const j of journeys ?? []) {
    for (const s of j.stops) {
      const eur = s.lodging?.cost?.eur;
      const nights = daysBetween(s.arrive, s.depart);
      if (!eur || !(eur > 0) || !(nights > 0)) continue;
      out.push({ cityId: s.cityId, eurPerNight: eur / nights });
    }
  }
  return out;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface LodgingEstimate {
  /** EUR for the whole stay. */
  eur: number;
  eurPerNight: number;
  /** Past stays the figure rests on. */
  stays: number;
  scope: "city" | "country";
  /** The method, in plain words, shown with the number. */
  method: string;
}

/** Stays needed in a country before its median is used for another city there. */
export const MIN_COUNTRY_STAYS = 2;

export function estimateLodging(
  stop: { cityId: string; name: string },
  nights: number,
  past: PastNight[],
  countryOf: (cityId: string) => string | undefined
): LodgingEstimate | null {
  if (!(nights > 0)) return null;
  const inCity = past.filter((p) => p.cityId === stop.cityId);
  if (inCity.length >= 1) {
    const per = median(inCity.map((p) => p.eurPerNight));
    return {
      eur: Math.round(per * nights),
      eurPerNight: per,
      stays: inCity.length,
      scope: "city",
      method: `Estimate: the median of what your ${inCity.length} past ${inCity.length === 1 ? "stay" : "stays"} in ${stop.name} cost per night (from your journal), times ${nights} nights.`,
    };
  }
  const country = countryOf(stop.cityId);
  if (!country) return null;
  const inCountry = past.filter((p) => countryOf(p.cityId) === country);
  if (inCountry.length < MIN_COUNTRY_STAYS) return null;
  const per = median(inCountry.map((p) => p.eurPerNight));
  return {
    eur: Math.round(per * nights),
    eurPerNight: per,
    stays: inCountry.length,
    scope: "country",
    method: `Estimate: the median of what your ${inCountry.length} past stays in ${country} cost per night (from your journal), times ${nights} nights.`,
  };
}
