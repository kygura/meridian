import type { JournalStats } from "../../lib/journal";
import { formatEur } from "../../lib/journal";

const LABELS = ["COUNTRIES", "CITIES", "NIGHTS AWAY", "KM FLOWN", "SPENT (EUR)"];
const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** Five-cell header strip over the filtered, confirmed journeys (§4). Absent spend is a dash, never 0. */
export default function TimelineStats({ stats, loading }: { stats: JournalStats | null; loading: boolean }) {
  const values = stats
    ? [
        n(stats.countries),
        n(stats.cities),
        n(stats.nights),
        n(stats.km),
        stats.journeys > 0 && stats.unpriced === stats.journeys ? "—" : formatEur(stats.spendEur),
      ]
    : [];
  return (
    <div className="jr-stats" role="group" aria-label="Journal totals">
      {LABELS.map((label, i) => (
        <div key={label} className="jr-stat">
          {loading || !stats ? <span className="jr-skel" aria-hidden="true" /> : <div className="jr-stat-val">{values[i]}</div>}
          <div className="jr-stat-label">{label}</div>
          {i === 4 && stats && stats.unpriced > 0 && stats.journeys > 0 && (
            <div className="jr-stat-sub">
              {stats.unpriced} {stats.unpriced === 1 ? "JOURNEY" : "JOURNEYS"} UNPRICED
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
