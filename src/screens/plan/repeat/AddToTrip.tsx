import { useRef, useState } from "react";
import { useMeridianStore } from "../../../store";
import { navigate } from "../../../lib/router";
import { resolveTripColor } from "../../../lib/tripColors";
import { monthName } from "../../../lib/repeatCopy";
import { Button, Popover, toast } from "../../../ui";
import { IconChevronDown, IconPlus } from "../../../ui/icons";
import type { City, TripNode } from "../../../types";

const node = (c: City): TripNode => ({ cityId: c.id, name: c.name, iata: c.iata, lat: c.lat, lng: c.lng });

/** "Add to trip" with a small menu: one of your planned trips, or a new one. */
export function AddToTrip({ city, month, origin }: { city: City; month: number; origin?: City }) {
  const trips = useMeridianStore((s) => s.trips);
  const createTrip = useMeridianStore((s) => s.createTrip);
  const addCityToTrip = useMeridianStore((s) => s.addCityToTrip);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const mine = trips.filter((t) => t.origin !== "agent");

  const openTrip = (id: string) => navigate({ view: "trips", tab: "upcoming", tripId: id });

  const addTo = (tripId: string, name: string) => {
    addCityToTrip(tripId, node(city));
    setOpen(false);
    toast(`Added ${city.name} to ${name}`, { tone: "success", action: { label: "Open trip", onClick: () => openTrip(tripId) } });
  };

  const addNew = () => {
    const name = `${city.name} in ${monthName(month)}`;
    const id = createTrip(name);
    if (origin && origin.id !== city.id) addCityToTrip(id, node(origin));
    addCityToTrip(id, node(city));
    setOpen(false);
    toast(`Created ${name}`, { tone: "success", action: { label: "Open trip", onClick: () => openTrip(id) } });
  };

  return (
    <>
      <Button
        ref={anchor}
        variant="secondary"
        icon={<IconPlus size={16} />}
        iconRight={<IconChevronDown size={16} />}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Add to trip
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} label={`Add ${city.name} to a trip`} placement="bottom-start">
        <div className="plan-repeat-menu">
          {mine.length > 0 && <p className="plan-repeat-menu-head">Your trips</p>}
          {mine.map((t) => {
            const has = t.nodes.some((n) => n.cityId === city.id);
            return (
              <button key={t.id} type="button" className="plan-repeat-menu-item" disabled={has} onClick={() => addTo(t.id, t.name)}>
                <span className="plan-repeat-dot" style={{ background: resolveTripColor(t.color) }} aria-hidden="true" />
                <span className="plan-repeat-menu-name">{t.name}</span>
                {has && <span className="plan-repeat-menu-note">Already added</span>}
              </button>
            );
          })}
          <button type="button" className="plan-repeat-menu-item is-new" onClick={addNew}>
            <IconPlus size={16} />
            <span className="plan-repeat-menu-name">New trip</span>
          </button>
        </div>
      </Popover>
    </>
  );
}
