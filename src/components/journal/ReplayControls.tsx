import { useMemo, useState } from "react";
import { MONTHS, cityIndex, cityLabel, monthOf, yearOf } from "../../lib/journal";
import {
  DEFAULT_WEIGHTS,
  WEIGHT_KEYS,
  crowdReadout,
  monthReadout,
  resetBend,
  scorableWeights,
  spendReadout,
  tempReadout,
  templateCard,
  templateFingerprint,
  templateMonth,
  weightShares,
  type ReplayControls as Controls,
  type ReplayTemplateRef,
  type WeightKey,
} from "../../lib/replayQuery";
import { saveSettings } from "../../lib/journalApi";
import type { City, Journey, ReplayResponse } from "../../types";
import CitySearchInput from "../seasonality/CitySearchInput";
import BendSlider from "./BendSlider";

const WEIGHT_LABEL: Record<WeightKey, string> = { climate: "CLIMATE", spend: "SPEND", crowd: "CROWD", flight: "FLIGHT" };
const REGIONS = ["europe", "asia", "africa", "latin america", "equator"];
// The distinct tags of data/events.json (the server filters on them); the client has no events endpoint to ask.
const EVENT_TAGS = [
  "festival", "eclipse", "total-eclipse", "annular-eclipse", "solar", "carnival", "sport", "marathon", "culture", "music", "arts", "nature",
  "cherry-blossom", "songkran", "holi", "colour", "oktoberfest", "day-of-the-dead", "lanterns", "winter", "crowds",
];
const FLIGHT_HOURS = [3, 6, 9, 12, 16];

const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Left column: template, bend, weights, limits (DESIGN-journal §7.2). Pure view: all state lives in ReplayPage. */
export default function ReplayControls({
  journeys,
  journey,
  template,
  controls,
  templateClimate,
  fromCityId,
  cities,
  onTemplate,
  onChange,
}: {
  /** Selectable templates, best rated first. */
  journeys: Journey[];
  journey: Journey | undefined;
  template: ReplayTemplateRef;
  controls: Controls;
  templateClimate: ReplayResponse["templateClimate"];
  /** The origin the server used (home unless overridden). */
  fromCityId: string | undefined;
  cities: City[];
  onTemplate: (t: ReplayTemplateRef) => void;
  onChange: (c: Controls) => void;
}) {
  const [open, setOpen] = useState(false);
  const [limits, setLimits] = useState(false);
  const [homeError, setHomeError] = useState(false);

  // Persist the picked origin as the home city, then fall back to "home" so the query runs from it.
  const setHome = async (cityId: string) => {
    setHomeError(false);
    try {
      await saveSettings({ homeCityId: cityId });
      onChange({ ...controls, fromCityId: null });
    } catch {
      setHomeError(true);
    }
  };
  const cityIdx = useMemo(() => cityIndex(cities), [cities]);
  const fp = templateFingerprint(journey, template.stopIndex);
  const baseMonth = templateMonth(journey, template.stopIndex);
  const scorable = scorableWeights(fp, templateClimate);
  const shares = weightShares(controls.weights, scorable);
  const set = (p: Partial<Controls>) => onChange({ ...controls, ...p });
  const temp = tempReadout(controls.tempC);
  const spend = spendReadout(controls.spendPct);
  const crowd = crowdReadout(controls.crowd);
  const month = monthReadout(controls.monthShift, controls.anyMonth, baseMonth);
  const from = fromCityId ? cityIdx.get(fromCityId) : undefined;
  const bent = controls.tempC || controls.spendPct || controls.crowd || controls.monthShift || controls.anyMonth;

  return (
    <aside className="jr-rc" aria-label="Replay controls">
      <button type="button" className="jr-rc-toggle tm-action-btn" aria-expanded={open} aria-controls="jr-rc-body" onClick={() => setOpen(!open)}>
        CONTROLS {open ? "▴" : "▾"}
      </button>
      <div id="jr-rc-body" className={`jr-rc-body${open ? " open" : ""}`}>
        <section>
          <label className="jr-label" htmlFor="jr-rc-template">
            TEMPLATE
          </label>
          <select
            id="jr-rc-template"
            className="jr-input jr-input-wide"
            value={template.journeyId}
            onChange={(e) => onTemplate({ journeyId: e.target.value, stopIndex: null })}
          >
            {journeys.length > 0 && !journeys.some((j) => j.id === template.journeyId) && (
              <option value={template.journeyId} disabled>
                UNKNOWN JOURNEY
              </option>
            )}
            {journeys.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title} · {MONTHS[monthOf(j.startDate) - 1]} {yearOf(j.startDate)}
              </option>
            ))}
          </select>
          {journey && journey.stops.length > 1 && (
            <select
              className="jr-input jr-input-wide jr-rc-stop"
              aria-label="Template stop"
              value={template.stopIndex ?? ""}
              onChange={(e) => onTemplate({ journeyId: template.journeyId, stopIndex: e.target.value === "" ? null : Number(e.target.value) })}
            >
              <option value="">WHOLE JOURNEY</option>
              {journey.stops.map((s, i) => (
                <option key={i} value={i}>
                  {cityLabel(s.cityId, cityIdx).toUpperCase()}
                </option>
              ))}
            </select>
          )}
          <div className="jr-tcard" aria-label="Template values">
            {templateCard(fp).map((it, i) => (
              <span key={it.key} className="jr-tcard-item">
                {i > 0 && " · "}
                {it.text}
                {it.status !== "ok" && (
                  <span className={`jr-fp-chip ${it.status === "pending" ? "pending" : "absent"}`}>
                    {it.status === "pending" ? "PENDING" : "NO DATA"}
                  </span>
                )}
              </span>
            ))}
          </div>
        </section>

        <section>
          <div className="jr-rc-head">
            <span className="jr-label">BEND</span>
            <button type="button" className="tp-link" disabled={!bent} onClick={() => onChange(resetBend(controls))}>
              RESET BEND
            </button>
          </div>
          {!scorable.spend && <div className="jr-hint">NOT SCORED: SPEND — NO MONEY RECORDED</div>}
          <BendSlider label="WARMER / COOLER" value={controls.tempC} min={-10} max={10} step={1} readout={temp.text} spoken={temp.spoken} onChange={(v) => set({ tempC: v })} />
          <BendSlider label="SPEND" value={controls.spendPct} min={-50} max={50} step={5} readout={spend.text} spoken={spend.spoken} disabled={!scorable.spend} onChange={(v) => set({ spendPct: v })} />
          <BendSlider label="CROWDS" value={controls.crowd} min={-50} max={50} step={5} readout={crowd.text} spoken={crowd.spoken} disabled={!scorable.crowd} onChange={(v) => set({ crowd: v })} />
          <BendSlider
            label="MONTH"
            value={controls.monthShift}
            min={-6}
            max={6}
            step={1}
            readout={month.text}
            spoken={month.spoken}
            disabled={controls.anyMonth}
            onChange={(v) => set({ monthShift: v })}
            extra={
              <button type="button" className={`layer-toggle jr-rc-any${controls.anyMonth ? " on" : ""}`} aria-pressed={controls.anyMonth} onClick={() => set({ anyMonth: !controls.anyMonth })}>
                ANY MONTH
              </button>
            }
          />
        </section>

        <section>
          <div className="jr-label">WEIGHTS</div>
          {WEIGHT_KEYS.map((k) => (
            <BendSlider
              key={k}
              label={WEIGHT_LABEL[k]}
              value={controls.weights[k]}
              min={0}
              max={1}
              step={0.05}
              centered={false}
              resetTo={DEFAULT_WEIGHTS[k]}
              readout={shares[k] === null ? "NOT SCORED" : `${shares[k]} %`}
              spoken={shares[k] === null ? "not scored" : `${shares[k]} percent`}
              disabled={shares[k] === null}
              onChange={(v) => set({ weights: { ...controls.weights, [k]: v } })}
            />
          ))}
        </section>

        <section>
          <button type="button" className="jr-disclose" aria-expanded={limits} onClick={() => setLimits(!limits)}>
            LIMITS {limits ? "▴" : "▾"}
          </button>
          {limits && (
            <div className="jr-rc-limits">
              <button type="button" className={`layer-toggle${controls.excludeVisited ? " on" : ""}`} aria-pressed={controls.excludeVisited} onClick={() => set({ excludeVisited: !controls.excludeVisited })}>
                EXCLUDE PLACES I'VE BEEN
              </button>
              <div>
                <label className="jr-label" htmlFor="jr-rc-flight">
                  MAX FLIGHT
                </label>
                <select
                  id="jr-rc-flight"
                  className="jr-input"
                  value={controls.maxFlightHours ?? ""}
                  onChange={(e) => set({ maxFlightHours: e.target.value === "" ? null : Number(e.target.value) })}
                >
                  <option value="">ANY</option>
                  {FLIGHT_HOURS.map((h) => (
                    <option key={h} value={h}>
                      ≤ {h} H
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="jr-label">
                  FROM {from?.iata ?? from?.name.toUpperCase() ?? "—"}
                  {controls.fromCityId ? (
                    <>
                      <button type="button" className="tp-link jr-rc-home" onClick={() => set({ fromCityId: null })}>
                        × HOME
                      </button>{" "}
                      <button type="button" className="tp-link jr-rc-home" onClick={() => void setHome(controls.fromCityId!)}>
                        SET AS HOME
                      </button>
                    </>
                  ) : from ? (
                    " · HOME"
                  ) : (
                    ""
                  )}
                </div>
                <CitySearchInput cities={cities} placeholder="Change origin…" onPick={(c) => set({ fromCityId: c.id })} />
                {homeError && <div className="jr-err">⚠ COULDN'T SAVE YOUR HOME CITY — TRY AGAIN</div>}
              </div>
              <div>
                <div className="jr-label">MONTHS</div>
                <div className="jr-tags">
                  {MONTHS.map((m, i) => (
                    <button key={m} type="button" className={`jr-pill${controls.months.includes(i + 1) ? " on" : ""}`} aria-pressed={controls.months.includes(i + 1)} onClick={() => set({ months: toggle(controls.months, i + 1) })}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="jr-label">REGIONS</div>
                <div className="jr-tags">
                  {REGIONS.map((r) => (
                    <button key={r} type="button" className={`jr-pill${controls.regions.includes(r) ? " on" : ""}`} aria-pressed={controls.regions.includes(r)} onClick={() => set({ regions: toggle(controls.regions, r) })}>
                      {r.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="jr-label">EVENTS</div>
                <div className="jr-tags">
                  {EVENT_TAGS.map((t) => (
                    <button key={t} type="button" className={`jr-pill${controls.tags.includes(t) ? " on" : ""}`} aria-pressed={controls.tags.includes(t)} onClick={() => set({ tags: toggle(controls.tags, t) })}>
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
