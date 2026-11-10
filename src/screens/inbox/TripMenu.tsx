import { useMemo, useRef, useState } from "react";
import { IconButton, Popover, toast } from "../../ui";
import { IconCalendar } from "../../ui/icons";
import { useMeridianStore } from "../../store";
import { tripOffers, type TripOffer } from "../../lib/inboxTrips";
import type { CityIndex } from "../../lib/journal";
import type { ImportCandidate } from "../../types";

/**
 * A booking dated in the future is a plan, not a memory: offer it as a stay or a booked leg on an
 * upcoming trip (ADR 0010). Renders nothing for past bookings or when there is nowhere to put it.
 * Applying it clears the item from the Inbox through `onApplied`.
 */
export default function TripMenu({ candidate, cities, disabled, onApplied }: { candidate: ImportCandidate; cities: CityIndex; disabled?: boolean; onApplied: () => void }) {
  const trips = useMeridianStore((s) => s.trips);
  const home = useMeridianStore((s) => s.homeDeparture);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const offers = useMemo(() => tripOffers(candidate, trips, cities, today, home), [candidate, trips, cities, today, home]);
  if (!offers.length) return null;

  const apply = (o: TripOffer) => {
    const s = useMeridianStore.getState();
    if (o.type === "stay") s.patchStop(o.tripId, o.stopIndex, o.patch);
    else if (o.type === "leg") s.setLegPlan(o.tripId, o.slot, o.plan);
    else {
      const id = s.createTrip(o.tripName);
      s.addCityToTrip(id, o.node);
      s.setTripYear(id, o.year);
      s.setStopMonths(id, 0, o.months);
      s.patchStop(id, 0, o.patch);
    }
    toast(o.type === "leg" ? "Booking added to the leg" : "Stay added to the trip", { tone: "success" });
    setOpen(false);
    onApplied();
  };

  const what = candidate.kind === "lodging" ? "Add this stay to an upcoming trip" : "Record this booking on an upcoming trip";
  return (
    <>
      <IconButton ref={anchor} size="sm" label={what} title={what} icon={<IconCalendar size={18} />} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-end" label={what} className="inbox-merge">
        <p className="inbox-merge-head">{what}</p>
        <ul className="inbox-merge-list">
          {offers.map((o, i) => (
            <li key={i}>
              <button type="button" className="inbox-merge-row" onClick={() => apply(o)}>
                <span className="inbox-merge-title">{o.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
