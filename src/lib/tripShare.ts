// What a shared trip link shows (ADR 0010). The shared view is built from a stripped copy
// of the trip, so anything not copied here cannot leak: no booking references, prices,
// links, notes, traveller count, trip id, or anything from the journal or Bookings.

import { seasonText, spanLabel, isMonthSpan } from "./season";
import { tripRoute, type LandmassOf, type TripLeg } from "./legs";
import { dayByDay, isIsoDate, legDate, stopNights, type DayGroup } from "./itinerary";
import { isLocalDateTime } from "./zoned";
import type { LegMode, LegPlan, Trip, TripNode } from "../types";

function publicPlan(p: LegPlan | undefined): LegPlan | undefined {
  if (!p) return undefined;
  const b = p.booked;
  const booked = b ? { carrier: b.carrier, number: b.number, departAt: b.departAt, arriveAt: b.arriveAt } : undefined;
  return { fromCityId: p.fromCityId, mode: p.mode, booked };
}

function publicNode(n: TripNode): TripNode {
  return {
    cityId: n.cityId,
    name: n.name,
    iata: n.iata,
    lat: n.lat,
    lng: n.lng,
    months: n.months,
    arrive: n.arrive,
    depart: n.depart,
    lodging: n.lodging
      ? { name: n.lodging.name, address: n.lodging.address, checkIn: n.lodging.checkIn, checkOut: n.lodging.checkOut }
      : undefined,
    activities: n.activities?.map((a) => ({ id: a.id, title: a.title, date: a.date, time: a.time })),
    travel: publicPlan(n.travel),
  };
}

/** A copy of the trip holding only what a shared link may show. */
export function publicTrip(trip: Trip): Trip {
  return {
    id: "shared",
    name: trip.name,
    color: trip.color,
    status: trip.status,
    nodes: trip.nodes.map(publicNode),
    season: trip.season,
    year: trip.year,
    departure: trip.departure ? publicNode(trip.departure) : undefined,
    returnHome: trip.returnHome,
    homeLeg: publicPlan(trip.homeLeg),
  };
}

export interface SharedStop {
  name: string;
  arrive?: string;
  depart?: string;
  nights?: number;
  /** "Feb–Mar" when the stop is only placed by month. */
  months?: string;
  stay?: { name: string; address?: string };
  activities: number;
}

export interface SharedLeg {
  from: string;
  to: string;
  mode: LegMode;
  date?: string;
  /** Local wall-clock times, as recorded. */
  departAt?: string;
  arriveAt?: string;
  carrier?: string;
  number?: string;
  booked: boolean;
}

export interface SharedTrip {
  name: string;
  /** "Feb–Jul 2027", "Feb–Jul · any year", or null. */
  when: string | null;
  from: string;
  stops: SharedStop[];
  legs: SharedLeg[];
  days: DayGroup[];
}

function sharedLeg(trip: Trip, leg: TripLeg, booked: boolean): SharedLeg {
  const r = leg.record;
  return {
    from: leg.from.name,
    to: leg.to.name,
    mode: leg.mode,
    date: legDate(trip, leg),
    departAt: isLocalDateTime(r?.departAt) ? r!.departAt : undefined,
    arriveAt: isLocalDateTime(r?.arriveAt) ? r!.arriveAt : undefined,
    carrier: r?.carrier,
    number: r?.number,
    booked,
  };
}

/** The read-only itinerary behind a share link. `home` is the owner's default departure. */
export function buildSharedTrip(trip: Trip, home?: TripNode | null, landmassOf?: LandmassOf): SharedTrip {
  const t = publicTrip(trip);
  const route = tripRoute(t, home ? publicNode(home) : null, [], landmassOf);
  // Whether a leg is booked is the one thing read from the full trip: a booking recorded
  // with only a reference or a price has nothing left once those are stripped.
  const booked = new Set(
    tripRoute(trip, home, [], landmassOf)
      .all.filter((l) => l.record)
      .map((l) => l.index)
  );
  const days = dayByDay(t, route).groups.map((g) => ({
    ...g,
    items: g.items.map((i) => (i.kind === "leg" ? { ...i, booked: booked.has(i.leg ?? NaN) } : i)),
  }));
  return {
    name: t.name,
    when: seasonText(t),
    from: route.departure.name,
    stops: t.nodes.map((n) => ({
      name: n.name,
      arrive: isIsoDate(n.arrive) ? n.arrive : undefined,
      depart: isIsoDate(n.depart) ? n.depart : undefined,
      nights: stopNights(n) ?? undefined,
      months: isMonthSpan(n.months) ? spanLabel(n.months) : undefined,
      stay: n.lodging ? { name: n.lodging.name, address: n.lodging.address } : undefined,
      activities: n.activities?.length ?? 0,
    })),
    legs: route.all.map((l) => sharedLeg(t, l, booked.has(l.index))),
    days,
  };
}
