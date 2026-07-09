import { useMemo, useState } from "react";
import type { City } from "../../types";

/**
 * City/airport search input — mirrors the private CitySearchInput in
 * TripsPage.tsx verbatim (same .tp-search styles). Copied rather than
 * imported because the original is unexported and TripsPage is owned
 * by another workstream.
 */

/** Airport-first search over the loaded city list. */
function searchLocal(cities: City[], q: string): City[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  return cities
    .filter(
      (c) =>
        c.name.toLowerCase().includes(s) ||
        c.iata?.toLowerCase() === s ||
        c.airportName?.toLowerCase().includes(s) ||
        c.country.toLowerCase().startsWith(s)
    )
    .sort(
      (a, b) => (b.iata ? 1 : 0) - (a.iata ? 1 : 0) || b.population - a.population
    )
    .slice(0, 8);
}

export default function CitySearchInput({
  cities,
  placeholder,
  onPick,
  autoFocus,
}: {
  cities: City[];
  placeholder: string;
  onPick: (c: City) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const results = useMemo(() => searchLocal(cities, q), [cities, q]);
  return (
    <div className="tp-search">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {results.length > 0 && (
        <div className="tp-search-results">
          {results.map((c) => (
            <button
              key={c.id}
              className="tp-search-row"
              onClick={() => {
                onPick(c);
                setQ("");
              }}
            >
              <span className="tp-sr-iata">{c.iata ?? "—"}</span>
              <span className="tp-sr-name">{c.name}</span>
              <span className="tp-sr-country">{c.country}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
