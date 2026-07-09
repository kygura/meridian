import CitySearchInput from "./CitySearchInput";
import type { City } from "../../types";
import type { SortMode } from "../../lib/seasonality";

export interface SeasonHeaderProps {
  cities: City[];
  onAddCity: (city: City) => void;
  showRegions: boolean;
  onToggleRegions: () => void;
  sort: SortMode;
  onSortChange: (sort: SortMode) => void;
  loading: boolean;
  unavailable: boolean;
}

/** Title band + control cluster (DESIGN-heatmap.md §3.1). */
export default function SeasonHeader(props: SeasonHeaderProps) {
  const {
    cities,
    onAddCity,
    showRegions,
    onToggleRegions,
    sort,
    onSortChange,
    loading,
    unavailable,
  } = props;

  return (
    <div className="season-header">
      <div>
        <div className="sh-eyebrow">COMFORT INDEX · 12-MONTH CALENDAR</div>
        <h1 className="sh-title">Seasonality</h1>
        <div className="sh-sub">
          When each destination is at its most comfortable — derived from
          multi-year climate normals. An index, not a promise.
        </div>
      </div>

      <div className="sh-controls">
        <CitySearchInput
          cities={cities}
          placeholder="Add a city or airport…"
          onPick={onAddCity}
        />
        <div
          className={`layer-toggle${showRegions ? " on" : ""}`}
          onClick={onToggleRegions}
          role="switch"
          aria-checked={showRegions}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleRegions();
            }
          }}
        >
          <span className="lt-glyph ring" />
          REGIONS
        </div>
        <select
          className="sh-sort"
          title="SORT"
          aria-label="Sort rows"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortMode)}
        >
          <option value="best">BEST WINDOW</option>
          <option value="az">A–Z</option>
          <option value="peak">PEAK SCORE</option>
        </select>
        <div className="sh-note">
          {loading ? (
            <>
              LOADING CLIMATE NORMALS…
              <span className="agent-brief-loading">
                <span />
                <span />
                <span />
              </span>
            </>
          ) : unavailable ? (
            "SEASONALITY UNAVAILABLE"
          ) : (
            "SOURCE ERA5 · 1991–2020 NORMALS"
          )}
        </div>
      </div>
    </div>
  );
}
