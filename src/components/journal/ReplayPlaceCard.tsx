import { matchSummary } from "../../lib/replayMatch";
import type { PlaceResult } from "../../types";

/** A place from find_similar_windows: match %, month, top contributing dimensions, what it was scored on. */
export default function ReplayPlaceCard({ place, onPick }: { place: PlaceResult; onPick: (cityId: string) => void }) {
  const m = matchSummary(place.replayMatch);
  if (!m) return null;
  return (
    <button type="button" className="jr-pm" onClick={() => onPick(place.cityId)} aria-label={`${place.name}, ${m.month}: ${m.match} percent match. Open city.`}>
      <span className="jr-pm-head">
        <span className="jr-pm-name">
          {place.iata && <b>{place.iata}</b>} {place.name}
          <span className="jr-pm-country"> · {place.country}</span>
        </span>
        <span className="jr-pm-score">
          {m.match}% <span className="jr-pm-month">{m.month}</span>
        </span>
      </span>
      <span className="jr-pm-dims">
        {m.top.map((d) => (
          <span key={d.name} className="jr-pm-dim">
            <span className="jr-pm-key">{d.label}</span>
            <span className="jr-pm-bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, d.pct)}%` }} />
            </span>
            <span className="jr-pm-pct">{d.pct}%</span>
          </span>
        ))}
      </span>
      <span className="jr-pm-scored">SCORED ON {m.scoredOn.join(" · ")}</span>
    </button>
  );
}
