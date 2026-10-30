import type { City, Lodging } from "../../types";
import CitySearchInput from "../seasonality/CitySearchInput";
import RatingPips from "./RatingPips";
import MoneyInput from "./MoneyInput";
import { emptyMoney, type LogErrors, type StopDraft } from "../../lib/journalForm";

const KINDS: Lodging["kind"][] = ["hotel", "apartment", "hostel", "friends", "other"];

export function CityPick({
  id,
  cityId,
  cities,
  index,
  onPick,
  placeholder = "City or airport…",
  label,
}: {
  id?: string;
  cityId: string;
  cities: City[];
  index: Map<string, City>;
  onPick: (cityId: string) => void;
  placeholder?: string;
  label: string;
}) {
  const c = cityId ? index.get(cityId) : undefined;
  return (
    <div id={id} className="jr-citypick">
      {cityId ? (
        <span className="jr-city">
          <b>{c?.iata ?? "—"}</b> {c?.name ?? cityId}
          <button type="button" aria-label={`Change ${label}`} onClick={() => onPick("")}>
            ×
          </button>
        </span>
      ) : (
        <CitySearchInput cities={cities} placeholder={placeholder} onPick={(x) => onPick(x.id)} />
      )}
    </div>
  );
}

export default function StopEditor({
  stop,
  index,
  count,
  errors,
  cities,
  cityIdx,
  onChange,
  onMove,
  onRemove,
}: {
  stop: StopDraft;
  index: number;
  count: number;
  errors: LogErrors;
  cities: City[];
  cityIdx: Map<string, City>;
  onChange: (patch: Partial<StopDraft>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const k = stop.key;
  const eCity = errors[`stop-${k}-city`];
  const eDates = errors[`stop-${k}-dates`];
  const eStay = errors[`money-${k}-stay`];
  return (
    <div className="jr-stop" role="group" aria-label={`Stop ${index + 1}`}>
      <div className="jr-stop-head">
        <span className="jr-stop-n">{index + 1}</span>
        <CityPick
          id={`jr-f-stop-${k}-city`}
          cityId={stop.cityId}
          cities={cities}
          index={cityIdx}
          label={`stop ${index + 1} city`}
          onPick={(cityId) => onChange({ cityId })}
        />
        <span className="tp-node-actions">
          <button type="button" aria-label="Move stop up" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button type="button" aria-label="Move stop down" disabled={index === count - 1} onClick={() => onMove(1)}>
            ↓
          </button>
          <button type="button" aria-label="Remove stop" disabled={count === 1} onClick={onRemove}>
            ✕
          </button>
        </span>
      </div>
      {eCity && <div className="jr-err">{eCity}</div>}

      <div className="jr-row">
        <label className="jr-field">
          <span className="jr-label">ARRIVE</span>
          <input
            id={`jr-f-stop-${k}-dates`}
            type="date"
            className="jr-input"
            value={stop.arrive}
            aria-invalid={!!eDates}
            onChange={(e) => onChange({ arrive: e.target.value })}
          />
        </label>
        <label className="jr-field">
          <span className="jr-label">DEPART</span>
          <input
            type="date"
            className="jr-input"
            value={stop.depart}
            min={stop.arrive || undefined}
            aria-invalid={!!eDates}
            onChange={(e) => onChange({ depart: e.target.value })}
          />
        </label>
        <div className="jr-field">
          <span className="jr-label">RATING</span>
          <RatingPips value={stop.rating} onChange={(rating) => onChange({ rating })} label={`Stop ${index + 1} rating`} />
        </div>
      </div>
      {eDates && <div className="jr-err">{eDates}</div>}

      <div className="jr-row jr-row-top">
        {stop.lodging ? (
          <div className="jr-stay">
            <span className="jr-label">
              STAY
              <button type="button" className="jr-x" aria-label="Remove stay" onClick={() => onChange({ lodging: undefined })}>
                ×
              </button>
            </span>
            <input
              className="jr-input jr-input-sans"
              placeholder="Name"
              aria-label="Stay name"
              value={stop.lodging.name}
              onChange={(e) => onChange({ lodging: { ...stop.lodging!, name: e.target.value } })}
            />
            <select
              className="jr-input"
              aria-label="Stay kind"
              value={stop.lodging.kind}
              onChange={(e) => onChange({ lodging: { ...stop.lodging!, kind: e.target.value as Lodging["kind"] } })}
            >
              <option value="">KIND</option>
              {KINDS.map((x) => (
                <option key={x} value={x}>
                  {x!.toUpperCase()}
                </option>
              ))}
            </select>
            <MoneyInput
              id={`jr-f-money-${k}-stay`}
              label="Stay cost"
              value={stop.lodging.cost}
              error={eStay}
              onChange={(cost) => onChange({ lodging: { ...stop.lodging!, cost } })}
            />
          </div>
        ) : (
          <button
            type="button"
            className="tm-action-btn"
            onClick={() => onChange({ lodging: { name: "", kind: "", cost: emptyMoney() } })}
          >
            + STAY
          </button>
        )}

        {stop.crowd !== undefined ? (
          <div className="jr-crowd">
            <div>
              <label className="jr-label" htmlFor={`jr-crowd-${k}`}>HOW BUSY WAS IT?</label>
              <button type="button" className="jr-x" aria-label="Remove crowd rating" onClick={() => onChange({ crowd: undefined })}>
                ×
              </button>
            </div>
            <div className="jr-crowd-row">
              <span>EMPTY</span>
              <input
                id={`jr-crowd-${k}`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={stop.crowd}
                aria-valuetext={`${stop.crowd} out of 100`}
                onChange={(e) => onChange({ crowd: Number(e.target.value) })}
              />
              <span>PACKED</span>
            </div>
          </div>
        ) : (
          <button type="button" className="tm-action-btn" onClick={() => onChange({ crowd: 50 })}>
            + CROWD
          </button>
        )}
      </div>
    </div>
  );
}
