// What the trip costs, in the editor's side column (ADR 0010). Prices you entered are
// shown exactly as entered, per currency. Everything else is an estimate and says how it
// was made; where there is no real basis for one, it says "not estimated".

import { useMemo } from "react";
import { useMeridianStore } from "../../../store";
import { stopNights, sumsEmpty, tripCosts, type Sums } from "../../../lib/itinerary";
import { FLIGHT_METHOD, GROUND_DETOUR, type TripRoute, type TripTotals } from "../../../lib/legs";
import { estimateLodging, pastNights } from "../../../lib/lodgingEstimate";
import { formatFlightTime, formatKm, formatUSD } from "../../../lib/tripPlan";
import { Stat } from "../../../ui";
import type { City, Trip } from "../../../types";
import { useTripMoney } from "./money";
import { MockBadge } from "./parts";

/** "€320 + $40": each currency as entered, never added together. */
export function formatSums(s: Sums): string {
  return Object.entries(s)
    .map(([currency, amount]) => formatUSD(amount, currency))
    .join(" + ");
}

export function CostsCard({
  trip,
  route,
  totals,
  recorded,
  testBooked,
  cityIdx,
}: {
  trip: Trip;
  route: TripRoute;
  totals: TripTotals;
  /** Legs with a booking recorded by hand. */
  recorded: number;
  /** Legs with a live test booking only. */
  testBooked: number;
  cityIdx: Map<string, City>;
}) {
  const money = useTripMoney();
  const journeys = useMeridianStore((s) => s.journeys);
  const costs = useMemo(() => tripCosts(trip, route), [trip, route]);
  const past = useMemo(() => pastNights(journeys), [journeys]);

  // Stays with nights but no price: estimate from the journal where it has a basis.
  const stays = useMemo(() => {
    let eur = 0;
    const methods = new Set<string>();
    const without: string[] = [];
    for (const i of costs.lodgingMissing) {
      const n = trip.nodes[i];
      const est = estimateLodging(n, stopNights(n) ?? 0, past, (id) => cityIdx.get(id)?.country);
      if (est) {
        eur += est.eur;
        methods.add(est.method);
      } else without.push(n.name);
    }
    return { eur, methods: [...methods], without };
  }, [costs.lodgingMissing, trip.nodes, past, cityIdx]);

  const unpricedFlights = route.all.filter((l) => l.mode === "flight" && !l.record?.cost).length;
  const unpricedGround = route.all.filter((l) => l.mode !== "flight" && !l.record?.cost).length;
  const hasStays = !sumsEmpty(costs.lodgingEntered) || costs.lodgingMissing.length > 0;

  return (
    <div className="trips-ed-stats trips-costs">
      {totals.flights > 0 ? (
        <Stat
          label="Flights"
          value={unpricedFlights > 0 ? <>about {money(costs.flightEstimate)}</> : "—"}
          hint={
            unpricedFlights > 0 ? (
              <span title={FLIGHT_METHOD}>
                Rough estimate for {unpricedFlights} {unpricedFlights === 1 ? "flight" : "flights"} with no recorded price: distance × $0.11 per km + $45
                each. Not a fare.
              </span>
            ) : (
              "Every flight has a recorded price."
            )
          }
        />
      ) : null}
      {totals.groundLegs > 0 ? (
        <Stat
          label="Train, bus, ferry, road"
          value={unpricedGround > 0 ? <>about {money(costs.groundEstimate)}</> : "—"}
          hint={
            unpricedGround > 0
              ? `Rough estimate for ${unpricedGround} ${unpricedGround === 1 ? "leg" : "legs"}: straight-line distance × ${GROUND_DETOUR} at a typical rate per km for the mode. Not a fare.`
              : "Every leg has a recorded price."
          }
        />
      ) : null}
      {!sumsEmpty(costs.transportEntered) ? (
        <Stat label="Transport booked" value={formatSums(costs.transportEntered)} hint="Prices you recorded, as entered." />
      ) : null}
      {hasStays ? (
        <Stat
          label="Stays"
          className="trips-costs-wide"
          value={
            <>
              {!sumsEmpty(costs.lodgingEntered) ? formatSums(costs.lodgingEntered) : null}
              {!sumsEmpty(costs.lodgingEntered) && stays.eur > 0 ? " + " : null}
              {stays.eur > 0 ? <>about {formatUSD(stays.eur, "EUR")}</> : null}
              {sumsEmpty(costs.lodgingEntered) && stays.eur === 0 ? "Not estimated" : null}
            </>
          }
          hint={
            <>
              {!sumsEmpty(costs.lodgingEntered) ? "Prices you entered. " : null}
              {stays.methods.join(" ")}
              {stays.without.length
                ? ` ${stays.eur > 0 || !sumsEmpty(costs.lodgingEntered) ? "Not estimated" : "No price entered"} for ${stays.without.join(", ")}: Meridian has no real accommodation prices for ${stays.without.length === 1 ? "it" : "them"}, and your journal has no past stays to go on.`
                : null}
            </>
          }
        />
      ) : null}
      {!sumsEmpty(costs.activitiesEntered) ? <Stat label="Activities" value={formatSums(costs.activitiesEntered)} hint="Costs you entered." /> : null}
      <Stat label="Time travelling" value={totals.legs > 0 ? formatFlightTime(totals.hours) : "—"} hint={totals.groundLegs > 0 ? `${formatFlightTime(totals.flightHours)} of it in the air` : undefined} />
      <Stat label="Distance" value={totals.legs > 0 ? formatKm(totals.km) : "—"} />
      <Stat
        label="Booked"
        value={
          <span className="tabular">
            {recorded} of {totals.legs}
          </span>
        }
        hint={
          <>
            {totals.legs === 1 ? "leg" : "legs"}, from bookings you recorded
            {testBooked > 0 ? `. ${testBooked} test ${testBooked === 1 ? "booking doesn't" : "bookings don't"} count: no ticket was issued.` : ""}
          </>
        }
      />
      {trip.estimate ? (
        <Stat label="Suggested price" value={money(trip.estimate.priceEstimate, trip.estimate.currency)} hint={<MockBadge trip={trip} />} />
      ) : null}
    </div>
  );
}
