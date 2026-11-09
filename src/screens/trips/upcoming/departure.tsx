// "Departing from" card in the trip editor: where the route starts and (by default) ends.

import { useMeridianStore } from "../../../store";
import { cityToNode, tripDeparture } from "../../../lib/tripPlan";
import { Button, CitySearch, toast } from "../../../ui";
import type { Trip } from "../../../types";

export function DepartureCard({ trip }: { trip: Trip }) {
  const home = useMeridianStore((s) => s.homeDeparture);
  const dep = tripDeparture(trip, home);
  const own = Boolean(trip.departure);
  const isHome = dep.cityId === home.cityId;
  const returnHome = trip.returnHome !== false;
  const s = () => useMeridianStore.getState();

  return (
    <div className="trips-dep">
      <div className="trips-dep-current">
        <span className="trips-dep-name">{dep.name}</span>
        {dep.iata ? <span className="iata">{dep.iata}</span> : <span className="trips-dep-hint">No airport</span>}
        <span className="trips-dep-hint">{own ? (isHome ? "Your default" : "This trip only") : "Your default"}</span>
      </div>

      <CitySearch
        aria-label="Change where this trip departs from"
        placeholder="Change departure city or airport"
        size="sm"
        excludeIds={[dep.cityId]}
        onPick={(c) => {
          const node = cityToNode(c);
          s().setTripDeparture(trip.id, node.cityId === home.cityId ? undefined : node);
        }}
      />

      <label className="trips-dep-check">
        <input type="checkbox" checked={returnHome} onChange={(e) => s().setTripReturnHome(trip.id, e.target.checked)} />
        Fly back to {dep.name} at the end
      </label>

      {own && !isHome ? (
        <div className="trips-dep-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              s().setHomeDeparture(dep);
              s().setTripDeparture(trip.id, undefined);
              toast(`Trips now depart from ${dep.name} unless set otherwise`, { tone: "success" });
            }}
          >
            Make default
          </Button>
          <Button size="sm" variant="ghost" onClick={() => s().setTripDeparture(trip.id, undefined)}>
            Use {home.name}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
