import { useMeridianStore } from "../store";

export default function RegionCard() {
  const { selectedCityId, cities } = useMeridianStore();

  const city = cities.find((c) => c.id === selectedCityId);
  if (!city) return null;

  const latStr =
    city.lat >= 0
      ? `${city.lat.toFixed(2)}°N`
      : `${Math.abs(city.lat).toFixed(2)}°S`;
  const lonStr =
    city.lng >= 0
      ? `${city.lng.toFixed(2)}°E`
      : `${Math.abs(city.lng).toFixed(2)}°W`;

  const popStr = city.population
    ? city.population >= 1_000_000
      ? `${(city.population / 1_000_000).toFixed(1)}M`
      : `${(city.population / 1_000).toFixed(0)}K`
    : "—";

  return (
    <div className="region-card">
      <div className="rc-eyebrow">REGION FOCUS</div>
      <div className="rc-iata-row">
        <div className="rc-iata">{city.iata || "—"}</div>
        <div className="rc-city">
          {city.name
            .split(" ")
            .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
            .join(" ")}
        </div>
      </div>
      <div className="rc-country">
        {city.country.toUpperCase()}
        {city.region ? ` · ${city.region.toUpperCase()}` : ""}
      </div>
      <div className="rc-coords">
        {latStr} · {lonStr}
        {city.timezone ? ` · UTC${city.timezone}` : ""}
      </div>

      <div className="rc-stats">
        <div className="rc-stat">
          <div className="key">POP</div>
          <div className="val">{popStr}</div>
        </div>
        <div className="rc-stat">
          <div className="key">CCY</div>
          <div className="val">{city.currency || "—"}</div>
        </div>
        <div className="rc-stat">
          <div className="key">VISA</div>
          <div className="val" style={{ fontSize: 11 }}>
            —
          </div>
        </div>
      </div>
    </div>
  );
}
