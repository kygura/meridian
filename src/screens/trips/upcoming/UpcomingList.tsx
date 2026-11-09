import { useMemo } from "react";
import { useMeridianStore } from "../../../store";
import { hrefFor, navigate } from "../../../lib/router";
import {
  bookedLegCount,
  displayTripName,
  nextTripName,
  stopChain,
  tripDateRange,
  tripDays,
  tripRoute,
  tripTotals,
} from "../../../lib/tripPlan";
import { Button, Card, EmptyState, PageActions } from "../../../ui";
import { IconPlane, IconPlus, IconTrips } from "../../../ui/icons";
import type { Trip } from "../../../types";
import type { FlightHub } from "../../../lib/geo";
import type { Booking } from "../../../lib/bookingApi";
import { StatusBadge, TripDot, useHubs } from "./parts";
import { seasonText } from "../../../lib/season";
import Suggested from "./Suggested";
import SavedPlaces from "./SavedPlaces";
import "./upcoming.css";
import { useTripMoney } from "./money";

/**
 * Trips › Upcoming (#/trips): planned trips, agent suggestions and saved places.
 * The Trips header, Segmented and Page come from TripsScreen; the primary action
 * (New trip) goes into the header through <PageActions>.
 */
export default function UpcomingList() {
  const trips = useMeridianStore((s) => s.trips);
  const bookings = useMeridianStore((s) => s.bookings);
  const hubs = useHubs();
  const planned = useMemo(() => trips.filter((t) => t.origin !== "agent"), [trips]);

  const newTrip = () => {
    const store = useMeridianStore.getState();
    const id = store.createTrip(nextTripName(store.trips.filter((t) => t.origin !== "agent")));
    navigate({ view: "trips", tab: "upcoming", tripId: id });
  };

  return (
    <div className="trips-up">
      <PageActions>
        <Button variant="primary" icon={<IconPlus />} onClick={newTrip}>
          New trip
        </Button>
      </PageActions>

      <div className="trips-up-main">
        <Suggested />

        <section className="trips-up-section" aria-labelledby="trips-up-planned">
          <div className="trips-up-section-head">
            <div className="trips-up-section-titles">
              <h2 id="trips-up-planned" className="trips-up-h2">
                Planned trips
              </h2>
              {planned.length > 0 ? (
                <p className="trips-up-section-sub">
                  {planned.length} {planned.length === 1 ? "trip" : "trips"}
                </p>
              ) : null}
            </div>
          </div>

          {planned.length === 0 ? (
            <Card>
              <EmptyState
                icon={<IconTrips />}
                title="No planned trips yet"
                description="Start a trip and add cities to see legs, flight times and costs."
                action={
                  <Button icon={<IconPlus size={16} />} onClick={newTrip}>
                    New trip
                  </Button>
                }
              />
            </Card>
          ) : (
            <ul className="trips-up-grid" role="list">
              {planned.map((t) => (
                <li key={t.id}>
                  <TripCard trip={t} hubs={hubs} bookings={bookings} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className="trips-up-side">
        <SavedPlaces />
      </aside>
    </div>
  );
}

function TripCard({ trip, hubs, bookings }: { trip: Trip; hubs: FlightHub[]; bookings: Booking[] }) {
  const home = useMeridianStore((s) => s.homeDeparture);
  const route = useMemo(() => tripRoute(trip, home, hubs), [trip, home, hubs]);
  const totals = tripTotals(route.all);
  const money = useTripMoney();
  const booked = bookedLegCount(trip, bookings, route.all);
  const range = tripDateRange(trip);
  const days = tripDays(trip);
  const season = seasonText(trip);
  const name = displayTripName(trip.name);
  const stops = trip.nodes.length;

  return (
    <Card interactive className="trips-up-card">
      <div className="trips-up-card-title">
        <TripDot color={trip.color} />
        <h3 className="trips-up-name">
          <a className="trips-up-card-link" href={hrefFor({ view: "trips", tab: "upcoming", tripId: trip.id })}>
            {name}
          </a>
        </h3>
        <StatusBadge status={trip.status} />
      </div>
      <p className="trips-up-chain">
        {stops > 0 ? stopChain([route.departure, ...trip.nodes, ...(route.inbound ? [route.departure] : [])]) : "No stops yet"}
      </p>
      <div className="trips-up-meta">
        {season ? <span className="trips-up-season">{season}</span> : null}
        <span className="tabular">
          {range && !season
            ? `${range}${days !== null ? ` · ${days} ${days === 1 ? "day" : "days"}` : ""}`
            : `${stops} ${stops === 1 ? "stop" : "stops"}`}
        </span>
        {totals.legs > 0 ? (
          <span>
            About <span className="tabular">{money(totals.cost)}</span> in flights
          </span>
        ) : null}
        {totals.legs > 0 ? (
          <span className={booked > 0 ? "trips-up-booked-count is-booked" : "trips-up-booked-count"}>
            <IconPlane size={14} />
            <span className="tabular">
              {booked} of {totals.legs}
            </span>{" "}
            booked
          </span>
        ) : null}
      </div>
    </Card>
  );
}
