import type { City, SegmentMode } from "../../types";
import { radioKeys } from "./radioKeys";
import MoneyInput from "./MoneyInput";
import { CityPick } from "./StopEditor";
import { MODE_GLYPH, MODE_LABEL, cityLabel } from "../../lib/journal";
import type { LogErrors, SegmentDraft } from "../../lib/journalForm";

const MODES = Object.keys(MODE_GLYPH) as SegmentMode[];

export default function SegmentEditor({
  seg,
  errors,
  cities,
  cityIdx,
  onChange,
  onRemove,
}: {
  seg: SegmentDraft;
  errors: LogErrors;
  cities: City[];
  cityIdx: Map<string, City>;
  onChange: (patch: Partial<SegmentDraft>) => void;
  onRemove?: () => void;
}) {
  const k = seg.key;
  // The date input shows the day only; a time suffix from an import is kept.
  const day = seg.date.slice(0, 10);
  const time = seg.date.slice(10);
  return (
    <div className="jr-seg" role="group" aria-label={`Segment ${cityLabel(seg.fromCityId, cityIdx)} to ${cityLabel(seg.toCityId, cityIdx)}`}>
      <div className="jr-seg-head">
        {seg.extra ? (
          <>
            <CityPick id={`jr-f-seg-${k}-from`} cityId={seg.fromCityId} cities={cities} index={cityIdx} label="segment from" placeholder="From…" onPick={(fromCityId) => onChange({ fromCityId })} />
            <span aria-hidden="true">→</span>
            <CityPick id={`jr-f-seg-${k}-to`} cityId={seg.toCityId} cities={cities} index={cityIdx} label="segment to" placeholder="To…" onPick={(toCityId) => onChange({ toCityId })} />
          </>
        ) : (
          <span className="jr-seg-pair">
            {cityLabel(seg.fromCityId, cityIdx)} → {cityLabel(seg.toCityId, cityIdx)}
          </span>
        )}
        {onRemove && (
          <button type="button" className="jr-x" aria-label="Remove segment" onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
      {errors[`seg-${k}-from`] && <div className="jr-err">{errors[`seg-${k}-from`]}</div>}
      {errors[`seg-${k}-to`] && <div className="jr-err">{errors[`seg-${k}-to`]}</div>}
      <div className="jr-row jr-row-top">
        <div className="jr-field">
          <span className="jr-label">MODE</span>
          <span className="jr-seg-modes" role="radiogroup" aria-label="Mode">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={seg.mode === m}
                aria-label={MODE_LABEL[m]}
                title={MODE_LABEL[m]}
                className={seg.mode === m ? "on" : ""}
                tabIndex={seg.mode === m ? 0 : -1}
                onKeyDown={radioKeys}
                onClick={() => onChange({ mode: m })}
              >
                {MODE_GLYPH[m]}
              </button>
            ))}
          </span>
        </div>
        <label className="jr-field">
          <span className="jr-label">DATE</span>
          <input
            type="date"
            className="jr-input"
            value={day}
            onChange={(e) => onChange({ date: e.target.value ? e.target.value + time : "", dateAuto: false })}
          />
        </label>
        <label className="jr-field">
          <span className="jr-label">CARRIER</span>
          <input className="jr-input jr-input-sans jr-w90" value={seg.carrier} onChange={(e) => onChange({ carrier: e.target.value })} />
        </label>
        <label className="jr-field">
          <span className="jr-label">NUMBER</span>
          <input className="jr-input jr-w90" placeholder="TP1023" value={seg.number} onChange={(e) => onChange({ number: e.target.value })} />
        </label>
        <div className="jr-field">
          <span className="jr-label">COST</span>
          <MoneyInput
            id={`jr-f-money-${k}-seg`}
            label="Segment cost"
            value={seg.cost}
            error={errors[`money-${k}-seg`]}
            onChange={(cost) => onChange({ cost })}
          />
        </div>
      </div>
    </div>
  );
}
