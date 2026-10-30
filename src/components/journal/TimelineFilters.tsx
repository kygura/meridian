import type { JournalFilters } from "../../lib/journal";
import { radioKeys } from "./radioKeys";

const RATINGS: [number, string, string][] = [
  [0, "ANY", "Any rating"],
  [3, "●●●+", "3 of 5 or better"],
  [4, "●●●●+", "4 of 5 or better"],
  [5, "●●●●●", "5 of 5"],
];

export default function TimelineFilters({
  filters,
  years,
  tags,
  onChange,
}: {
  filters: JournalFilters;
  years: number[];
  tags: string[];
  onChange: (f: JournalFilters) => void;
}) {
  const set = (p: Partial<JournalFilters>) => onChange({ ...filters, ...p });
  return (
    <div className="jr-filters" role="group" aria-label="Filters">
      <div className="jr-filter">
        <span className="jr-label">YEAR</span>
        <span className="jr-seg-ctl" role="radiogroup" aria-label="Year">
          {[null, ...years].map((y) => (
            <button key={y ?? "all"} type="button" role="radio" aria-checked={filters.year === y} tabIndex={filters.year === y ? 0 : -1} onKeyDown={radioKeys} className={filters.year === y ? "on" : ""} onClick={() => set({ year: y })}>
              {y ?? "ALL"}
            </button>
          ))}
        </span>
      </div>
      <div className="jr-filter">
        <span className="jr-label">RATING</span>
        <span className="jr-seg-ctl" role="radiogroup" aria-label="Minimum rating">
          {RATINGS.map(([n, label, aria]) => (
            <button key={n} type="button" role="radio" aria-checked={filters.minRating === n} tabIndex={filters.minRating === n ? 0 : -1} onKeyDown={radioKeys} aria-label={aria} className={filters.minRating === n ? "on" : ""} onClick={() => set({ minRating: n })}>
              {label}
            </button>
          ))}
        </span>
      </div>
      {tags.length > 0 && (
        <div className="jr-filter">
          <span className="jr-label">TAG</span>
          {tags.map((t) => {
            const on = filters.tags.includes(t);
            return (
              <button key={t} type="button" className={`jr-pill${on ? " on" : ""}`} aria-pressed={on} onClick={() => set({ tags: on ? filters.tags.filter((x) => x !== t) : [...filters.tags, t] })}>
                {t}
              </button>
            );
          })}
        </div>
      )}
      <div className="jr-filter">
        <div className={`layer-toggle${filters.drafts ? " on" : ""}`} role="switch" aria-checked={filters.drafts} tabIndex={0} onClick={() => set({ drafts: !filters.drafts })} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); set({ drafts: !filters.drafts }); } }}>
          DRAFTS
        </div>
      </div>
    </div>
  );
}
