import { useEffect, useRef, useState } from "react";
import { CitySearchInput } from "../../pages/TripsPage";
import { todayIsoDate } from "../../lib/bookingApi";
import type { City } from "../../types";

export interface SearchDraft {
  originIata: string;
  originName: string;
  destinationIata: string;
  destName: string;
  departureDate: string;
  returnDate: string;
  passengers: number;
}

/** CONFIRM step (DESIGN-booking.md §3.1) — route chips, depart/return dates,
 *  passenger stepper. Route is readonly when opened from a trip leg; editable
 *  IATA fields (CitySearchInput) when opened without one. */
export default function BookingSearchForm({
  draft,
  onChange,
  routeEditable,
  cities,
}: {
  draft: SearchDraft;
  onChange: (patch: Partial<SearchDraft>) => void;
  routeEditable: boolean;
  cities: City[];
}) {
  const [returnOpen, setReturnOpen] = useState(Boolean(draft.returnDate));
  const departRef = useRef<HTMLInputElement>(null);
  const today = todayIsoDate();
  const originMissing = !draft.originIata;

  // §10: CONFIRM focuses depart date — or the origin field when it's empty.
  useEffect(() => {
    if (!originMissing) departRef.current?.focus();
  }, [originMissing]);

  return (
    <div className="bk-search-form">
      <div className="bk-field-label">ROUTE</div>
      <div className="bk-route-row">
        {routeEditable && !draft.originIata ? (
          <div className="bk-route-edit">
            <CitySearchInput
              cities={cities}
              placeholder="Origin city or airport…"
              autoFocus
              onPick={(c) =>
                onChange({ originIata: c.iata ?? "", originName: c.name })
              }
            />
          </div>
        ) : (
          <RouteChip
            iata={draft.originIata}
            name={draft.originName}
            editable={routeEditable}
            onClear={() => onChange({ originIata: "", originName: "" })}
          />
        )}
        <span className="bk-route-arrow" aria-hidden="true">
          ───▶
        </span>
        {routeEditable && !draft.destinationIata ? (
          <div className="bk-route-edit">
            <CitySearchInput
              cities={cities}
              placeholder="Destination city or airport…"
              onPick={(c) =>
                onChange({ destinationIata: c.iata ?? "", destName: c.name })
              }
            />
          </div>
        ) : (
          <RouteChip
            iata={draft.destinationIata}
            name={draft.destName}
            editable={routeEditable}
            onClear={() => onChange({ destinationIata: "", destName: "" })}
          />
        )}
      </div>

      <div className="bk-dates-row">
        <div className="bk-field">
          <label className="bk-field-label" htmlFor="bk-depart">
            DEPART *
          </label>
          <input
            id="bk-depart"
            ref={departRef}
            className="bk-date-input"
            type="date"
            min={today}
            value={draft.departureDate}
            onChange={(e) => onChange({ departureDate: e.target.value })}
          />
        </div>
        <div className="bk-field">
          <label className="bk-field-label" htmlFor="bk-return">
            RETURN (OPTIONAL)
          </label>
          {returnOpen ? (
            <input
              id="bk-return"
              className="bk-date-input"
              type="date"
              min={draft.departureDate || today}
              value={draft.returnDate}
              onChange={(e) => onChange({ returnDate: e.target.value })}
            />
          ) : (
            <button
              id="bk-return"
              type="button"
              className="bk-add-return"
              onClick={() => setReturnOpen(true)}
            >
              — ADD RETURN
            </button>
          )}
        </div>
      </div>

      <div className="bk-field">
        <span className="bk-field-label">PASSENGERS</span>
        <div className="bk-pax-stepper">
          <button
            type="button"
            aria-label="Fewer passengers"
            disabled={draft.passengers <= 1}
            onClick={() => onChange({ passengers: Math.max(1, draft.passengers - 1) })}
          >
            −
          </button>
          <span className="bk-pax-count">{draft.passengers}</span>
          <button
            type="button"
            aria-label="More passengers"
            disabled={draft.passengers >= 9}
            onClick={() => onChange({ passengers: Math.min(9, draft.passengers + 1) })}
          >
            +
          </button>
          <span className="bk-pax-label">
            {draft.passengers === 1 ? "ADULT" : "ADULTS"}
          </span>
        </div>
      </div>
    </div>
  );
}

function RouteChip({
  iata,
  name,
  editable,
  onClear,
}: {
  iata: string;
  name: string;
  editable: boolean;
  onClear: () => void;
}) {
  return (
    <div className="bk-route-chip">
      <span className="bk-route-iata">{iata || "—"}</span>
      <span className="bk-route-city">{name}</span>
      {editable && (
        <button
          type="button"
          className="bk-route-clear"
          title="Change airport"
          onClick={onClear}
        >
          ✕
        </button>
      )}
    </div>
  );
}
