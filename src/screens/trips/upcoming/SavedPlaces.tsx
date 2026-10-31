import { useRef, useState } from "react";
import { useMeridianStore } from "../../../store";
import { openCity } from "../../../shell/uiStore";
import { apiUrl } from "../../../lib/api";
import { navigate } from "../../../lib/router";
import { displayTripName, nextTripName, shortlistToNode } from "../../../lib/tripPlan";
import { Button, Card, EmptyState, IconButton, Popover, toast, useIsDesktop } from "../../../ui";
import { IconClose, IconMap, IconPin, IconPlus, IconSparkle } from "../../../ui/icons";
import type { ShortlistEntry } from "../../../types";
import { TripDot } from "./parts";
import { useSuggestStore } from "./suggestions";

/** Compact list of shortlisted cities with add-to-trip. */
export default function SavedPlaces() {
  const shortlist = useMeridianStore((s) => s.shortlist);

  return (
    <section className="trips-up-section" aria-labelledby="trips-up-saved">
      <div className="trips-up-section-head">
        <div className="trips-up-section-titles">
          <h2 id="trips-up-saved" className="trips-up-h2">
            Saved places
          </h2>
          {shortlist.length > 0 ? (
            <p className="trips-up-section-sub">
              {shortlist.length} {shortlist.length === 1 ? "place" : "places"} to plan around
            </p>
          ) : null}
        </div>
      </div>
      {shortlist.length === 0 ? (
        <Card padding="sm">
          <EmptyState
            icon={<IconPin />}
            title="No saved places yet"
            description="Save cities from the map to plan trips around them."
            action={
              <Button icon={<IconMap size={16} />} onClick={() => navigate("/")}>
                Open map
              </Button>
            }
          />
        </Card>
      ) : (
        <Card padding="none">
          <ul className="trips-up-places" role="list">
            {shortlist.map((e) => (
              <PlaceRow key={e.cityId} entry={e} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function PlaceRow({ entry }: { entry: ShortlistEntry }) {
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const trips = useMeridianStore((s) => s.trips);
  const suggestStatus = useSuggestStore((s) => s.status);
  const manual = trips.filter((t) => t.origin !== "agent");

  const addTo = (tripId: string, tripName: string) => {
    useMeridianStore.getState().addCityToTrip(tripId, shortlistToNode(entry));
    setOpen(false);
    toast(`Added ${entry.name} to ${displayTripName(tripName)}`, {
      tone: "success",
      action: { label: "Open", onClick: () => navigate({ view: "trips", tab: "upcoming", tripId }) },
    });
  };

  const addToNew = () => {
    const store = useMeridianStore.getState();
    const id = store.createTrip(nextTripName(store.trips.filter((t) => t.origin !== "agent")));
    store.addCityToTrip(id, shortlistToNode(entry));
    setOpen(false);
    navigate({ view: "trips", tab: "upcoming", tripId: id });
  };

  const remove = () => {
    const store = useMeridianStore.getState();
    const prev = store.shortlist;
    store.removeFromShortlist(entry.cityId);
    fetch(apiUrl(`/api/shortlist/${encodeURIComponent(entry.cityId)}`), { method: "DELETE" })
      .then((r) => {
        if (!r.ok && r.status !== 404) throw new Error(String(r.status));
        toast(`Removed ${entry.name} from saved places`);
      })
      .catch(() => {
        useMeridianStore.getState().setShortlist(prev);
        toast(`Couldn't remove ${entry.name}`, { tone: "danger" });
      });
  };

  return (
    <li className="trips-up-place">
      <button type="button" className="trips-up-place-main" onClick={() => openCity(entry.cityId)}>
        <span className="trips-up-place-icon" aria-hidden="true">
          <IconPin size={16} />
        </span>
        <span className="trips-up-place-text">
          <span className="trips-up-place-name">{entry.name}</span>
          <span className="trips-up-place-sub">
            {entry.country}
            {entry.iata ? (
              <>
                {" · "}
                <span className="iata">{entry.iata}</span>
              </>
            ) : null}
          </span>
        </span>
      </button>
      <div className="trips-up-place-actions">
        {isDesktop ? (
          <Button
            ref={anchor}
            size="sm"
            icon={<IconPlus size={16} />}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            Add to trip
          </Button>
        ) : (
          <IconButton
            ref={anchor}
            label={`Add ${entry.name} to a trip`}
            icon={<IconPlus />}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          />
        )}
        <IconButton
          label={`Suggest trips from ${entry.name}`}
          icon={<IconSparkle />}
          size={isDesktop ? "sm" : "md"}
          disabled={suggestStatus === "loading"}
          onClick={() => {
            void useSuggestStore.getState().request(entry.cityId);
            document.getElementById("trips-up-suggested")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />
        <IconButton
          label={`Remove ${entry.name} from saved places`}
          icon={<IconClose />}
          size={isDesktop ? "sm" : "md"}
          onClick={remove}
        />
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-end" label={`Add ${entry.name} to a trip`}>
        <div className="trips-up-pop">
          <p className="trips-up-pop-title">Add {entry.name} to</p>
          {manual.length > 0 ? (
            <ul className="trips-up-pop-list" role="list">
              {manual.map((t) => (
                <li key={t.id}>
                  <button type="button" className="trips-up-pop-item" onClick={() => addTo(t.id, t.name)}>
                    <TripDot color={t.color} size="sm" />
                    <span className="trips-up-pop-name">{displayTripName(t.name)}</span>
                    <span className="trips-up-pop-meta tabular">
                      {t.nodes.length} {t.nodes.length === 1 ? "stop" : "stops"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <button type="button" className="trips-up-pop-item trips-up-pop-new" onClick={addToNew}>
            <IconPlus size={16} />
            <span className="trips-up-pop-name">New trip</span>
          </button>
        </div>
      </Popover>
    </li>
  );
}
