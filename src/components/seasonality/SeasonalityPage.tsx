import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../store";
import { navigate } from "../../lib/router";
import { apiUrl } from "../../lib/api";
import {
  assembleCityRows,
  sortRows,
  type SortMode,
} from "../../lib/seasonality";
import {
  fetchSeasonality,
  fetchRegions,
  type SeasonMonth,
} from "../../lib/seasonalityApi";
import SeasonHeader from "./SeasonHeader";
import HeatLegend from "./HeatLegend";
import HeatmapGrid from "./HeatmapGrid";
import CitySearchInput from "./CitySearchInput";
import type { RenderRow } from "./HeatRow";
import type { City } from "../../types";
import "../../styles/seasonality.css";

/** Delay before re-requesting null (uncovered/pending) ids once — the server
 *  fetches misses on-demand, so a second look often resolves them. */
const NULL_RETRY_MS = 4000;

/** Route container for #/seasons (DESIGN-heatmap.md §7). */
export default function SeasonalityPage() {
  const cities = useMeridianStore((s) => s.cities);
  const shortlist = useMeridianStore((s) => s.shortlist);
  const trips = useMeridianStore((s) => s.trips);
  const selectedCityId = useMeridianStore((s) => s.selectedCityId);
  const selectCity = useMeridianStore((s) => s.selectCity);
  const addToShortlist = useMeridianStore((s) => s.addToShortlist);
  const removeFromShortlist = useMeridianStore((s) => s.removeFromShortlist);
  const seasonality = useMeridianStore((s) => s.seasonality);
  const mergeSeasonality = useMeridianStore((s) => s.mergeSeasonality);
  const seasonalityRegions = useMeridianStore((s) => s.seasonalityRegions);
  const setSeasonalityRegions = useMeridianStore((s) => s.setSeasonalityRegions);
  const seasonsShowRegions = useMeridianStore((s) => s.seasonsShowRegions);
  const setSeasonsShowRegions = useMeridianStore((s) => s.setSeasonsShowRegions);

  const [sort, setSort] = useState<SortMode>("best");
  const [unavailable, setUnavailable] = useState(false);
  const [inflightCount, setInflightCount] = useState(0);
  const [regionsLoading, setRegionsLoading] = useState(false);
  const inflightRef = useRef(new Set<string>());
  const retriedRef = useRef(new Set<string>());

  const rowDefs = useMemo(
    () => assembleCityRows({ selectedCityId, shortlist, trips, cities }),
    [selectedCityId, shortlist, trips, cities]
  );

  const isEmpty = rowDefs.length === 0;
  // Empty state auto-shows region rows as a live teaser (§3.7).
  const effectiveShowRegions = seasonsShowRegions || isEmpty;

  // ── Batch fetch for uncached row cities (§7 State / §8 flow A) ────
  const rowIdsKey = rowDefs
    .map((r) => r.cityId)
    .sort()
    .join(",");
  useEffect(() => {
    const cached = useMeridianStore.getState().seasonality;
    const missing = rowDefs
      .map((r) => r.cityId)
      .filter((id) => cached[id] === undefined && !inflightRef.current.has(id));
    if (missing.length === 0) return;

    let cancelled = false;
    missing.forEach((id) => inflightRef.current.add(id));
    setInflightCount(inflightRef.current.size);

    const settle = (ids: string[]) => {
      ids.forEach((id) => inflightRef.current.delete(id));
      setInflightCount(inflightRef.current.size);
    };

    fetchSeasonality(missing)
      .then((record) => {
        if (cancelled) return;
        mergeSeasonality(record);
        setUnavailable(false);
        settle(missing);
        // Re-request nulls ONCE after ~4s — the server resolves a few
        // misses on-demand per request, so they may have filled in.
        const nulls = Object.keys(record).filter(
          (id) => record[id] === null && !retriedRef.current.has(id)
        );
        if (nulls.length > 0) {
          nulls.forEach((id) => retriedRef.current.add(id));
          setTimeout(() => {
            fetchSeasonality(nulls)
              .then((again) => mergeSeasonality(again))
              .catch(() => {});
          }, NULL_RETRY_MS);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // 503 (provider quota) or network failure — degrade, never fabricate.
        setUnavailable(true);
        settle(missing);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIdsKey]);

  // ── Regions fetch, lazily on first REGIONS-on / empty state (§5) ──
  useEffect(() => {
    if (!effectiveShowRegions || seasonalityRegions !== null || regionsLoading)
      return;
    let cancelled = false;
    setRegionsLoading(true);
    fetchRegions()
      .then((regions) => {
        if (!cancelled) setSeasonalityRegions(regions);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setRegionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveShowRegions, seasonalityRegions]);

  // ── Row models ────────────────────────────────────────────────────
  const sortedDefs = useMemo(
    () => sortRows(rowDefs, seasonality, sort),
    [rowDefs, seasonality, sort]
  );

  const cityRenderRows: RenderRow[] = sortedDefs.map((def) => {
    const months = seasonality[def.cityId];
    let rowMonths: RenderRow["months"];
    if (Array.isArray(months)) {
      rowMonths = months.map((m: SeasonMonth) => ({
        score: m.score,
        tempC: m.tempC,
        precipMm: m.precipMm,
      }));
    } else if (months === null) {
      rowMonths = null;
    } else {
      rowMonths = unavailable ? "unavailable" : "loading";
    }
    return {
      key: def.cityId,
      kind: "city",
      cityId: def.cityId,
      label: def.name,
      country: def.country,
      iata: def.iata,
      badge: def.badge,
      removable: def.badge === "SHORTLIST",
      badgeTitle: def.badge === "TRIP" ? "From a trip" : undefined,
      months: rowMonths,
    };
  });

  const regionRenderRows: RenderRow[] =
    effectiveShowRegions && seasonalityRegions
      ? seasonalityRegions.map((r) => ({
          key: `region:${r.region}`,
          kind: "region" as const,
          label: r.region,
          badge: "REGION" as const,
          removable: false,
          months: r.months.map((m) => ({ score: m.score })),
        }))
      : [];

  // ── Actions ───────────────────────────────────────────────────────
  const handleAddCity = (c: City) => {
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

  const handleSelect = (row: RenderRow) => {
    if (row.cityId) selectCity(row.cityId);
  };

  const handleGoto = (row: RenderRow) => {
    if (!row.cityId) return;
    selectCity(row.cityId);
    navigate("/");
  };

  const handleRemove = (row: RenderRow) => {
    if (!row.cityId) return;
    removeFromShortlist(row.cityId);
    fetch(apiUrl(`/api/shortlist/${encodeURIComponent(row.cityId)}`), {
      method: "DELETE",
    }).catch(() => {});
  };

  const loading = inflightCount > 0 || regionsLoading;

  return (
    <div className="seasons-page">
      <SeasonHeader
        cities={cities}
        onAddCity={handleAddCity}
        showRegions={effectiveShowRegions}
        onToggleRegions={() => setSeasonsShowRegions(!seasonsShowRegions)}
        sort={sort}
        onSortChange={setSort}
        loading={loading}
        unavailable={unavailable}
      />
      <HeatLegend />

      {isEmpty && (
        <div className="seasons-empty">
          <div className="se-card">
            <div className="se-title">No destinations charted yet.</div>
            <div className="se-sub">
              SHORTLIST A CITY ON THE GLOBE, OR ADD ONE BELOW.
            </div>
            <CitySearchInput
              cities={cities}
              placeholder="Add a city or airport…"
              onPick={handleAddCity}
            />
            <button className="tm-action-btn" onClick={() => navigate("/")}>
              BROWSE GLOBE ↗
            </button>
          </div>
        </div>
      )}

      {(cityRenderRows.length > 0 || regionRenderRows.length > 0) && (
        <HeatmapGrid
          regionRows={regionRenderRows}
          cityRows={cityRenderRows}
          regionsLabel={isEmpty ? "REGIONS · SAMPLE" : "REGIONS"}
          autoFocusCityId={selectedCityId}
          onSelect={handleSelect}
          onGoto={handleGoto}
          onRemove={handleRemove}
        />
      )}
    </div>
  );
}
