import { useMemo, useState } from "react";
import { useMeridianStore } from "../../store";
import { navigate } from "../../lib/router";
import {
  DEFAULT_FILTERS,
  cityIndex,
  filterJourneys,
  filtersActive,
  groupByYear,
  journalTags,
  journalYears,
  journeyStats,
  plural,
  type JournalFilters,
} from "../../lib/journal";
import type { Journey } from "../../types";
import TimelineStats from "./TimelineStats";
import TimelineFilters from "./TimelineFilters";
import JourneyRow from "./JourneyRow";

export function startLogFromGlobe() {
  useMeridianStore.getState().setDrawMode(false);
  useMeridianStore.getState().setJournalDraw({ active: true, cityIds: [] });
  navigate("/");
}

export default function Timeline({
  journeys,
  loading,
  error,
  onRetry,
}: {
  journeys: Journey[] | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const cities = useMeridianStore((s) => s.cities);
  const openQuickLog = useMeridianStore((s) => s.openQuickLog);
  const cityIdx = useMemo(() => cityIndex(cities), [cities]);
  const [filters, setFilters] = useState<JournalFilters>(DEFAULT_FILTERS);

  const all = journeys ?? [];
  const shown = useMemo(() => filterJourneys(all, filters), [all, filters]);
  const groups = useMemo(() => groupByYear(shown), [shown]);
  const stats = useMemo(() => (journeys ? journeyStats(shown, cityIdx) : null), [journeys, shown, cityIdx]);
  const pending = loading && !journeys;

  return (
    <div className="jr-timeline">
      <header className="jr-head">
        <div>
          <div className="jr-eyebrow">JOURNAL · WHERE YOU'VE BEEN</div>
          <h1 className="jr-title">Logbook</h1>
          <div className="jr-sub">Every journey you've taken, with the conditions you actually met.</div>
        </div>
        <div className="jr-head-actions">
          <button type="button" className="booking-primary-btn" onClick={() => openQuickLog()}>+ LOG JOURNEY</button>
          <button type="button" className="tm-action-btn" onClick={startLogFromGlobe}>LOG FROM GLOBE ↗</button>
        </div>
      </header>

      {error && !journeys ? (
        <div className="jr-empty" role="alert">
          <div className="bk-error-title">⚠ COULDN'T LOAD THE JOURNAL</div>
          <button type="button" className="tm-action-btn" onClick={onRetry}>↻ RETRY</button>
        </div>
      ) : (
        <>
          <TimelineStats stats={stats} loading={pending} />
          {all.length > 0 && (
            <TimelineFilters filters={filters} years={journalYears(all)} tags={journalTags(all)} onChange={setFilters} />
          )}

          {pending && (
            <div role="status" aria-busy="true" aria-label="Loading journeys">
              {[0, 1, 2].map((i) => (
                <div key={i} className="jr-skel-group"><span className="jr-skel jr-skel-year" /><span className="jr-skel jr-skel-line" /><span className="jr-skel jr-skel-line" /></div>
              ))}
            </div>
          )}

          {journeys && all.length === 0 && (
            <div className="jr-empty jr-empty-card">
              <div className="jr-empty-title">No journeys logged yet.</div>
              <div className="jr-empty-sub">LOG ONE BY HAND, DRAW IT ON THE GLOBE, OR IMPORT YOUR BOOKINGS.</div>
              <div className="jr-empty-actions">
                <button type="button" className="booking-primary-btn" onClick={() => openQuickLog()}>+ LOG JOURNEY</button>
                <button type="button" className="tm-action-btn" onClick={startLogFromGlobe}>LOG FROM GLOBE ↗</button>
                <button type="button" className="tm-action-btn" onClick={() => navigate("/journal/inbox")}>IMPORT → INBOX</button>
              </div>
            </div>
          )}

          {journeys && all.length > 0 && groups.length === 0 && (
            <div className="jr-empty">
              <div className="cmd-empty-title">NOTHING MATCHES THESE FILTERS</div>
              <button type="button" className="tp-link" onClick={() => setFilters(DEFAULT_FILTERS)} disabled={!filtersActive(filters)}>CLEAR FILTERS</button>
            </div>
          )}

          {groups.map((g) => (
            <section key={g.year} className="jr-year-group" aria-label={String(g.year)}>
              <div className="jr-year">
                <span className="jr-year-n">{g.year}</span>
                <span className="jr-year-meta">
                  {plural(g.journeys.length, "JOURNEY")} · {plural(g.nights, "NIGHT")} · {plural(g.cities, "CITY", "CITIES")}
                </span>
                <span className="jr-year-rule" />
              </div>
              {g.journeys.map((j) => (
                <JourneyRow key={j.id} journey={j} cities={cityIdx} />
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
