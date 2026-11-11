import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../../store";
import { openCity } from "../../../shell/uiStore";
import { apiCredentials, apiUrl } from "../../../lib/api";
import { assembleCityRows, climateWindowCaption } from "../../../lib/seasonality";
import { CLIMATE_MODES, valueStep, type ClimateMode } from "../../../lib/climate";
import {
  columnsInWindow,
  describeMetric,
  formatMetric,
  frameBreakdown,
  frameColumns,
  frameValues,
  monthsInRange,
  windowLabel,
  windowScore,
  type FrameMonth,
  type Timeframe,
} from "../../../lib/heatFrame";
import { fetchRegions, fetchSeasonality, fetchWeekly, type SeasonMonth, type SeasonWeek } from "../../../lib/seasonalityApi";
import { scoreStep } from "../../../lib/repeatCopy";
import { WORLD_REGIONS, countryRegions, type WorldRegion } from "../../../lib/worldRegion";
import {
  Button,
  Chip,
  CitySearch,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Segmented,
  Select,
  Spinner,
  searchCities,
  toast,
} from "../../../ui";
import { ComfortBreakdown } from "../../../ui/ComfortBreakdown";
import { IconCalendar, IconClose, IconPlus, IconSearch, IconWorld } from "../../../ui/icons";
import type { City } from "../../../types";
import { HeatGrid, HeatLegend, PopRow, type HeatCell, type HeatGridProps, type HeatGroup, type HeatRow } from "./HeatGrid";
import "./when.css";

/** The server resolves a few uncovered cities per request, so nulls are asked for once more. */
const NULL_RETRY_MS = 4000;

const COMFORT_WORDS = ["Harsh", "Poor", "Mild", "Fair", "Good", "Great"] as const;

function comfortWord(score: number): string {
  if (score >= 84) return COMFORT_WORDS[5];
  if (score >= 67) return COMFORT_WORDS[4];
  if (score >= 51) return COMFORT_WORDS[3];
  if (score >= 34) return COMFORT_WORDS[2];
  if (score >= 17) return COMFORT_WORDS[1];
  return COMFORT_WORDS[0];
}

type View = "cities" | "countries";

const RAMP: Record<ClimateMode, NonNullable<HeatGridProps["ramp"]>> = {
  comfort: "ramp",
  temperature: "temp",
  rainfall: "wet",
  greenery: "green",
  air: "smoke",
};

const METRIC_NAMES: Record<ClimateMode, string> = {
  comfort: "Comfort",
  temperature: "Temperature",
  rainfall: "Rain",
  greenery: "Greenery",
  air: "Air quality",
};

const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: "months", label: "Months" },
  { value: "seasons", label: "Seasons" },
  { value: "weeks", label: "Weeks" },
];

const PREFS_KEY = "meridian.when.frame";

function readPrefs(): { metric: ClimateMode; timeframe: Timeframe } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    const metric = CLIMATE_MODES.some((m) => m.value === raw.metric) ? (raw.metric as ClimateMode) : "comfort";
    const timeframe: Timeframe = raw.timeframe === "seasons" ? "seasons" : raw.timeframe === "weeks" ? "weeks" : "months";
    return { metric, timeframe };
  } catch {
    return { metric: "comfort", timeframe: "months" };
  }
}

/** Cells for one place: the chosen metric over the chosen timeframe. Values show on hover, not in the cell. */
function frameCells(
  name: string,
  months: FrameMonth[],
  metric: ClimateMode,
  tf: Timeframe,
  weeks?: FrameMonth[] | null
): (HeatCell | null)[] {
  const cols = frameColumns(tf);
  const comfort = frameValues(months, "comfort", tf, weeks);
  const values = metric === "comfort" ? comfort : frameValues(months, metric, tf, weeks);
  // Weeks without weekly normals show their month's figure; say so in the cell's name.
  const monthly = tf === "weeks" && !(weeks && weeks.length === 52) ? ", monthly figure" : "";
  return values.map((v, col): HeatCell | null => {
    if (v === null) return null;
    const what = metric === "comfort" ? `${comfortWord(v).toLowerCase()}, comfort ${Math.round(v)}` : describeMetric(metric, v);
    return {
      score: comfort[col] ?? 0,
      step: metric === "comfort" ? scoreStep(v) : valueStep(metric, v),
      label: `${name}, ${cols[col]!.name}: ${what}${monthly}`,
    };
  });
}

type When = "now" | "dates";
type Sort = "fit" | "az";

const SORT_OPTIONS: { value: Sort; label: string }[] = [
  { value: "fit", label: "Best first" },
  { value: "az", label: "A to Z" },
];

/** Local "YYYY-MM-DD", `days` from today. */
function isoDay(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Best first (places without a score last), then A to Z. */
function byFit<T>(items: T[], score: (x: T) => number | null, name: (x: T) => string, sort: Sort): T[] {
  return [...items].sort((a, b) => {
    if (sort === "az") return name(a).localeCompare(name(b));
    const sa = score(a);
    const sb = score(b);
    if (sa === null || sb === null) return sa === sb ? name(a).localeCompare(name(b)) : sa === null ? 1 : -1;
    return sb - sa || name(a).localeCompare(name(b));
  });
}

function FitTrail({ score }: { score: number | null }) {
  if (score === null) return <span className="plan-when-fit is-none">—</span>;
  return (
    <span className="plan-when-fit">
      <span className="plan-when-fit-num">{Math.round(score)}</span> {comfortWord(score)}
    </span>
  );
}

function matches(q: string, ...fields: (string | undefined)[]): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return fields.some((f) => f?.toLowerCase().includes(s));
}

/** #/plan/when: the seasons heatmap. Rows are your cities or every country, columns are months. */
export default function WhenToGo() {
  const cities = useMeridianStore((s) => s.cities);
  const shortlist = useMeridianStore((s) => s.shortlist);
  const trips = useMeridianStore((s) => s.trips);
  const addToShortlist = useMeridianStore((s) => s.addToShortlist);
  const removeFromShortlist = useMeridianStore((s) => s.removeFromShortlist);
  const seasonality = useMeridianStore((s) => s.seasonality);
  const mergeSeasonality = useMeridianStore((s) => s.mergeSeasonality);
  const regions = useMeridianStore((s) => s.seasonalityRegions);
  const setRegions = useMeridianStore((s) => s.setSeasonalityRegions);
  const climateWindow = useMeridianStore((s) => s.seasonalityWindow);
  const setClimateWindow = useMeridianStore((s) => s.setSeasonalityWindow);
  const showRegions = useMeridianStore((s) => s.seasonsShowRegions);
  const setShowRegions = useMeridianStore((s) => s.setSeasonsShowRegions);

  const view: View = showRegions ? "countries" : "cities";
  const [q, setQ] = useState("");
  const [region, setRegion] = useState<WorldRegion | "">("");
  const [sort, setSort] = useState<Sort>("fit");
  const [when, setWhen] = useState<When>("now");
  const [from, setFrom] = useState(() => isoDay());
  const [to, setTo] = useState(() => isoDay(14));
  const nowMonth = new Date().getMonth();
  const rangeMonths = useMemo(() => monthsInRange(from, to), [from, to]);
  const rangeInvalid = when === "dates" && rangeMonths === null;
  // The window everything is ranked on: this month, or the months the dates touch.
  const span = useMemo(
    () => (when === "dates" && rangeMonths ? rangeMonths : [nowMonth]),
    [when, rangeMonths, nowMonth]
  );
  const windowKey = span.join(",");
  const [metric, setMetric] = useState<ClimateMode>(() => readPrefs().metric);
  const [timeframe, setTimeframe] = useState<Timeframe>(() => readPrefs().timeframe);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ metric, timeframe }));
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }, [metric, timeframe]);
  // Weekly normals for the city rows, fetched when the Weeks timeframe is chosen. null = none yet (months stand in).
  const [weekly, setWeekly] = useState<Record<string, SeasonWeek[] | null>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [regionsError, setRegionsError] = useState(false);
  const [inflight, setInflight] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const inflightRef = useRef(new Set<string>());
  const retriedRef = useRef(new Set<string>());

  const cityById = useMemo(() => new Map(cities.map((c) => [c.id, c])), [cities]);
  const regionOfCountry = useMemo(() => countryRegions(cities), [cities]);

  const rowDefs = useMemo(
    () =>
      assembleCityRows({
        selectedCityId: null,
        shortlist,
        trips: trips.filter((t) => t.origin !== "agent"),
        cities,
      }),
    [shortlist, trips, cities]
  );
  const rowIds = useMemo(() => new Set(rowDefs.map((r) => r.cityId)), [rowDefs]);

  // ── Seasonality for the city rows (batched; nulls asked for once more) ──
  const idsKey = [...rowIds].sort().join(",");
  useEffect(() => {
    const cached = useMeridianStore.getState().seasonality;
    const missing = [...rowIds].filter((id) => cached[id] === undefined && !inflightRef.current.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    missing.forEach((id) => inflightRef.current.add(id));
    setInflight(inflightRef.current.size);
    const settle = () => {
      missing.forEach((id) => inflightRef.current.delete(id));
      setInflight(inflightRef.current.size);
    };
    fetchSeasonality(missing)
      .then(({ cities: record, window: dataWindow }) => {
        settle();
        setClimateWindow(dataWindow);
        // Merge even when this effect was superseded: the data is still good, and the
        // newer run skipped these ids because they were in flight.
        mergeSeasonality(record);
        if (cancelled) return;
        setUnavailable(false);
        const nulls = Object.keys(record).filter((id) => record[id] === null && !retriedRef.current.has(id));
        if (nulls.length > 0) {
          nulls.forEach((id) => retriedRef.current.add(id));
          retryTimer = window.setTimeout(() => {
            fetchSeasonality(nulls)
              .then((again) => mergeSeasonality(again.cities))
              .catch(() => {});
          }, NULL_RETRY_MS);
        }
      })
      .catch(() => {
        settle();
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, attempt]);

  // ── Weekly normals, once the Weeks timeframe is chosen ──
  useEffect(() => {
    if (timeframe !== "weeks") return;
    const missing = [...rowIds].filter((id) => weekly[id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    fetchWeekly(missing)
      .then((r) => !cancelled && setWeekly((w) => ({ ...w, ...r })))
      .catch(() => !cancelled && setWeekly((w) => ({ ...w, ...Object.fromEntries(missing.map((id) => [id, null])) })));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframe, idsKey]);

  // ── Country aggregates, on first switch to countries ──
  const [regionsLoading, setRegionsLoading] = useState(false);
  useEffect(() => {
    if (view !== "countries" || regions !== null) return;
    let cancelled = false;
    setRegionsLoading(true);
    setRegionsError(false);
    fetchRegions()
      .then((r) => {
        setClimateWindow(r.window);
        if (!cancelled) setRegions(r.regions);
      })
      .catch(() => !cancelled && setRegionsError(true))
      .finally(() => !cancelled && setRegionsLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, regions, attempt]);

  // ── Actions ──
  const addCity = (c: City) => {
    if (shortlist.some((s) => s.cityId === c.id)) return;
    addToShortlist({
      cityId: c.id,
      name: c.name,
      country: c.country,
      lat: c.lat,
      lng: c.lng,
      iata: c.iata,
      addedAt: new Date().toISOString(),
      score: undefined,
    });
    fetch(apiUrl("/api/shortlist"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: apiCredentials,
      body: JSON.stringify({ cityId: c.id }),
    })
      .then((r) => {
        // Saving places is owner-only (ADR 0009): signed out, undo the local add and say why.
        if (r.status !== 401) return;
        removeFromShortlist(c.id);
        toast("Sign in to save places. You'll find it in Settings.", { tone: "warning" });
      })
      .catch(() => {});
  };
  const removeCity = (cityId: string) => {
    removeFromShortlist(cityId);
    fetch(apiUrl(`/api/shortlist/${encodeURIComponent(cityId)}`), { method: "DELETE", credentials: apiCredentials }).catch(() => {});
  };
  const retry = () => {
    retriedRef.current.clear();
    setUnavailable(false);
    setRegionsError(false);
    setAttempt((n) => n + 1);
  };

  // ── Rows ──
  const regionOfCity = (id: string): WorldRegion | undefined => {
    const c = cityById.get(id);
    return c ? regionOfCountry.get(c.country) : undefined;
  };

  const cityRows: HeatRow[] = useMemo(() => {
    const visible = rowDefs.filter(
      (d) => matches(q, d.name, d.country, d.iata) && (!region || regionOfCity(d.cityId) === region)
    );
    const scoreOf = (id: string) => {
      const m = seasonality[id];
      return Array.isArray(m) && m.length === 12 ? windowScore(m, span) : null;
    };
    return byFit(visible, (d) => scoreOf(d.cityId), (d) => d.name, sort).map((d) => {
      const months = seasonality[d.cityId];
      const saved = d.badge === "SHORTLIST";
      const sub = [d.country, d.badge === "TRIP" ? "In a trip" : null].filter(Boolean).join(" · ");
      const base: HeatRow = {
        key: d.cityId,
        label: d.name,
        sublabel: sub,
        onOpen: () => openCity(d.cityId),
        openLabel: `Open ${d.name}`,
        state: "loading",
        extra: saved ? (
          <IconButton
            size="sm"
            variant="ghost"
            label={`Remove ${d.name}`}
            icon={<IconClose size={16} />}
            onClick={() => removeCity(d.cityId)}
          />
        ) : undefined,
      };
      if (Array.isArray(months) && months.length === 12) {
        const cells = frameCells(d.name, months as SeasonMonth[], metric, timeframe, weekly[d.cityId]);
        return { ...base, state: "ready", cells, trail: <FitTrail score={scoreOf(d.cityId)} /> };
      }
      if (months === null) return { ...base, state: "none" };
      return { ...base, state: unavailable ? "unavailable" : "loading" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowDefs, seasonality, sort, q, region, unavailable, regionOfCountry, metric, timeframe, windowKey, weekly]);

  const countryRows: HeatRow[] = useMemo(() => {
    if (!regions) return [];
    const list = regions
      .filter((r) => matches(q, r.region) && (!region || regionOfCountry.get(r.region) === region))
      .map((r) => ({ r, score: windowScore(r.months, span) }));
    return byFit(list, (x) => x.score, (x) => x.r.region, sort).map(({ r, score }) => {
      const reg = regionOfCountry.get(r.region);
      return {
        key: `country:${r.region}`,
        label: r.region,
        sublabel: reg ? WORLD_REGIONS.find((x) => x.value === reg)?.label : undefined,
        state: "ready" as const,
        cells: frameCells(r.region, r.months, metric, timeframe),
        trail: <FitTrail score={score} />,
      };
    });
  }, [regions, q, region, sort, regionOfCountry, metric, timeframe, windowKey]);

  const suggestions = useMemo(
    () => (view === "cities" && q.trim().length >= 2 ? searchCities(cities, q, 5, rowIds) : []),
    [view, q, cities, rowIds]
  );

  // ── Popover ──
  const columns = frameColumns(timeframe);
  const windowCols = columnsInWindow(timeframe, span);
  const fitHeader = when === "now" ? "This month" : "Your dates";
  const renderPopover = (row: HeatRow, col: number) => {
    const cell = row.cells?.[col];
    if (!cell) return null;
    const months: FrameMonth[] | undefined =
      view === "cities"
        ? (Array.isArray(seasonality[row.key]) ? (seasonality[row.key] as SeasonMonth[]) : undefined)
        : regions?.find((r) => `country:${r.region}` === row.key)?.months;
    const wk = view === "cities" ? weekly[row.key] : null;
    const at = (m: ClimateMode) => (months ? frameValues(months, m, timeframe, wk)[col] : null);
    const parts = months ? frameBreakdown(months, timeframe, col, wk) : null;
    const v = at(metric);
    const others = CLIMATE_MODES.filter((m) => m.value !== metric);
    return (
      <div>
        <div className="plan-heat-pop-title">
          {row.label}, {columns[col]!.name}
        </div>
        {row.sublabel && <div className="plan-heat-pop-sub">{row.sublabel}</div>}
        <div className="plan-heat-pop-score">
          <span className="plan-heat-pop-num">{v === null ? "—" : formatMetric(metric, v)}</span>
          <span>
            {metric === "comfort"
              ? comfortWord(v ?? 0)
              : metric === "rainfall"
                ? "mm a month"
                : metric === "temperature"
                  ? "mean °C"
                  : metric === "air"
                    ? "µg/m³ PM2.5"
                    : "Greenery"}
          </span>
        </div>
        {parts && <ComfortBreakdown tempC={parts.tempC} precipMm={parts.precipMm} pm25={parts.pm25} per={parts.per} annualPrecipMm={parts.annualPrecipMm} />}
        {others.map((m) => {
          const x = at(m.value);
          if (x === null) return null;
          return (
            <PopRow
              key={m.value}
              k={METRIC_NAMES[m.value]}
              v={
                m.value === "temperature"
                  ? `${Math.round(x)}°C`
                  : m.value === "rainfall"
                    ? `${Math.round(x)} mm`
                    : m.value === "comfort"
                      ? `${Math.round(x)} · ${comfortWord(x)}`
                      : m.value === "air"
                        ? `${Math.round(x)} µg/m³`
                        : String(Math.round(x))
              }
            />
          );
        })}
        {timeframe === "seasons" && <PopRow k="Averaged over" v="Three months" />}
        {timeframe === "weeks" && view === "cities" && !(wk && wk.length === 52) && <PopRow k="Resolution" v="Monthly figure (no weekly data yet)" />}
        {timeframe === "weeks" && view === "countries" && <PopRow k="Resolution" v="Monthly figure" />}
        {view === "countries" && <PopRow k="Average of" v="Cities in this country" />}
        <div className="plan-heat-pop-hint">
          {windowCols.includes(col) ? (when === "now" ? "This month. " : "Inside your dates. ") : ""}
          {metric === "greenery" ? "Greenery is estimated from rain and warmth. " : ""}
          {metric === "air" ? "Air is the monthly mean PM2.5 from the CAMS model, which smooths local peaks. " : ""}
          {view === "cities" ? "Tap the name to open the city." : null}
        </div>
      </div>
    );
  };

  const loading = inflight > 0 || regionsLoading;
  const filtered = q.trim() !== "" || region !== "";
  const rows = view === "cities" ? cityRows : countryRows;
  const groups: HeatGroup[] = [{ key: view, rows }];
  const allUnavailable =
    view === "cities" ? unavailable && rowDefs.length > 0 && rowDefs.every((d) => !Array.isArray(seasonality[d.cityId])) : regionsError;

  return (
    <div className="plan-when">
      <div className="plan-when-toolbar">
        <Input
          className="plan-when-search"
          icon={<IconSearch size={18} />}
          type="search"
          placeholder={view === "cities" ? "Search or add a city" : "Search countries"}
          aria-label={view === "cities" ? "Search or add a city" : "Search countries"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-page-search
        />
        <div className="plan-when-controls">
          <Segmented<View>
            className="plan-when-seg"
            label="Rows"
            value={view}
            onChange={(v) => setShowRegions(v === "countries")}
            options={[
              { value: "cities", label: "Your cities" },
              { value: "countries", label: "All countries" },
            ]}
          />
          <Select
            className="plan-when-select"
            aria-label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value as WorldRegion | "")}
            options={[{ value: "", label: "All regions" }, ...WORLD_REGIONS]}
          />
          <Segmented<ClimateMode>
            className="plan-when-seg"
            label="Metric"
            value={metric}
            onChange={setMetric}
            options={CLIMATE_MODES.map((m) => ({ value: m.value, label: m.label }))}
          />
          <Segmented<Timeframe>
            className="plan-when-seg"
            label="Timeframe"
            value={timeframe}
            onChange={setTimeframe}
            options={TIMEFRAMES}
          />
          <Select
            className="plan-when-select"
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            options={SORT_OPTIONS}
          />
        </div>
      </div>

      <div className="plan-when-time" role="group" aria-label="Time to rank by">
        <Segmented<When>
          className="plan-when-seg"
          label="When"
          value={when}
          onChange={setWhen}
          options={[
            { value: "now", label: "Right now" },
            { value: "dates", label: "Pick dates" },
          ]}
        />
        {when === "dates" && (
          <div className="plan-when-dates">
            <Input
              type="date"
              aria-label="Start date"
              value={from}
              onChange={(e) => {
                const v = e.target.value;
                setFrom(v);
                if (v && to && v > to) setTo(v);
              }}
            />
            <span className="plan-when-dates-sep" aria-hidden="true">
              to
            </span>
            <Input type="date" aria-label="End date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
        <span className={rangeInvalid ? "plan-when-time-note is-error" : "plan-when-time-note"} role="status">
          {rangeInvalid
            ? "Pick a start and an end date."
            : `Ranked by comfort in ${windowLabel(span)}${when === "now" ? ", this month" : ""}`}
        </span>
      </div>

      {suggestions.length > 0 && (
        <div className="plan-when-suggest" role="group" aria-label="Add a city">
          <span className="plan-when-suggest-label">Add</span>
          {suggestions.map((c) => (
            <Chip
              key={c.id}
              icon={<IconPlus size={16} />}
              onClick={() => {
                addCity(c);
                setQ("");
              }}
            >
              {c.name}
              <span className="plan-when-suggest-country">, {c.country}</span>
            </Chip>
          ))}
        </div>
      )}

      <div className="plan-when-meta">
        <HeatLegend
          low={CLIMATE_MODES.find((m) => m.value === metric)!.low}
          high={CLIMATE_MODES.find((m) => m.value === metric)!.high}
          ramp={RAMP[metric]}
        />
        <span className="plan-when-note" role="status">
          {loading ? (
            <>
              <Spinner size={14} /> Loading climate data
            </>
          ) : (
            climateWindowCaption(climateWindow)
          )}
        </span>
      </div>

      {allUnavailable ? (
        <ErrorState message="Seasons data isn't available right now." onRetry={retry} />
      ) : view === "cities" && rowDefs.length === 0 ? (
        <EmptyState
          size="inline"
          icon={<IconCalendar />}
          title="No cities to compare yet"
          description="Add a city to see how it fares through the year, or browse every country."
          action={
            <div className="plan-when-empty-actions">
              <CitySearch onPick={addCity} placeholder="Add a city" aria-label="Add a city" />
              <Button variant="ghost" icon={<IconWorld />} onClick={() => setShowRegions(true)}>
                Browse all countries
              </Button>
            </div>
          }
        />
      ) : view === "countries" && !regions ? (
        <div className="plan-when-skeleton" aria-busy="true" aria-label="Loading countries">
          <HeatGrid
            groups={[
              {
                key: "sk",
                rows: Array.from({ length: 6 }, (_, i) => ({ key: `sk${i}`, label: "", state: "loading" as const })),
              },
            ]}
            label="Loading"
            columns={columns}
            firstHeader="Country"
            trailHeader={fitHeader}
            renderPopover={() => null}
          />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          size="inline"
          icon={<IconSearch />}
          title={filtered ? "No places match these filters" : "Nothing to show"}
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setQ("");
                  setRegion("");
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <HeatGrid
          groups={groups}
          label={`${METRIC_NAMES[metric]} by ${timeframe === "months" ? "month" : timeframe === "weeks" ? "week" : "season"}, ${view === "cities" ? "your cities" : "every country"}`}
          firstHeader={view === "cities" ? "City" : "Country"}
          trailHeader={fitHeader}
          renderPopover={renderPopover}
          columns={columns}
          windowCols={windowCols}
          dense
          markedCols={windowCols.map((col) => ({ col, label: when === "now" ? "this month" : "in your dates" }))}
          ramp={RAMP[metric]}
        />
      )}
    </div>
  );
}
