import { useEffect, useMemo, useRef, useState } from "react";
import { cityIndex, formatRange, type CityIndex } from "../../lib/journal";
import { searchJourneys, suggestedJourneys } from "../../lib/inbox";
import type { City, Journey } from "../../types";

/** Popover anchored to its trigger: suggested journeys, a search over all of them, then an inline confirm (DESIGN-journal §8). */
export default function MergePicker({
  journeys,
  cities,
  range,
  suggestedId,
  count,
  onConfirm,
  onClose,
}: {
  journeys: Journey[];
  cities: City[] | CityIndex;
  range: { startDate: string; endDate: string };
  suggestedId?: string;
  /** Items being merged, for the confirm sentence. */
  count: number;
  onConfirm: (journeyId: string) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Journey | null>(null);
  const idx = useMemo(() => cityIndex(cities), [cities]);
  const suggested = useMemo(() => suggestedJourneys(range, journeys, suggestedId), [range, journeys, suggestedId]);
  const found = useMemo(() => searchJourneys(q, journeys, idx).filter((j) => !suggested.some((s) => s.id === j.id)), [q, journeys, idx, suggested]);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input")?.focus();
    const down = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [onClose]);

  const row = (j: Journey) => (
    <li key={j.id}>
      <button type="button" className="jr-merge-row" onClick={() => setPicked(j)}>
        <span className="jr-merge-title">{j.title}</span>
        <span className="jr-merge-dates">{formatRange(j.startDate, j.endDate)}</span>
      </button>
    </li>
  );

  return (
    <div
      ref={root}
      className="jr-merge"
      role="dialog"
      aria-label="Merge into an existing journey"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {picked ? (
        <div className="jr-merge-confirm" role="alert">
          <span>
            MERGE {count} {count === 1 ? "ITEM" : "ITEMS"} INTO “{picked.title}”?
          </span>
          <span className="jr-merge-confirm-actions">
            <button type="button" className="booking-primary-btn" autoFocus onClick={() => onConfirm(picked.id)}>
              MERGE
            </button>
            <button type="button" className="tm-action-btn" onClick={() => setPicked(null)}>
              KEEP
            </button>
          </span>
        </div>
      ) : (
        <>
          {suggested.length > 0 && (
            <>
              <div className="jr-label">SUGGESTED</div>
              <ul className="jr-merge-list">{suggested.map(row)}</ul>
            </>
          )}
          <label className="jr-label" htmlFor="jr-merge-q">
            ALL JOURNEYS
          </label>
          <input id="jr-merge-q" className="jr-input jr-input-sans jr-input-wide" placeholder="Search by title or city" value={q} onChange={(e) => setQ(e.target.value)} />
          {q.trim() && (found.length > 0 ? <ul className="jr-merge-list">{found.map(row)}</ul> : suggested.length === 0 && <div className="jr-hint">NO JOURNEY MATCHES</div>)}
          {!q.trim() && suggested.length === 0 && <div className="jr-hint">NOTHING NEARBY — SEARCH ABOVE</div>}
        </>
      )}
    </div>
  );
}
