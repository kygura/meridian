import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../../store";
import { openCity } from "../../../shell/uiStore";
import { apiUrl } from "../../../lib/api";
import { assembleCityRows, bestWindow, climateWindowCaption, sortRows, type HeatRowDef, type SortMode } from "../../../lib/seasonality";
import { fetchRegions, fetchSeasonality, type SeasonMonth } from "../../../lib/seasonalityApi";
import { MONTH_NAMES, MONTH_SHORT } from "../../../lib/repeatCopy";
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
} from "../../../ui";
import { IconCalendar, IconClose, IconPlus, IconSearch, IconWorld } from "../../../ui/icons";
import type { City } from "../../../types";
import { HeatGrid, HeatLegend, PopRow, type HeatCell, type HeatGroup, type HeatRow } from "./HeatGrid";
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

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "best", label: "Best time first" },
  { value: "peak", label: "Highest peak" },
  { value: "az", label: "A to Z" },
];

/** "May–Sep", "All year", "Oct". */
function bestSpan(scores: number[]): string {
  const w = bestWindow(scores.map((score) => ({ score, tempC: 0, precipMm: 0 })));
  if (!w) return "";
  if (w.startMonth === 0 && w.endMonth === 11) return "All year";
  if (w.startMonth === w.endMonth) return MONTH_SHORT[w.startMonth]!;
  return `${MONTH_SHORT[w.startMonth]}–${MONTH_SHORT[w.endMonth]}`;
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
  const [sort, setSort] = useState<SortMode>("best");
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
      body: JSON.stringify({ cityId: c.id }),
    }).catch(() => {});
  };
  const removeCity = (cityId: string) => {
    removeFromShortlist(cityId);
    fetch(apiUrl(`/api/shortlist/${encodeURIComponent(cityId)}`), { method: "DELETE" }).catch(() => {});
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
    return sortRows(visible, seasonality, sort).map((d: HeatRowDef) => {
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
        const scores = months.map((m: SeasonMonth) => m.score);
        const w = bestWindow(months);
        const cells: HeatCell[] = months.map((m, col) => ({
          score: m.score,
          dot: w?.peakMonth === col,
          label: `${d.name}, ${MONTH_NAMES[col]}: ${comfortWord(m.score).toLowerCase()}, comfort ${m.score}`,
        }));
        return { ...base, state: "ready", cells, trail: <span className="plan-when-best">{bestSpan(scores)}</span> };
      }
      if (months === null) return { ...base, state: "none" };
      return { ...base, state: unavailable ? "unavailable" : "loading" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowDefs, seasonality, sort, q, region, unavailable, regionOfCountry]);

  const countryRows: HeatRow[] = useMemo(() => {
    if (!regions) return [];
    const list = regions
      .filter((r) => matches(q, r.region) && (!region || regionOfCountry.get(r.region) === region))
      .map((r) => {
        const scores = r.months.map((m) => m.score);
        return { r, scores, w: bestWindow(r.months.map((m) => ({ score: m.score, tempC: 0, precipMm: 0 }))) };
      });
    list.sort((a, b) => {
      if (sort === "az") return a.r.region.localeCompare(b.r.region);
      const pa = Math.max(...a.scores);
      const pb = Math.max(...b.scores);
      if (sort === "peak") return pb - pa || a.r.region.localeCompare(b.r.region);
      return (a.w?.startMonth ?? 12) - (b.w?.startMonth ?? 12) || pb - pa || a.r.region.localeCompare(b.r.region);
    });
    return list.map(({ r, scores, w }) => {
      const reg = regionOfCountry.get(r.region);
      return {
        key: `country:${r.region}`,
        label: r.region,
        sublabel: reg ? WORLD_REGIONS.find((x) => x.value === reg)?.label : undefined,
        state: "ready" as const,
        cells: r.months.map((m, col) => ({
          score: m.score,
          dot: w?.peakMonth === col,
          label: `${r.region}, ${MONTH_NAMES[col]}: ${comfortWord(m.score).toLowerCase()}, comfort ${m.score}`,
        })),
        trail: <span className="plan-when-best">{bestSpan(scores)}</span>,
      };
    });
  }, [regions, q, region, sort, regionOfCountry]);

  const suggestions = useMemo(
    () => (view === "cities" && q.trim().length >= 2 ? searchCities(cities, q, 5, rowIds) : []),
    [view, q, cities, rowIds]
  );

  // ── Popover ──
  const renderPopover = (row: HeatRow, col: number) => {
    const cell = row.cells?.[col];
    if (!cell) return null;
    const months = view === "cities" ? seasonality[row.key] : undefined;
    const m = Array.isArray(months) ? months[col] : undefined;
    const peak = cell.dot;
    return (
      <div>
        <div className="plan-heat-pop-title">
          {row.label}, {MONTH_NAMES[col]}
        </div>
        {row.sublabel && <div className="plan-heat-pop-sub">{row.sublabel}</div>}
        <div className="plan-heat-pop-score">
          <span className="plan-heat-pop-num">{cell.score}</span>
          <span>{comfortWord(cell.score)}</span>
        </div>
        {m && (
          <>
            <PopRow k="Temperature" v={`${Math.round(m.tempC)}°C`} />
            <PopRow k="Rain" v={`${Math.round(m.precipMm)} mm`} />
          </>
        )}
        {view === "countries" && <PopRow k="Average of" v="Cities in this country" />}
        {(peak || view === "cities") && (
          <div className="plan-heat-pop-hint">
            {peak ? "Its most comfortable month." : null}
            {peak && view === "cities" ? " " : null}
            {view === "cities" ? "Tap the name to open the city." : null}
          </div>
        )}
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
          <Select
            className="plan-when-select"
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            options={SORT_OPTIONS}
          />
        </div>
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
        <HeatLegend low="Less comfortable" high="More comfortable" />
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
          description="Add a city to see its best months, or browse every country."
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
            firstHeader="Country"
            trailHeader="Best time"
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
          label={view === "cities" ? "Best months for your cities" : "Best months by country"}
          firstHeader={view === "cities" ? "City" : "Country"}
          trailHeader="Best time"
          renderPopover={renderPopover}
        />
      )}
    </div>
  );
}
