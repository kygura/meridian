import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useMeridianStore } from "../../../store";
import { findLegBooking } from "../../../lib/bookingApi";
import { hrefFor } from "../../../lib/router";
import {
  canReturnToStart,
  cityToNode,
  dropIndex,
  flightsSearchUrl,
  formatFlightTime,
  formatKm,
  staysSearchUrl,
  stopKeys,
  type TripLeg,
} from "../../../lib/tripPlan";
import { Badge, Button, CitySearch, EmptyState, IconButton, toast, useIsDesktop } from "../../../ui";
import { IconArrowLeft, IconChevronDown, IconChevronUp, IconDrag, IconExternal, IconPin, IconPlane, IconTrash } from "../../../ui/icons";
import type { Trip } from "../../../types";
import { useTripMoney } from "./money";

interface StopListProps {
  trip: Trip;
  legs: TripLeg[];
}

/**
 * Ordered stops with the leg to the next stop under each one.
 * Reorder: drag the handle (pointer), arrow keys on the handle, or the move buttons.
 */
export default function StopList({ trip, legs }: StopListProps) {
  const bookings = useMeridianStore((s) => s.bookings);
  const sz = useIsDesktop() ? "sm" : "md";
  const listRef = useRef<HTMLOListElement>(null);
  const drag = useRef<{ from: number; pointerId: number } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const keys = useMemo(() => stopKeys(trip.nodes), [trip.nodes]);
  const count = trip.nodes.length;
  const tripId = trip.id;

  const move = (from: number, to: number, focus?: "up" | "down" | "handle") => {
    if (to < 0 || to >= count || from === to) return;
    const key = keys[from];
    const name = trip.nodes[from].name;
    useMeridianStore.getState().reorderTripNodes(tripId, from, to);
    setAnnounce(`${name} moved to stop ${to + 1} of ${count}`);
    if (focus) {
      requestAnimationFrame(() => {
        const row = listRef.current?.querySelector<HTMLElement>(`[data-stop-key="${CSS.escape(key)}"]`);
        if (!row) return;
        const want = row.querySelector<HTMLButtonElement>(`[data-move="${focus}"]`);
        const target = want && !want.disabled ? want : row.querySelector<HTMLButtonElement>('[data-move="handle"]');
        target?.focus();
      });
    }
  };

  const remove = (i: number) => {
    const node = trip.nodes[i];
    useMeridianStore.getState().removeNodeAt(tripId, i);
    toast(`Removed ${node.name}`, {
      action: {
        label: "Undo",
        onClick: () => {
          const s = useMeridianStore.getState();
          const t = s.trips.find((x) => x.id === tripId);
          if (!t) return;
          s.addCityToTrip(tripId, node);
          s.reorderTripNodes(tripId, t.nodes.length, Math.min(i, t.nodes.length));
        },
      },
    });
  };

  // ── Pointer drag on the handle ──
  // Move/up listeners go on window: rows are re-ordered in the DOM mid-drag, which
  // can drop pointer capture on the handle.
  const onHandleDown = (e: PointerEvent<HTMLButtonElement>, i: number) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    const pointerId = e.pointerId;
    drag.current = { from: i, pointerId };
    setDragKey(keys[i]);

    const onMove = (ev: globalThis.PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== pointerId || !listRef.current) return;
      ev.preventDefault();
      const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-stop-row]"));
      const mids = rows.map((r) => {
        const b = r.getBoundingClientRect();
        return b.top + b.height / 2;
      });
      const to = dropIndex(ev.clientY, mids, d.from);
      if (to !== d.from) {
        useMeridianStore.getState().reorderTripNodes(tripId, d.from, to);
        d.from = to;
      }
    };
    const onUp = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const d = drag.current;
      drag.current = null;
      setDragKey(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!d) return;
      const t = useMeridianStore.getState().trips.find((x) => x.id === tripId);
      const node = t?.nodes[d.from];
      if (node && t) setAnnounce(`${node.name} moved to stop ${d.from + 1} of ${t.nodes.length}`);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(i, i - 1, "handle");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(i, i + 1, "handle");
    }
  };

  const first = trip.nodes[0];
  const last = trip.nodes[count - 1];

  return (
    <div className="trips-ed-stops">
      {count === 0 ? (
        <EmptyState icon={<IconPin />} title="No stops yet" description="Add a city below to start the route." />
      ) : (
        <ol className="trips-ed-list" ref={listRef}>
          {trip.nodes.map((node, i) => {
            const key = keys[i];
            const leg = legs[i];
            return (
              <li key={key} data-stop-key={key} className={dragKey === key ? "trips-ed-stop is-dragging" : "trips-ed-stop"}>
                <div className="trips-ed-row" data-stop-row>
                  <button
                    type="button"
                    className="trips-ed-handle"
                    data-move="handle"
                    aria-label={`Reorder ${node.name}, stop ${i + 1} of ${count}. Use arrow keys to move.`}
                    title="Drag to reorder"
                    onPointerDown={(e) => onHandleDown(e, i)}
                    onKeyDown={(e) => onHandleKey(e, i)}
                  >
                    <IconDrag size={16} />
                  </button>
                  <span className="trips-ed-index tabular" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="trips-ed-stop-text">
                    <span className="trips-ed-stop-name">{node.name}</span>
                    <span className="trips-ed-stop-sub">
                      {node.iata ? <span className="iata">{node.iata}</span> : <span>No airport</span>}
                    </span>
                  </div>
                  <div className="trips-ed-row-actions">
                    <IconButton
                      label={`Move ${node.name} up`}
                      icon={<IconChevronUp size={18} />}
                      size={sz}
                      data-move="up"
                      disabled={i === 0}
                      onClick={() => move(i, i - 1, "up")}
                    />
                    <IconButton
                      label={`Move ${node.name} down`}
                      icon={<IconChevronDown size={18} />}
                      size={sz}
                      data-move="down"
                      disabled={i === count - 1}
                      onClick={() => move(i, i + 1, "down")}
                    />
                    <IconButton label={`Remove ${node.name}`} icon={<IconTrash size={18} />} size={sz} onClick={() => remove(i)} />
                  </div>
                </div>
                {leg ? <LegRow leg={leg} tripId={tripId} size={sz} booking={findLegBooking(bookings, tripId, i)} /> : null}
              </li>
            );
          })}
        </ol>
      )}

      <div className="trips-ed-add">
        <CitySearch
          aria-label="Add a stop"
          placeholder={count === 0 ? "Add your first city or airport" : "Add a city or airport"}
          excludeIds={last ? [last.cityId] : undefined}
          onPick={(c) => {
            useMeridianStore.getState().addCityToTrip(tripId, cityToNode(c));
            setAnnounce(`Added ${c.name}`);
          }}
        />
        {first && canReturnToStart(trip.nodes) ? (
          <Button
            variant="ghost"
            icon={<IconArrowLeft size={16} />}
            onClick={() => {
              useMeridianStore.getState().addCityToTrip(tripId, first);
              setAnnounce(`Added return to ${first.name}`);
            }}
          >
            Return to {first.name}
          </Button>
        ) : null}
      </div>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

function LegRow({
  leg,
  tripId,
  booking,
  size,
}: {
  leg: TripLeg;
  tripId: string;
  booking: ReturnType<typeof findLegBooking>;
  size: "sm" | "md";
}) {
  const live = booking && booking.status === "booked";
  const money = useTripMoney();
  const book = () =>
    useMeridianStore.getState().openBookingModal({ tripId, legIndex: leg.index, origin: leg.from, dest: leg.to });

  return (
    <div className="trips-ed-leg">
      <span className="trips-ed-leg-icon" aria-hidden="true">
        <IconPlane size={16} />
      </span>
      <div className="trips-ed-leg-text">
        <span className="sr-only">
          Flight from {leg.from.name} to {leg.to.name}:{" "}
        </span>
        <span className="tabular">{formatFlightTime(leg.hours)}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular">{formatKm(leg.km)}</span>
        <span aria-hidden="true">·</span>
        <span>
          about <span className="tabular">{money(leg.cost)}</span>
        </span>
        {leg.via ? (
          <span className="trips-ed-leg-via">
            via <span className="iata">{leg.via}</span>
          </span>
        ) : null}
      </div>
      <div className="trips-ed-leg-actions">
        <a className="trips-ed-link" href={flightsSearchUrl(leg.from, leg.to)} target="_blank" rel="noreferrer">
          Compare flights
          <IconExternal size={12} />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <a className="trips-ed-link" href={staysSearchUrl(leg.to)} target="_blank" rel="noreferrer">
          Stays in {leg.to.name}
          <IconExternal size={12} />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        {live ? (
          <a className="trips-ed-booking" href={hrefFor({ view: "plan", tab: "flights" })} title="View in your bookings">
            <Badge tone="success">
              Booked · <span className="tabular">{booking.bookingReference}</span>
            </Badge>
          </a>
        ) : (
          <>
            {booking ? <Badge tone="neutral">Cancelled</Badge> : null}
            {leg.bookable ? (
              <Button
                size={size}
                icon={<IconPlane size={16} />}
                onClick={book}
                aria-label={`Book a flight from ${leg.from.name} to ${leg.to.name}`}
              >
                Book
              </Button>
            ) : (
              <span className="trips-ed-leg-note">No airport to book</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
