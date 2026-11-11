// Future-dated bookings found by an import (a hotel next month, a flight in March) are not
// memories yet: besides "accept into the journal", the Inbox offers them as itinerary pieces
// of a Trip (ADR 0010): a stay on the stop in that city, or a booking recorded on the leg.
// Pure: this decides what could be offered and what to write; the screen applies it through the store.

import type { ImportCandidate, LegMode, LegPlan, Trip, TripNode } from "../types";
import type { CityIndex } from "./journal";
import type { NodeItinerary } from "./itinerary";

export type TripOffer =
  | { type: "stay"; tripId: string; tripName: string; stopIndex: number; patch: NodeItinerary; label: string }
  | { type: "stay-new"; tripName: string; node: TripNode; year: number; months: { start: number; end: number }; patch: NodeItinerary; label: string }
  | { type: "leg"; tripId: string; tripName: string; slot: number; plan: LegPlan; label: string };

const MODE: Partial<Record<string, LegMode>> = { flight: "flight", train: "train", bus: "bus", ferry: "ferry", car: "drive" };

/** The candidate's own day (YYYY-MM-DD) when it is a booking that can still be planned: a stay or a transport leg. */
export function bookingDay(c: ImportCandidate): string | undefined {
  const p = c.payload;
  if (c.kind === "lodging") return p.arrive?.slice(0, 10);
  if (c.kind === "segment") return p.departAt?.slice(0, 10);
  return undefined;
}

export const isFutureBooking = (c: ImportCandidate, today: string): boolean => {
  const d = bookingDay(c);
  return !!d && d >= today && c.state === "pending";
};

const localTime = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) ? s.slice(0, 16) : undefined);

/**
 * What can be done with a pending, future-dated booking. A stay goes onto the existing stop in
 * that city of a trip planned for that year (when the stop has no stay yet), or into a new trip.
 * A transport booking goes onto the leg arriving at the matching stop, when the leg really runs
 * from the city the booking departs from. Nothing is offered for a city Meridian could not resolve.
 */
export function tripOffers(c: ImportCandidate, trips: Trip[], cities: CityIndex, today: string, home: TripNode): TripOffer[] {
  if (!isFutureBooking(c, today)) return [];
  const p = c.payload;
  const year = Number(bookingDay(c)!.slice(0, 4));
  const mine = trips.filter((t) => t.origin !== "agent" && t.year === year);
  const offers: TripOffer[] = [];

  if (c.kind === "lodging" && p.cityId && p.arrive) {
    const name = p.lodging?.name ?? p.name ?? "Stay";
    const arrive = p.arrive.slice(0, 10);
    const depart = p.depart && p.depart.slice(0, 10) > arrive ? p.depart.slice(0, 10) : undefined;
    const patch: NodeItinerary = {
      arrive,
      ...(depart ? { depart } : {}),
      lodging: { name, ...(p.kind ? { kind: p.kind as never } : {}), checkIn: arrive, ...(depart ? { checkOut: depart } : {}), ...(p.cost ? { cost: p.cost } : {}) },
    };
    for (const t of mine) {
      t.nodes.forEach((n, i) => {
        if (n.cityId === p.cityId && !n.lodging) offers.push({ type: "stay", tripId: t.id, tripName: t.name, stopIndex: i, patch, label: `${t.name}, ${n.name}` });
      });
    }
    const city = cities.get(p.cityId);
    if (city) {
      const month = Number(arrive.slice(5, 7));
      const endMonth = depart ? Number(depart.slice(5, 7)) : month;
      offers.push({
        type: "stay-new",
        tripName: `${city.name} ${arrive.slice(0, 4)}`,
        node: { cityId: city.id, name: city.name, iata: city.iata, lat: city.lat, lng: city.lng },
        year,
        months: { start: month, end: endMonth },
        patch,
        label: "A new trip",
      });
    }
  }

  const mode = c.kind === "segment" ? MODE[p.mode ?? "flight"] : undefined;
  if (c.kind === "segment" && mode && p.fromCityId && p.toCityId) {
    const departAt = localTime(p.departAt);
    const arriveAt = localTime(p.arriveAt);
    for (const t of mine) {
      t.nodes.forEach((n, i) => {
        if (n.cityId !== p.toCityId || n.travel?.booked) return;
        const from = i === 0 ? (t.departure ?? home).cityId : t.nodes[i - 1].cityId;
        if (from !== p.fromCityId) return;
        const booked = {
          ...(p.carrier ? { carrier: p.carrier } : {}),
          ...(p.number ? { number: p.number } : {}),
          ...(p.bookingRef ? { reference: p.bookingRef } : {}),
          ...(p.cost ? { cost: p.cost } : {}),
          ...(departAt ? { departAt } : {}),
          ...(arriveAt ? { arriveAt } : {}),
        };
        offers.push({ type: "leg", tripId: t.id, tripName: t.name, slot: i, plan: { fromCityId: from, mode, booked }, label: `${t.name}, to ${n.name}` });
      });
    }
  }
  return offers;
}
