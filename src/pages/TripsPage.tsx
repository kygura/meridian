import { useMemo, useState } from "react";
import { useMeridianStore } from "../store";
import { navigate } from "../lib/router";
import {
  flightPath,
  estimateFlightHours,
  formatHours,
  estimateLegCostUSD,
} from "../lib/geo";
import { TRIP_COLORS, resolveTripColor, randomTripColor } from "../lib/tripColors";
import { findLegBooking, countActiveBookings } from "../lib/bookingApi";
import BookingBadge from "../components/booking/BookingBadge";
import type { City, Trip, TripNode } from "../types";

const STATUS_OPTIONS: Trip["status"][] = ["draft", "scouting", "confirmed"];

function cityToNode(city: City): TripNode {
  return {
    cityId: city.id,
    name: city.name,
    iata: city.iata,
    lat: city.lat,
    lng: city.lng,
  };
}

function flightsUrl(a: TripNode, b: TripNode): string {
  const q = `flights from ${a.iata ?? a.name} to ${b.iata ?? b.name}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function staysUrl(n: TripNode): string {
  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(n.name)}`;
}

/** Airport-first search over the loaded city list. */
function searchLocal(cities: City[], q: string): City[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  return cities
    .filter(
      (c) =>
        c.name.toLowerCase().includes(s) ||
        c.iata?.toLowerCase() === s ||
        c.airportName?.toLowerCase().includes(s) ||
        c.country.toLowerCase().startsWith(s)
    )
    .sort(
      (a, b) => (b.iata ? 1 : 0) - (a.iata ? 1 : 0) || b.population - a.population
    )
    .slice(0, 8);
}

export function CitySearchInput({
  cities,
  placeholder,
  onPick,
  autoFocus,
}: {
  cities: City[];
  placeholder: string;
  onPick: (c: City) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const results = useMemo(() => searchLocal(cities, q), [cities, q]);
  return (
    <div className="tp-search">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {results.length > 0 && (
        <div className="tp-search-results">
          {results.map((c) => (
            <button
              key={c.id}
              className="tp-search-row"
              onClick={() => {
                onPick(c);
                setQ("");
              }}
            >
              <span className="tp-sr-iata">{c.iata ?? "—"}</span>
              <span className="tp-sr-name">{c.name}</span>
              <span className="tp-sr-country">{c.country}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TripsPage({ tripId }: { tripId?: string }) {
  const {
    trips,
    cities,
    createTrip,
    updateTripName,
    updateTripStatus,
    updateTripColor,
    addCityToTrip,
    removeNodeAt,
    replaceNodeAt,
    reorderTripNodes,
    duplicateTrip,
    removeTrip,
    setActiveTrip,
    bookings,
    openBookingModal,
    setBookingsPanelOpen,
  } = useMeridianStore();

  const savedTrips = trips.filter((t) => t.origin !== "agent");
  const trip = savedTrips.find((t) => t.id === tripId) ?? savedTrips[0];
  const [replacingIndex, setReplacingIndex] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hubs = useMemo(
    () =>
      cities
        .filter((c) => c.hub === "large" && c.iata)
        .map((c) => ({ coord: [c.lng, c.lat] as [number, number], label: c.iata! })),
    [cities]
  );

  const legs = useMemo(() => {
    if (!trip) return [];
    const out: {
      from: TripNode;
      to: TripNode;
      km: number;
      hours: number;
      cost: number;
      via?: string;
    }[] = [];
    for (let i = 0; i < trip.nodes.length - 1; i++) {
      const from = trip.nodes[i];
      const to = trip.nodes[i + 1];
      const path = flightPath([from.lng, from.lat], [to.lng, to.lat], hubs);
      out.push({
        from,
        to,
        km: Math.round(path.distanceKm),
        hours: estimateFlightHours(path.distanceKm),
        cost: estimateLegCostUSD(path.distanceKm),
        via: path.via,
      });
    }
    return out;
  }, [trip, hubs]);

  const totals = useMemo(
    () => ({
      km: legs.reduce((a, l) => a + l.km, 0),
      hours: legs.reduce((a, l) => a + l.hours, 0),
      cost: legs.reduce((a, l) => a + l.cost, 0),
    }),
    [legs]
  );

  const selectTrip = (id: string) => {
    setActiveTrip(id);
    navigate(`/trips/${id}`);
  };

  const origin = trip?.nodes[0];
  const last = trip?.nodes[trip.nodes.length - 1];
  const canReturn =
    trip && origin && trip.nodes.length >= 2 && last!.cityId !== origin.cityId;

  return (
    <div className="trips-page">
      {/* Left: trip list */}
      <aside className="tp-list">
        <div className="panel-head">
          <div className="h-title">TRIPS</div>
          <div className="h-meta">{savedTrips.length}</div>
        </div>
        <button
          className="tp-bookings-link"
          onClick={() => setBookingsPanelOpen(true)}
        >
          BOOKINGS ▸ {countActiveBookings(bookings)}
        </button>
        <button className="tm-create-btn" onClick={() => selectTrip(createTrip())}>
          <span className="tm-plus">+</span> NEW TRIP
        </button>
        <div className="tp-list-items">
          {savedTrips.map((t) => (
            <button
              key={t.id}
              className={`tp-list-item ${trip?.id === t.id ? "active" : ""}`}
              onClick={() => selectTrip(t.id)}
            >
              <span
                className="tp-color-dot"
                style={{ background: resolveTripColor(t.color) }}
              />
              <span className="tp-li-name">{t.name}</span>
              <span className="tp-li-meta">{t.nodes.length} stops</span>
            </button>
          ))}
          {savedTrips.length === 0 && (
            <div className="tm-empty-state">
              No trips yet. Create one to start planning.
            </div>
          )}
        </div>
      </aside>

      {/* Right: itinerary detail */}
      {trip ? (
        <section className="tp-detail">
          <header className="tp-head">
            <input
              className="tp-name-input"
              value={trip.name}
              onChange={(e) => updateTripName(trip.id, e.target.value)}
            />
            <div className="tp-head-actions">
              <button className="tm-action-btn" onClick={() => duplicateTrip(trip.id)}>
                DUPLICATE
              </button>
              {confirmDelete ? (
                <>
                  <button
                    className="tm-action-btn tm-delete-confirm"
                    onClick={() => {
                      removeTrip(trip.id);
                      setConfirmDelete(false);
                      navigate("/trips");
                    }}
                  >
                    CONFIRM DELETE
                  </button>
                  <button
                    className="tm-action-btn"
                    onClick={() => setConfirmDelete(false)}
                  >
                    CANCEL
                  </button>
                </>
              ) : (
                <button
                  className="tm-action-btn tm-delete-btn"
                  onClick={() => setConfirmDelete(true)}
                >
                  DELETE
                </button>
              )}
              <button
                className="tm-action-btn"
                onClick={() => {
                  setActiveTrip(trip.id);
                  navigate("/");
                }}
              >
                VIEW ON GLOBE ↗
              </button>
            </div>
          </header>

          {/* Color + status */}
          <div className="tp-controls">
            <div className="tp-control">
              <span className="tm-key">COLOR</span>
              <div className="tm-color-swatches">
                {TRIP_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`tm-swatch ${
                      resolveTripColor(trip.color) === c ? "selected" : ""
                    }`}
                    style={{ background: c }}
                    onClick={() => updateTripColor(trip.id, c)}
                    title={c}
                  />
                ))}
                <button
                  className="tm-swatch tm-swatch-random"
                  title="Random color"
                  onClick={() =>
                    updateTripColor(
                      trip.id,
                      randomTripColor(savedTrips.map((t) => t.color))
                    )
                  }
                >
                  ⚄
                </button>
              </div>
            </div>
            <div className="tp-control">
              <span className="tm-key">STATUS</span>
              <div className="tm-status-options">
                {STATUS_OPTIONS.map((s) => (
                  <button
                    key={s}
                    className={`tm-status-opt ${s} ${trip.status === s ? "selected" : ""}`}
                    onClick={() => updateTripStatus(trip.id, s)}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="tp-totals">
              <span>
                <span className="tm-key">DIST</span> {totals.km.toLocaleString()} km
              </span>
              <span>
                <span className="tm-key">AIR TIME</span> {formatHours(totals.hours)}
              </span>
              <span>
                <span className="tm-key">EST FLIGHTS</span> ~$
                {totals.cost.toLocaleString()}
              </span>
              {trip.estimate && (
                <span>
                  <span className="tm-key">AGENT EST</span> $
                  {trip.estimate.priceEstimate}
                </span>
              )}
            </div>
          </div>

          {/* Itinerary */}
          <div className="tp-itinerary">
            {trip.nodes.map((node, i) => (
              <div key={`${node.cityId}-${i}`}>
                <div className="tp-node">
                  <span className="tm-node-index">{i + 1}</span>
                  <span className="tm-node-iata">{node.iata ?? "???"}</span>
                  {replacingIndex === i ? (
                    <CitySearchInput
                      cities={cities}
                      placeholder={`Replace ${node.name}…`}
                      autoFocus
                      onPick={(c) => {
                        replaceNodeAt(trip.id, i, cityToNode(c));
                        setReplacingIndex(null);
                      }}
                    />
                  ) : (
                    <button
                      className="tp-node-name"
                      title="Click to replace this city"
                      onClick={() => setReplacingIndex(i)}
                    >
                      {node.name}
                    </button>
                  )}
                  <a
                    className="tp-link"
                    href={staysUrl(node)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    STAYS ↗
                  </a>
                  <span className="tp-node-actions">
                    <button
                      disabled={i === 0}
                      onClick={() => reorderTripNodes(trip.id, i, i - 1)}
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      disabled={i === trip.nodes.length - 1}
                      onClick={() => reorderTripNodes(trip.id, i, i + 1)}
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button onClick={() => removeNodeAt(trip.id, i)} title="Remove">
                      ✕
                    </button>
                  </span>
                </div>
                {i < legs.length && (
                  <div className="tp-leg">
                    <span className="tp-leg-line" />
                    <span>{legs[i].km.toLocaleString()} km</span>
                    <span>{formatHours(legs[i].hours)}</span>
                    <span>~${legs[i].cost}</span>
                    {legs[i].via && (
                      <span className="tp-leg-via">via {legs[i].via}</span>
                    )}
                    <a
                      className="tp-link"
                      href={flightsUrl(legs[i].from, legs[i].to)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      FLIGHTS ↗
                    </a>
                    {(() => {
                      // §1.1/§6 — book affordance / booked-leg badge.
                      const legBooking = findLegBooking(bookings, trip.id, i);
                      const bookable = Boolean(
                        legs[i].from.iata && legs[i].to.iata
                      );
                      const showBook =
                        !legBooking || legBooking.status === "cancelled";
                      return (
                        <>
                          {legBooking && <BookingBadge booking={legBooking} />}
                          {showBook && (
                            <button
                              className={`tp-book-btn${bookable ? "" : " disabled"}`}
                              title={bookable ? undefined : "NO AIRPORT ON ROUTE"}
                              onClick={
                                bookable
                                  ? () =>
                                      openBookingModal({
                                        tripId: trip.id,
                                        legIndex: i,
                                        origin: legs[i].from,
                                        dest: legs[i].to,
                                      })
                                  : undefined
                              }
                            >
                              ✈ BOOK
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            ))}
            {trip.nodes.length === 0 && (
              <div className="tm-empty-nodes">
                Add cities to build the itinerary — legs, durations and costs appear
                here.
              </div>
            )}
          </div>

          {/* Add city + return leg */}
          <div className="tp-add-row">
            <CitySearchInput
              cities={cities}
              placeholder="Add a city or airport…"
              onPick={(c) => addCityToTrip(trip.id, cityToNode(c))}
            />
            {canReturn && (
              <button
                className="tm-add-btn"
                onClick={() => addCityToTrip(trip.id, origin!)}
              >
                ↩ RETURN TO {origin!.iata ?? origin!.name}
              </button>
            )}
          </div>
        </section>
      ) : (
        <section className="tp-detail tp-empty">
          <div className="tm-empty-state">Create a trip to start planning.</div>
        </section>
      )}
    </div>
  );
}
