import { useId, useMemo, useState } from "react";
import { Button, Chip, Disclosure, IconButton, Input, SectionHeader, Spinner } from "../../ui";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronUp, IconSearch } from "../../ui/icons";
import { useMapPrefs } from "../../shell/mapPrefs";
import { openCity } from "../../shell/uiStore";
import {
  CLIMATE_MODES,
  CONDITIONS,
  GROUP_LABELS,
  conditionById,
  describeFilter,
  isFilterActive,
  modeRampVars,
  searchClimate,
  toggleCondition,
  type ConditionGroup,
  type ConditionId,
} from "../../lib/climate";
import { METRIC_BY_ID, activeThresholds } from "../../lib/cityMetrics";
import { MONTH_NAMES } from "./basemap";
import type { FinderResult } from "./finder";
import type { FeedStatus } from "./useFinderData";

// Bottom-left panel for the climate, metric and anomaly layers: month stepper, legend for
// the active tint, condition search and chips, and the cities that match.

interface MapFinderProps {
  result: FinderResult;
  regionsStatus: FeedStatus;
  climateStatus: FeedStatus;
  onRetry: () => void;
  /** As-of month of the anomaly seed list ("2026-11"), when loaded. */
  anomaliesAsOf?: string;
  eventCount?: number;
}

const RESULT_LIMIT = 8;
const GROUPS = Object.keys(GROUP_LABELS) as ConditionGroup[];

export default function MapFinder({ result, regionsStatus, climateStatus, onRetry, anomaliesAsOf, eventCount }: MapFinderProps) {
  const layers = useMapPrefs((s) => s.layers);
  const month = useMapPrefs((s) => s.month);
  const setMonth = useMapPrefs((s) => s.setMonth);
  const mode = useMapPrefs((s) => s.climateMode);
  const climate = useMapPrefs((s) => s.climate);
  const setClimate = useMapPrefs((s) => s.setClimate);
  const setConditions = useMapPrefs((s) => s.setConditions);
  const setMinComfort = useMapPrefs((s) => s.setMinComfort);
  const metrics = useMapPrefs((s) => s.metrics);
  const onlyMatches = useMapPrefs((s) => s.onlyMatches);
  const setOnlyMatches = useMapPrefs((s) => s.setOnlyMatches);
  const avoidConflicts = useMapPrefs((s) => s.avoidConflicts);
  const open = useMapPrefs((s) => s.finderOpen);
  const setOpen = useMapPrefs((s) => s.setFinderOpen);
  const clearFilters = useMapPrefs((s) => s.clearFilters);
  const [query, setQuery] = useState("");
  const bodyId = useId();
  const comfortId = useId();

  const seasons = layers.seasons;
  const thresholds = layers.metrics ? activeThresholds(metrics.thresholds) : [];
  const modeDef = CLIMATE_MODES.find((m) => m.value === mode)!;
  const search = useMemo(() => searchClimate(query), [query]);
  const stepMonth = (d: number) => setMonth(((month - 1 + d + 12) % 12) + 1);

  const title = seasons ? `Climate in ${MONTH_NAMES[month - 1]}` : layers.metrics ? "City metrics" : MONTH_NAMES[month - 1];
  const rampVars = mode === "comfort" ? modeRampVars(mode).slice(1) : modeRampVars(mode);
  const colorDef = layers.metrics && metrics.colorBy !== "none" ? METRIC_BY_ID.get(metrics.colorBy) : undefined;
  const filterSummary = [
    seasons && isFilterActive(climate) ? describeFilter(climate) : "",
    ...thresholds.map(([id, v]) => {
      const d = METRIC_BY_ID.get(id)!;
      return `${d.label} ${d.direction === "max" ? "≤" : "≥"} ${v}`;
    }),
    layers.anomalies && avoidConflicts ? "No conflict countries" : "",
  ].filter(Boolean);

  const applyParsed = () => {
    if (!search.parsed.length) return;
    setConditions([...new Set([...climate.conditions, ...search.parsed])]);
    setQuery("");
  };

  const conditionChip = (id: ConditionId) => {
    const c = conditionById(id)!;
    return (
      <Chip key={id} selected={climate.conditions.includes(id)} onClick={() => setConditions(toggleCondition(climate.conditions, id))} title={c.detail}>
        {c.label}
      </Chip>
    );
  };

  return (
    <section className="map-legend map-finder" aria-label="Map finder" data-open={open || undefined}>
      <SectionHeader
        className="map-legend-head"
        title={<span aria-live="polite">{title}</span>}
        actions={
          <>
            <IconButton label="Previous month" icon={<IconChevronLeft />} size="sm" onClick={() => stepMonth(-1)} />
            <IconButton label="Next month" icon={<IconChevronRight />} size="sm" onClick={() => stepMonth(1)} />
            <IconButton
              label={open ? "Collapse finder" : "Expand finder"}
              icon={open ? <IconChevronDown /> : <IconChevronUp />}
              size="sm"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen(!open)}
            />
          </>
        }
      />

      {seasons ? (
        regionsStatus === "error" ? (
          <div className="map-legend-error">
            <span>Climate data is unavailable right now.</span>
            <Button size="sm" variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : regionsStatus !== "ready" ? (
          <div className="map-legend-error">
            <Spinner size={16} /> <span>Loading climate…</span>
          </div>
        ) : (
          <>
            <div className="map-legend-ramp" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${rampVars.length}, 1fr)` }}>
              {rampVars.map((v) => (
                <span key={v} style={{ background: `var(${v})` }} />
              ))}
            </div>
            <div className="map-legend-scale">
              <span>{modeDef.low}</span>
              <span>{modeDef.label === "Green" ? "Greenery (estimate)" : ""}</span>
              <span>{modeDef.high}</span>
            </div>
          </>
        )
      ) : null}

      {colorDef ? (
        <div className="map-finder-metric">
          <div className="map-legend-ramp map-legend-ramp--div" aria-hidden="true" />
          <div className="map-legend-scale">
            <span>{colorDef.direction === "max" ? colorDef.high : colorDef.low}</span>
            <span>{colorDef.label}</span>
            <span>{colorDef.direction === "max" ? colorDef.low : colorDef.high}</span>
          </div>
        </div>
      ) : null}

      {open ? (
        <div id={bodyId} className="map-finder-body">
          {seasons ? (
            <div className="map-finder-search">
              <Input
                size="sm"
                icon={<IconSearch size={16} />}
                value={query}
                placeholder="Find weather: lush, dry, warm, snow…"
                aria-label="Find climate conditions"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyParsed();
                  } else if (e.key === "Escape" && query) {
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              {query.trim() ? (
                <div className="map-finder-suggest">
                  {search.parsed.length ? (
                    <Button size="sm" variant="secondary" className="map-finder-apply" onClick={applyParsed}>
                      Add {search.parsed.map((id) => conditionById(id)!.label).join(" + ")}
                    </Button>
                  ) : null}
                  {search.presets.length ? (
                    <div className="map-finder-chips" role="group" aria-label="Matching presets">
                      {search.presets.map((p) => (
                        <Chip
                          key={p.id}
                          onClick={() => {
                            setClimate(p.filter);
                            setQuery("");
                          }}
                        >
                          {p.label}
                        </Chip>
                      ))}
                    </div>
                  ) : null}
                  {search.conditions.length ? (
                    <div className="map-finder-chips" role="group" aria-label="Matching conditions">
                      {search.conditions.map((c) => conditionChip(c.id))}
                    </div>
                  ) : !search.presets.length && !search.parsed.length ? (
                    <p className="map-finder-empty">No condition matches “{query.trim()}”.</p>
                  ) : null}
                </div>
              ) : (
                <>
                  <div className="map-finder-chips map-finder-presets" role="group" aria-label="Presets">
                    {search.presets.map((p) => (
                      <Chip key={p.id} onClick={() => setClimate(p.filter)}>
                        {p.label}
                      </Chip>
                    ))}
                  </div>
                  {climate.conditions.length ? (
                    <div className="map-finder-chips" role="group" aria-label="Active conditions">
                      {climate.conditions.map((id) => (
                        <Chip key={id} selected onRemove={() => setConditions(toggleCondition(climate.conditions, id))}>
                          {conditionById(id)?.label ?? id}
                        </Chip>
                      ))}
                    </div>
                  ) : null}
                  <Disclosure
                    summary="All conditions"
                    className="map-finder-all"
                  >
                    {GROUPS.map((g) => (
                      <div key={g} className="map-finder-group">
                        <span className="map-finder-group-name">{GROUP_LABELS[g]}</span>
                        <div className="map-finder-chips">{CONDITIONS.filter((c) => c.group === g).map((c) => conditionChip(c.id))}</div>
                      </div>
                    ))}
                  </Disclosure>
                </>
              )}
              <label className="map-lm-slider" htmlFor={comfortId}>
                <span className="map-lm-name">
                  Comfort index
                  <span className="map-lm-value num">{climate.minComfort > 0 ? `≥ ${climate.minComfort}` : "Any"}</span>
                </span>
                <input
                  id={comfortId}
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={climate.minComfort}
                  aria-valuetext={climate.minComfort > 0 ? `at least ${climate.minComfort}` : "Any"}
                  onChange={(e) => setMinComfort(Number(e.target.value))}
                />
              </label>
            </div>
          ) : null}

          {result.filtering ? (
            <div className="map-finder-results">
              <SectionHeader
                level={3}
                title="Matches"
                meta={
                  result.pending || (seasons && isFilterActive(climate) && climateStatus === "loading")
                    ? "Matching…"
                    : `${result.ranked.length} ${result.ranked.length === 1 ? "city" : "cities"}`
                }
                actions={
                  <Button size="sm" variant="ghost" onClick={clearFilters}>
                    Clear
                  </Button>
                }
              />
              {filterSummary.length ? <p className="map-finder-summary">{filterSummary.join(" · ")}</p> : null}
              {climateStatus === "error" ? (
                <div className="map-legend-error">
                  <span>City climate didn’t load.</span>
                  <Button size="sm" variant="ghost" onClick={onRetry}>
                    Retry
                  </Button>
                </div>
              ) : null}
              <label className="map-check">
                <input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} />
                <span>Hide cities that don’t match</span>
              </label>
              {result.ranked.length ? (
                <ol className="map-finder-list">
                  {result.ranked.slice(0, RESULT_LIMIT).map(({ city, traits }) => (
                    <li key={city.id}>
                      <button type="button" className="map-finder-hit" onClick={() => openCity(city.id)}>
                        <span className="map-finder-hit-name">
                          {city.name}
                          <span className="map-finder-hit-country">{city.country}</span>
                        </span>
                        {traits ? (
                          <span className="map-finder-hit-stats num">
                            {Math.round(traits.tempC)}° · {traits.precipMm} mm
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : !result.pending ? (
                <p className="map-finder-empty">Nothing matches. Try another month or fewer conditions.</p>
              ) : null}
              {result.ranked.length > RESULT_LIMIT ? (
                <p className="map-finder-more">Matching cities are ringed on the map.</p>
              ) : null}
            </div>
          ) : seasons ? (
            <p className="map-finder-hint">Search or pick conditions to find cities. Countries tint by their average month.</p>
          ) : null}

          {layers.anomalies ? (
            <div className="map-finder-key" aria-label="Anomaly key">
              <span className="map-finder-key-item">
                <span className="map-finder-dot" style={{ background: "var(--danger)" }} /> Conflict
              </span>
              <span className="map-finder-key-item">
                <span className="map-finder-dot" style={{ background: "var(--trip-c)" }} /> Advisory
              </span>
              <span className="map-finder-key-item">
                <span className="map-finder-dot" style={{ background: "var(--warning)" }} /> Hazard season
              </span>
              <span className="map-finder-key-item">
                <span className="map-finder-dot" style={{ background: "var(--info)" }} /> News alert
              </span>
              {anomaliesAsOf ? <span className="map-finder-note">Curated list, {anomaliesAsOf}. Check advisories.</span> : null}
            </div>
          ) : null}
          {layers.events && eventCount !== undefined ? (
            <p className="map-finder-note">
              {eventCount ? `${eventCount} event ${eventCount === 1 ? "stop" : "stops"} in ${MONTH_NAMES[month - 1]}` : `No events in ${MONTH_NAMES[month - 1]}`}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
