import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMeridianStore } from "../../../store";
import { navigate } from "../../../lib/router";
import { TRIP_COLORS, resolveTripColor } from "../../../lib/tripColors";
import {
  bookedLegCount,
  copyTripName,
  displayTripName,
  STATUS_LABEL,
  tripDateRange,
  tripRoute,
  tripTotals,
} from "../../../lib/tripPlan";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Segmented,
  Select,
  toast,
  useIsDesktop,
} from "../../../ui";
import { IconCopy, IconMap, IconSparkle, IconTrash, IconTrips } from "../../../ui/icons";
import type { Trip } from "../../../types";
import { useCityIndex, useHubs, useLandmass } from "./parts";
import { ItineraryCard } from "./itinerary";
import { SharingCard } from "./sharing";
import { CostsCard } from "./costs";
import { findLegBooking } from "../../../lib/bookingApi";
import StopList from "./StopList";
import { dismissCandidate } from "./suggestions";
import "./upcoming.css";
import { SeasonCard } from "./season";
import { seasonText } from "../../../lib/season";
import { DepartureCard } from "./departure";
import { RiskCard } from "./risk";
import { EntryCard } from "./entry";

export interface TripEditorProps {
  /** Trip id from #/trips/plan/<tripId> (useMeridianStore.trips[].id). */
  tripId: string;
}

const COLOR_NAMES = [
  "Vermilion",
  "Teal",
  "Violet",
  "Ochre",
  "Cobalt",
  "Magenta",
  "Olive",
  "Petrol",
  "Rust",
  "Brass",
  "Forest",
  "Indigo",
];

const STATUSES: Trip["status"][] = ["draft", "scouting", "confirmed"];

/** Planned trip editor (#/trips/plan/<tripId>). Owns its PageHeader. Remounts per tripId. */
export default function TripEditor({ tripId }: TripEditorProps) {
  const trip = useMeridianStore((s) => s.trips.find((t) => t.id === tripId));
  const bookings = useMeridianStore((s) => s.bookings);
  const hubs = useHubs();
  const landmassOf = useLandmass();
  const cityIdx = useCityIndex();
  const home = useMeridianStore((s) => s.homeDeparture);
  const isDesktop = useIsDesktop();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Highlight this trip on the map while editing.
  useEffect(() => {
    if (trip) useMeridianStore.getState().setActiveTrip(trip.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, Boolean(trip)]);

  const route = useMemo(() => (trip ? tripRoute(trip, home, hubs, landmassOf) : null), [trip, home, hubs, landmassOf]);
  const totals = tripTotals(route?.all ?? []);

  if (!trip || !route) {
    return (
      <>
        <PageHeader title="Trip" back={{ label: "Trips", href: "#/trips" }} />
        <EmptyState
          size="page"
          icon={<IconTrips />}
          title="This trip isn't here any more"
          description="It may have been deleted, or it was a suggestion that was dismissed."
          action={<Button onClick={() => navigate({ view: "trips", tab: "upcoming" })}>Back to trips</Button>}
        />
      </>
    );
  }

  const name = displayTripName(trip.name);
  const suggested = trip.origin === "agent";
  const booked = bookedLegCount(trip, bookings, route.all);
  // Real bookings are the ones recorded by hand; test bookings are counted apart.
  const recorded = route.all.filter((l) => l.record).length;
  const testBooked = route.all.filter((l) => !l.record && findLegBooking(bookings, trip.id, l.index)?.status === "booked").length;
  const range = seasonText(trip) ?? tripDateRange(trip);

  const duplicate = () => {
    const s = useMeridianStore.getState();
    const id = s.duplicateTrip(trip.id);
    s.updateTripName(id, copyTripName(trip.name));
    toast(`Made a copy of ${name}`, { tone: "success" });
    navigate({ view: "trips", tab: "upcoming", tripId: id });
  };

  const showOnMap = () => {
    useMeridianStore.getState().setActiveTrip(trip.id);
    navigate("/");
  };

  const doDelete = () => {
    useMeridianStore.getState().removeTrip(trip.id);
    setConfirmDelete(false);
    toast(`Deleted ${name}`);
    navigate({ view: "trips", tab: "upcoming" });
  };

  const actions = suggested ? null : isDesktop ? (
    <>
      <Button variant="ghost" icon={<IconMap size={16} />} onClick={showOnMap}>
        Show on map
      </Button>
      <Button icon={<IconCopy size={16} />} onClick={duplicate}>
        Duplicate
      </Button>
      <Button variant="danger-outline" icon={<IconTrash size={16} />} onClick={() => setConfirmDelete(true)}>
        Delete
      </Button>
    </>
  ) : (
    <>
      <IconButton label="Show on map" icon={<IconMap />} onClick={showOnMap} />
      <IconButton label="Duplicate trip" icon={<IconCopy />} onClick={duplicate} />
      <IconButton label="Delete trip" icon={<IconTrash />} variant="danger-outline" onClick={() => setConfirmDelete(true)} />
    </>
  );

  return (
    <div className="trips-ed">
      <PageHeader
        kicker="Planned trip"
        title={name}
        subtitle={range ?? undefined}
        back={{ label: "Trips", href: "#/trips" }}
        actions={actions}
      />

      {suggested ? (
        <Card className="trips-ed-notice">
          <span className="trips-ed-notice-icon" aria-hidden="true">
            <IconSparkle />
          </span>
          <p className="trips-ed-notice-text">This is a suggested trip. Keep it to save it to your trips.</p>
          <div className="trips-ed-notice-actions">
            <Button
              variant="primary"
              onClick={() => {
                useMeridianStore.getState().confirmCandidate(trip.id);
                toast(`${name} added to your trips`, { tone: "success" });
              }}
            >
              Keep
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                dismissCandidate(trip.id);
                navigate({ view: "trips", tab: "upcoming" });
              }}
            >
              Dismiss
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="trips-ed-layout">
        <div className="trips-ed-main">
          <Card className="trips-ed-card">
            <div className="trips-ed-card-head">
              <h2 className="ui-section-title">Route</h2>
              <span className="trips-ed-card-sub tabular">
                {trip.nodes.length} {trip.nodes.length === 1 ? "stop" : "stops"}
              </span>
            </div>
            <StopList trip={trip} route={route} />
          </Card>

          <Card className="trips-ed-card">
            <div className="trips-ed-card-head">
              <h2 className="ui-section-title">Day by day</h2>
              {trip.year ? <span className="trips-ed-card-sub tabular">{trip.year}</span> : null}
            </div>
            <ItineraryCard trip={trip} route={route} cityIdx={cityIdx} />
          </Card>
        </div>

        <div className="trips-ed-side">
          <Card className="trips-ed-card">
            <h2 className="ui-section-title">Details</h2>
            <NameField trip={trip} />
            <div className="trips-ed-field">
              <span className="trips-ed-label" id={`trips-ed-color-${trip.id}`}>
                Colour
              </span>
              <ColorPicker trip={trip} labelledBy={`trips-ed-color-${trip.id}`} />
            </div>
            <div className="trips-ed-field">
              <span className="trips-ed-label">Status</span>
              <Segmented<Trip["status"]>
                label="Trip status"
                value={trip.status}
                block
                onChange={(s) => useMeridianStore.getState().updateTripStatus(trip.id, s)}
                options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
              />
            </div>
            <Field label="Travellers" hint="Used to fill in flight and stay searches.">
              <Select
                value={String(trip.travellers ?? 1)}
                options={[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ value: String(n), label: String(n) }))}
                onChange={(e) => useMeridianStore.getState().setTripTravellers(trip.id, Number(e.target.value))}
              />
            </Field>
          </Card>

          <Card className="trips-ed-card">
            <h2 className="ui-section-title">Departing from</h2>
            <DepartureCard trip={trip} />
          </Card>

          <Card className="trips-ed-card">
            <h2 className="ui-section-title">Risk</h2>
            <RiskCard trip={trip} route={route} />
          </Card>

          <Card className="trips-ed-card">
            <h2 className="ui-section-title">Entry and visas</h2>
            <EntryCard trip={trip} />
          </Card>

          <Card className="trips-ed-card">
            <h2 className="ui-section-title">Season</h2>
            <SeasonCard trip={trip} />
          </Card>

          {!suggested ? (
            <Card className="trips-ed-card">
              <h2 className="ui-section-title">Calendar and sharing</h2>
              <SharingCard trip={trip} route={route} cityIdx={cityIdx} />
            </Card>
          ) : null}

          <Card className="trips-ed-card">
            <h2 className="ui-section-title">Costs</h2>
            <CostsCard trip={trip} route={route} totals={totals} recorded={recorded} testBooked={testBooked} cityIdx={cityIdx} />
          </Card>
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        role="alertdialog"
        title={`Delete ${name}?`}
        description={
          booked > 0
            ? "The trip and its route are removed. Your flight bookings stay in Flights."
            : "The trip and its route are removed. This can't be undone."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={doDelete}>
              Delete trip
            </Button>
          </>
        }
      />
    </div>
  );
}

function NameField({ trip }: { trip: Trip }) {
  const [value, setValue] = useState(() => displayTripName(trip.name));
  return (
    <Field label="Name">
      <Input
        value={value}
        maxLength={80}
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value.trim()) useMeridianStore.getState().updateTripName(trip.id, e.target.value);
        }}
        onBlur={() => {
          const v = value.trim() || "Untitled trip";
          setValue(v);
          useMeridianStore.getState().updateTripName(trip.id, v);
        }}
      />
    </Field>
  );
}

function ColorPicker({ trip, labelledBy }: { trip: Trip; labelledBy: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = resolveTripColor(trip.color);
  const selected = Math.max(0, TRIP_COLORS.indexOf(current));
  const set = (i: number) => useMeridianStore.getState().updateTripColor(trip.id, TRIP_COLORS[i]);

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (i + dir + TRIP_COLORS.length) % TRIP_COLORS.length;
    set(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="trips-ed-swatches" role="radiogroup" aria-labelledby={labelledBy}>
      {TRIP_COLORS.map((c, i) => {
        const on = c === current;
        return (
          <button
            key={c}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={COLOR_NAMES[i] ?? `Colour ${i + 1}`}
            title={COLOR_NAMES[i]}
            tabIndex={i === selected ? 0 : -1}
            className={on ? "trips-ed-swatch is-on" : "trips-ed-swatch"}
            onClick={() => set(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className="trips-ed-swatch-dot" style={{ background: c }} />
          </button>
        );
      })}
    </div>
  );
}
