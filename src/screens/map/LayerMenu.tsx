import { useId, useRef, useState } from "react";
import { Button, IconButton, Popover, SectionHeader, Segmented, Select, Sheet, UnlockCard, useIsDesktop, useJournalToken } from "../../ui";
import { IconLayers } from "../../ui/icons";
import { useMapPrefs, type CityNames, type MapLayer } from "../../shell/mapPrefs";
import { MONTH_NAMES, MONTH_SHORT } from "./basemap";
import { CLIMATE_MODES } from "../../lib/climate";
import { METRICS, type MetricId } from "../../lib/cityMetrics";
import type { MapColors } from "./useMapColors";

interface LayerMenuProps {
  colors: MapColors;
  /** Year span of past journeys, for the legend (null while unknown). */
  years: { min: number; max: number } | null;
  pastLoading: boolean;
}

function rgb(c: [number, number, number, number]) {
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

function SwitchRow({
  layer,
  name,
  hint,
  disabled,
  children,
}: {
  layer: MapLayer;
  name: string;
  hint?: React.ReactNode;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const on = useMapPrefs((s) => s.layers[layer]);
  const setLayer = useMapPrefs((s) => s.setLayer);
  const id = useId();
  return (
    <div className="map-layer">
      <label className="map-layer-row" htmlFor={id}>
        <span className="map-layer-text">
          <span className="map-layer-name">{name}</span>
          {hint ? <span className="map-layer-hint">{hint}</span> : null}
        </span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="map-switch"
          checked={on && !disabled}
          disabled={disabled}
          onChange={(e) => setLayer(layer, e.target.checked)}
        />
      </label>
      {on && !disabled ? children : null}
    </div>
  );
}

export function MonthPicker({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  return (
    <div className="map-months" role="radiogroup" aria-label="Month">
      {MONTH_SHORT.map((m, i) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === i + 1}
          aria-label={MONTH_NAMES[i]}
          className="map-month"
          onClick={() => onChange(i + 1)}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export default function LayerMenu({ colors, years, pastLoading }: LayerMenuProps) {
  const [open, setOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const isDesktop = useIsDesktop();
  const anchor = useRef<HTMLButtonElement>(null);
  const { unlocked } = useJournalToken();
  const month = useMapPrefs((s) => s.month);
  const setMonth = useMapPrefs((s) => s.setMonth);
  const climateMode = useMapPrefs((s) => s.climateMode);
  const setClimateMode = useMapPrefs((s) => s.setClimateMode);
  const cityNames = useMapPrefs((s) => s.cityNames);
  const setCityNames = useMapPrefs((s) => s.setCityNames);
  const avoidConflicts = useMapPrefs((s) => s.avoidConflicts);
  const setAvoidConflicts = useMapPrefs((s) => s.setAvoidConflicts);

  const pastHint = !unlocked ? (
    "Unlock your journal to show them"
  ) : pastLoading ? (
    "Loading your trips…"
  ) : years ? (
    <span className="map-years">
      <span className="num">{years.min}</span>
      <span
        className="map-years-bar"
        aria-hidden="true"
        style={{ background: `linear-gradient(to right, ${rgb(colors.yearFrom)}, ${rgb(colors.yearTo)})` }}
      />
      <span className="num">{years.max}</span>
    </span>
  ) : (
    "No logged trips yet"
  );

  const content = (
    <div className="map-layers">
      <section className="map-layers-group" aria-label="Trips">
        <SectionHeader level={3} title="Trips" />
        <SwitchRow layer="past" name="Past trips" hint={pastHint} disabled={!unlocked}>
          {null}
        </SwitchRow>
        {!unlocked ? (
          unlocking ? (
            <UnlockCard compact title="Unlock past trips" onUnlocked={() => setUnlocking(false)} className="map-unlock" />
          ) : (
            <Button variant="ghost" size="sm" className="map-unlock-btn" onClick={() => setUnlocking(true)}>
              Unlock journal
            </Button>
          )
        ) : null}
        <SwitchRow layer="planned" name="Planned trips" hint="Dashed until confirmed. Booked flights in green." />
      </section>
      <section className="map-layers-group" aria-label="Places and climate">
        <SectionHeader level={3} title="Places and climate" />
        <SwitchRow layer="cities" name="Cities" hint="More appear as you zoom in">
          <Segmented<CityNames>
            label="City names"
            size="sm"
            block
            className="map-layer-seg"
            value={cityNames}
            onChange={setCityNames}
            options={[
              { value: "english", label: "English" },
              { value: "native", label: "Native" },
              { value: "both", label: "Both" },
            ]}
          />
        </SwitchRow>
        <SwitchRow layer="seasons" name="Climate" hint={`Tint and search by weather in ${MONTH_NAMES[month - 1]}`}>
          <MonthPicker value={month} onChange={setMonth} />
          <Segmented
            label="Tint countries by"
            size="sm"
            block
            className="map-layer-seg"
            value={climateMode}
            onChange={setClimateMode}
            options={CLIMATE_MODES.map((m) => ({ value: m.value, label: m.label }))}
          />
        </SwitchRow>
      </section>
      <section className="map-layers-group" aria-label="Conditions">
        <SectionHeader level={3} title="Conditions" />
        <SwitchRow layer="metrics" name="City metrics" hint="Safety, quality of life, internet, cost, crowds, healthcare">
          <MetricControls />
        </SwitchRow>
        <SwitchRow layer="events" name="Events" hint={`Eclipses, festivals and fixtures in ${MONTH_NAMES[month - 1]}`} />
        <SwitchRow layer="anomalies" name="Anomalies" hint="Conflicts, advisories, seasonal hazards and news alerts">
          <label className="map-check">
            <input type="checkbox" checked={avoidConflicts} onChange={(e) => setAvoidConflicts(e.target.checked)} />
            <span>Leave conflict countries out of matches</span>
          </label>
        </SwitchRow>
      </section>
    </div>
  );

  return (
    <>
      {isDesktop ? (
        <Button
          ref={anchor}
          variant="secondary"
          icon={<IconLayers />}
          className="map-float-btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Layers
        </Button>
      ) : (
        // Phone: icon only, so the finder gets the rest of the top row.
        <IconButton
          ref={anchor}
          label="Map layers"
          variant="secondary"
          icon={<IconLayers />}
          className="map-float-btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        />
      )}
      {isDesktop ? (
        <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-end" label="Map layers" className="map-layers-pop">
          {content}
        </Popover>
      ) : (
        // Phone: a bottom sheet, like every other panel on phones.
        <Sheet open={open} onClose={() => setOpen(false)} title="Map layers">
          {content}
        </Sheet>
      )}
    </>
  );
}

/** Colour-by and per-metric thresholds for the City metrics layer. */
function MetricControls() {
  const colorBy = useMapPrefs((s) => s.metrics.colorBy);
  const thresholds = useMapPrefs((s) => s.metrics.thresholds);
  const setMetricColor = useMapPrefs((s) => s.setMetricColor);
  const setThreshold = useMapPrefs((s) => s.setThreshold);
  const selectId = useId();
  return (
    <div className="map-lm">
      <label className="map-lm-row" htmlFor={selectId}>
        <span className="map-lm-label">Colour cities by</span>
        <Select
          id={selectId}
          size="sm"
          value={colorBy}
          onChange={(e) => setMetricColor(e.target.value as MetricId | "none")}
          options={[{ value: "none", label: "Nothing" }, ...METRICS.map((m) => ({ value: m.id, label: `${m.label} (${m.theme.toLowerCase()})` }))]}
        />
      </label>
      <p className="map-lm-label">Only match cities with</p>
      {METRICS.map((m) => {
        const max = m.direction === "max";
        const value = thresholds[m.id] ?? (max ? 100 : 0);
        const off = max ? value >= 100 : value <= 0;
        return (
          <label key={m.id} className="map-lm-slider">
            <span className="map-lm-name">
              {m.label}
              <span className="map-lm-value num">{off ? "Any" : `${max ? "≤" : "≥"} ${value}`}</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={value}
              aria-label={`${m.label}: ${max ? "at most" : "at least"}`}
              aria-valuetext={off ? "Any" : `${max ? "at most" : "at least"} ${value}`}
              onChange={(e) => {
                const v = Number(e.target.value);
                setThreshold(m.id, (max ? v >= 100 : v <= 0) ? undefined : v);
              }}
            />
          </label>
        );
      })}
      {colorBy !== "none" ? <p className="map-lm-note">{METRICS.find((m) => m.id === colorBy)?.basis}</p> : null}
      <p className="map-lm-note">
        Scores run 0 to 100 and come from measured data; affordability is an estimate, and higher means cheaper. Cities with no data for a
        measure aren’t coloured and don’t match its filter.
      </p>
    </div>
  );
}
