import { useId } from "react";
import { Button, Spinner } from "../../ui";
import { openCity } from "../../shell/uiStore";
import { useMapPrefs } from "../../shell/mapPrefs";
import {
  activeRanges,
  CONDITION_GROUPS,
  CONDITIONS,
  DISASTER_TYPES,
  EVENT_KINDS,
  filterCount,
  filtersActive,
  formatMetric,
  GROUP_LABELS,
  METRICS,
  metricDef,
  signalsActive,
  type ConditionId,
  type DisasterType,
  type EventKind,
  type MetricGroup,
  type MetricKey,
  type MonthScope,
  type Severity,
} from "../../lib/overlayConfig";

// The data layer's controls: what colours the land, which cities pass the filters
// (weather conditions, value ranges) and which signals (events, conflicts, disasters)
// are pinned. All state lives in useMapPrefs().overlay; MapScreen turns it into layers.

export interface DataLayerInfo {
  loading: boolean;
  failed: boolean;
  retry: () => void;
  /** Cities passing the filters, or null when no filter is active. */
  matchCount: number | null;
  /** Cities the active data could judge at all. */
  covered: number;
  /** Best matches, for the result list. */
  matches: { id: string; name: string; country: string; readout: string }[];
  climateWindow: string | null;
  /** Label of the metric the result list is ranked by. */
  rankedBy: string;
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function Chip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button type="button" className="map-chip" aria-pressed={on} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="map-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} className="map-seg-opt" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="map-block">
      <h3 className="map-block-title map-kicker">{title}</h3>
      {hint ? <p className="map-block-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <label className="map-sub-row" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="checkbox" role="switch" className="map-switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function RangeRow({ id, value, onChange }: { id: MetricKey; value: [number, number]; onChange: (v: [number, number] | null) => void }) {
  const def = metricDef(id);
  const [d0, d1] = def.domain;
  const [lo, hi] = value;
  const full = lo <= d0 && hi >= d1;
  const set = (a: number, b: number) => onChange(a <= d0 && b >= d1 ? null : [a, b]);
  return (
    <div className="map-range">
      <div className="map-range-head">
        <span className="map-range-name">{def.label}</span>
        <span className="map-range-val num">
          {full ? "Any" : `${formatMetric(id, lo)} to ${formatMetric(id, hi)}`}
        </span>
      </div>
      <div className="map-range-sliders">
        <input type="range" aria-label={`${def.label} minimum`} min={d0} max={d1} step={def.step} value={lo} onChange={(e) => set(Math.min(Number(e.target.value), hi), hi)} />
        <input type="range" aria-label={`${def.label} maximum`} min={d0} max={d1} step={def.step} value={hi} onChange={(e) => set(lo, Math.max(Number(e.target.value), lo))} />
      </div>
    </div>
  );
}

const SCOPES: { value: MonthScope; label: string }[] = [
  { value: "month", label: "This month" },
  { value: "any", label: "Any month" },
  { value: "all", label: "Year-round" },
];

const TINT_GROUPS: MetricGroup[] = ["weather", "social", "political", "infrastructure"];

export default function OverlayPanel({ info }: { info: DataLayerInfo }) {
  const overlay = useMapPrefs((s) => s.overlay);
  const patch = useMapPrefs((s) => s.patchOverlay);
  const patchSignals = useMapPrefs((s) => s.patchSignals);
  const reset = useMapPrefs((s) => s.resetOverlay);
  const sig = overlay.signals;
  const nFilters = filterCount(overlay);
  const anyFilter = filtersActive(overlay);
  const setRange = (k: MetricKey, v: [number, number] | null) => {
    const next = { ...overlay.ranges };
    if (v) next[k] = v;
    else delete next[k];
    patch({ ranges: next });
  };

  return (
    <div className="map-data">
      {info.loading ? (
        <p className="map-data-status" role="status">
          <Spinner size={14} /> Loading data…
        </p>
      ) : null}
      {info.failed ? (
        <p className="map-data-status" role="alert">
          Some data didn’t load.{" "}
          <Button size="sm" variant="ghost" onClick={info.retry}>
            Retry
          </Button>
        </p>
      ) : null}

      <Block title="Colour the land by">
        <div className="map-chips">
          <Chip on={overlay.tint === "none"} onClick={() => patch({ tint: "none" })}>
            Nothing
          </Chip>
        </div>
        {TINT_GROUPS.map((g) => (
          <div key={g} className="map-chip-group">
            <span className="map-chip-label">{GROUP_LABELS[g]}</span>
            <div className="map-chips">
              {METRICS.filter((m) => m.group === g).map((m) => (
                <Chip key={m.id} on={overlay.tint === m.id} title={`${m.hint}${m.estimated ? " (estimated)" : ""}`} onClick={() => patch({ tint: m.id })}>
                  {m.label}
                </Chip>
              ))}
            </div>
          </div>
        ))}
        {overlay.tint !== "none" ? <Switch label="Flip the scale" checked={overlay.invertTint} onChange={(v) => patch({ invertTint: v })} /> : null}
      </Block>

      <Block title={`Find places${nFilters ? ` · ${nFilters}` : ""}`} hint="Cities that pass every filter turn orange.">
        {CONDITION_GROUPS.map((g) => (
          <div key={g.id} className="map-chip-group">
            <span className="map-chip-label">{g.label}</span>
            <div className="map-chips">
              {CONDITIONS.filter((c) => c.group === g.id).map((c) => (
                <Chip key={c.id} on={overlay.conditions.includes(c.id)} title={c.rule} onClick={() => patch({ conditions: toggle<ConditionId>(overlay.conditions, c.id) })}>
                  {c.label}
                </Chip>
              ))}
            </div>
          </div>
        ))}
        <p className="map-block-hint">Pick several in a row for either, across rows for both.</p>
        <Segmented label="Months to check" value={overlay.monthScope} options={SCOPES} onChange={(v) => patch({ monthScope: v })} />

        {TINT_GROUPS.map((g) => (
          <details key={g} className="map-fold" open={METRICS.some((m) => m.group === g && activeRanges(overlay).some(([k]) => k === m.id))}>
            <summary>{GROUP_LABELS[g]} ranges</summary>
            {METRICS.filter((m) => m.group === g).map((m) => (
              <RangeRow key={m.id} id={m.id} value={overlay.ranges[m.id] ?? m.domain} onChange={(v) => setRange(m.id, v)} />
            ))}
          </details>
        ))}

        <Segmented
          label="Cities that don’t match"
          value={overlay.nonMatches}
          options={[
            { value: "dim", label: "Fade them" },
            { value: "hide", label: "Hide them" },
          ]}
          onChange={(v) => patch({ nonMatches: v })}
        />

        {anyFilter && info.matchCount !== null ? (
          <div className="map-results" aria-live="polite">
            <p className="map-results-count">
              <span className="num">{info.matchCount}</span> of <span className="num">{info.covered}</span> cities match
              {info.climateWindow ? <span className="map-block-hint"> · climate {info.climateWindow}</span> : null}
            </p>
            {info.matches.length > 0 ? <p className="map-block-hint">Top matches by {info.rankedBy.toLowerCase()}</p> : null}
            {info.matches.length > 0 ? (
              <ul className="map-results-list" aria-label={`Top matches by ${info.rankedBy}`}>
                {info.matches.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => openCity(m.id)}>
                      <span>
                        {m.name}
                        <span className="map-results-sub">{m.country}</span>
                      </span>
                      <span className="num">{m.readout}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="map-block-hint">Nothing passes. Loosen a filter.</p>
            )}
          </div>
        ) : null}
        {anyFilter || signalsActive(sig) ? (
          <Button variant="ghost" size="sm" onClick={reset}>
            Clear filters and signals
          </Button>
        ) : null}
      </Block>

      <Block title="Signals" hint="Pinned on top of the land colour. Conflicts and disasters are a fixed reference list, not a live feed.">
        <Switch label="Events" checked={sig.events} onChange={(v) => patchSignals({ events: v })} />
        {sig.events ? (
          <div className="map-sub">
            <Switch label="Only this month" checked={sig.eventsThisMonthOnly} onChange={(v) => patchSignals({ eventsThisMonthOnly: v })} />
            <div className="map-chips">
              {EVENT_KINDS.map((k) => (
                <Chip key={k.id} on={sig.eventKinds.includes(k.id)} onClick={() => patchSignals({ eventKinds: toggle<EventKind>(sig.eventKinds, k.id) })}>
                  {k.label}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
        <Switch label="Conflict zones" checked={sig.conflicts} onChange={(v) => patchSignals({ conflicts: v })} />
        <Switch label="Disasters" checked={sig.disasters} onChange={(v) => patchSignals({ disasters: v })} />
        {sig.disasters ? (
          <div className="map-sub">
            <div className="map-chips">
              {DISASTER_TYPES.map((k) => (
                <Chip key={k.id} on={sig.disasterTypes.includes(k.id)} onClick={() => patchSignals({ disasterTypes: toggle<DisasterType>(sig.disasterTypes, k.id) })}>
                  {k.label}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
        {sig.conflicts || sig.disasters ? (
          <Segmented
            label="Minimum severity"
            value={sig.minSeverity}
            options={[
              { value: 1 as Severity, label: "All" },
              { value: 2 as Severity, label: "Serious" },
              { value: 3 as Severity, label: "Severe" },
            ]}
            onChange={(v) => patchSignals({ minSeverity: v })}
          />
        ) : null}
      </Block>
    </div>
  );
}
