import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "../lib/api";
import { useMeridianStore } from "../store";
import { resolveTripColor } from "../lib/tripColors";
import type { City, Trip } from "../types";

function durationDays(trip: Trip): number {
  if (!trip.estimate) return 0;
  const { start, end } = trip.estimate.dateRange;
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000);
}

function formatDateRange(trip: Trip): string {
  if (!trip.estimate) return "—";
  const { start, end } = trip.estimate.dateRange;
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

export default function TripCandidates() {
  const {
    candidatesOverlayOpen,
    setCandidatesOverlayOpen,
    candidateFilters,
    setCandidateFilters,
    trips,
    activeTripId,
    setActiveTrip,
    setAgentCandidates,
    confirmCandidate,
    discardAgentCandidates,
    selectedCityId,
    cities,
    shortlist,
  } = useMeridianStore();

  const [loading, setLoading] = useState(false);
  const [sourceCity, setSourceCity] = useState<City | null>(null);
  const [sel, setSel] = useState(0);
  const inputHostRef = useRef<HTMLDivElement>(null);

  // Determine which city to generate candidates from: selected city first,
  // falling back to the top-scored shortlisted city.
  const targetCity = useMemo<City | null>(() => {
    if (selectedCityId) {
      const c = cities.find((c) => c.id === selectedCityId);
      if (c) return c;
    }
    if (shortlist.length > 0) {
      const c = cities.find((c) => c.id === shortlist[0].cityId);
      if (c) return c;
    }
    return null;
  }, [selectedCityId, cities, shortlist]);

  // Fetch + push candidates into the store when the overlay opens.
  useEffect(() => {
    if (!candidatesOverlayOpen) return;
    if (!targetCity) return;
    setLoading(true);
    setSourceCity(targetCity);
    fetch(apiUrl("/api/agent/trip-options"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cityId: targetCity.id }),
    })
      .then((r) => r.json())
      .then((data) => {
        setAgentCandidates(data.options ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    setTimeout(() => inputHostRef.current?.focus(), 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatesOverlayOpen, targetCity?.id]);

  const candidates = useMemo(
    () => trips.filter((t) => t.origin === "agent"),
    [trips]
  );

  const filtered = useMemo(
    () =>
      candidates.filter((c) => {
        const stops = Math.max(0, c.nodes.length - 1);
        const price = c.estimate?.priceEstimate ?? 0;
        const days = durationDays(c);
        return (
          price <= candidateFilters.maxBudget &&
          stops <= candidateFilters.maxStops &&
          days <= candidateFilters.maxDays
        );
      }),
    [candidates, candidateFilters]
  );

  // Keep selection in range and preview the focused candidate on the globe.
  useEffect(() => {
    if (!candidatesOverlayOpen) return;
    if (filtered.length === 0) return;
    const clamped = Math.min(sel, filtered.length - 1);
    if (clamped !== sel) setSel(clamped);
    const focused = filtered[clamped];
    if (focused && focused.id !== activeTripId) setActiveTrip(focused.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sel, candidatesOverlayOpen]);

  const close = (discard: boolean) => {
    if (discard) discardAgentCandidates();
    setCandidatesOverlayOpen(false);
    setSel(0);
  };

  const confirm = (tripId: string) => {
    confirmCandidate(tripId);
    // Promoting one candidate leaves the rest as unconfirmed drafts —
    // clear them so they don't linger as dashed arcs on the globe.
    discardAgentCandidates();
    setCandidatesOverlayOpen(false);
    setSel(0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const focused = filtered[sel];
      if (focused) confirm(focused.id);
    }
  };

  if (!candidatesOverlayOpen) return null;

  return (
    <div className="cmd-overlay" onMouseDown={() => close(true)}>
      <div
        className="cmd-panel candidates-panel"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={inputHostRef}
        onKeyDown={onKeyDown}
      >
        <div className="cmd-input-row">
          <span className="cmd-prompt">✈</span>
          <div className="candidates-title">
            TRIP CANDIDATES
            <span className="candidates-subtitle">
              {sourceCity ? ` from ${sourceCity.name} (${sourceCity.iata ?? "—"})` : ""}
            </span>
          </div>
        </div>

        <div className="candidates-filters">
          <FilterSlider
            label="MAX BUDGET"
            value={candidateFilters.maxBudget}
            min={50}
            max={1500}
            step={25}
            format={(v) => `$${v}`}
            onChange={(v) => setCandidateFilters({ maxBudget: v })}
          />
          <FilterSlider
            label="MAX STOPS"
            value={candidateFilters.maxStops}
            min={0}
            max={4}
            step={1}
            format={(v) => `${v}`}
            onChange={(v) => setCandidateFilters({ maxStops: v })}
          />
          <FilterSlider
            label="MAX DAYS"
            value={candidateFilters.maxDays}
            min={2}
            max={21}
            step={1}
            format={(v) => `${v}d`}
            onChange={(v) => setCandidateFilters({ maxDays: v })}
          />
        </div>

        <div className="cmd-body">
          {loading && (
            <div className="agent-brief-loading" style={{ margin: "20px 16px" }}>
              <span />
              <span />
              <span />
            </div>
          )}

          {!loading && !targetCity && (
            <div className="cmd-empty">
              <div className="cmd-empty-title">NO CITY SELECTED</div>
              <div className="cmd-empty-sub">
                Select a city on the globe or save one to your shortlist to generate
                trip candidates from it.
              </div>
            </div>
          )}

          {!loading && targetCity && filtered.length === 0 && candidates.length > 0 && (
            <div className="cmd-empty">
              <div className="cmd-empty-title">NO MATCHES</div>
              <div className="cmd-empty-sub">
                No candidates fit the current filters. Loosen budget, stops, or trip
                length above.
              </div>
            </div>
          )}

          {!loading &&
            filtered.map((c, i) => (
              <div
                key={c.id}
                className={`cmd-row candidate-row ${sel === i ? "sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => confirm(c.id)}
              >
                <span
                  className="candidate-color-bar"
                  style={{ background: resolveTripColor(c.color) }}
                />
                <div className="candidate-main">
                  <div className="candidate-route">
                    {c.nodes.map((n, ni) => (
                      <span key={ni}>
                        {n.iata || "???"}
                        {ni < c.nodes.length - 1 && <span className="iata-arrow">→</span>}
                      </span>
                    ))}
                  </div>
                  <div className="candidate-highlight">{c.name}</div>
                </div>
                <div className="candidate-meta">
                  <div className="candidate-price">
                    {c.estimate ? `$${c.estimate.priceEstimate}` : "—"}
                  </div>
                  <div className="candidate-dates">{formatDateRange(c)}</div>
                </div>
                <span className="cmd-row-hint">{sel === i ? "↵ confirm" : ""}</span>
              </div>
            ))}
        </div>

        <div className="candidates-footer">
          <span>↑↓ browse · ↵ confirm trip · esc discard</span>
        </div>
      </div>
    </div>
  );
}

function FilterSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="filter-slider">
      <div className="filter-slider-row">
        <span className="filter-slider-label">{label}</span>
        <span className="filter-slider-value">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}
