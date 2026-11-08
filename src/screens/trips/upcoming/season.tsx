// Seasonal trips in the editor: a trip is a season you can take any year; picking a
// year makes it concrete (dates, flight search hints, that year's holidays).
// Pure season logic lives in lib/season.ts.

import { useEffect, useMemo, useState } from "react";
import { useMeridianStore } from "../../../store";
import { apiUrl } from "../../../lib/api";
import { fetchSeasonality, type SeasonMonth } from "../../../lib/seasonalityApi";
import {
  monthName,
  seasonText,
  spanHas,
  spanLabel,
  stopComfort,
  stopDates,
  stopEvents,
  tripSeason,
  upcomingYears,
  type DatedSpan,
  type SeasonEvent,
} from "../../../lib/season";
import { Badge, Select, Segmented, cx, rampStep } from "../../../ui";
import type { MonthSpan, Trip, TripNode } from "../../../types";

export interface TripSeasonData {
  /** Comfort per city, 12 months; null while loading or when not covered. */
  scores: Record<string, SeasonMonth[] | null>;
  events: SeasonEvent[];
}

const EMPTY: TripSeasonData = { scores: {}, events: [] };

/** How long to wait before asking again for cities the server was still fetching. */
const RETRY_MISSING_MS = 4000;

/** Comfort scores and events for the trip's cities. Refetches when the set of cities changes. */
export function useTripSeasonData(trip: Trip): TripSeasonData {
  const key = useMemo(() => [...new Set(trip.nodes.map((n) => n.cityId))].sort().join(","), [trip.nodes]);
  const [data, setData] = useState<TripSeasonData>(EMPTY);

  useEffect(() => {
    if (!key) {
      setData(EMPTY);
      return;
    }
    let live = true;
    const ids = key.split(",");
    // A city the server hasn't cached comes back null while it's fetched on demand
    // (lib/seasonalityApi.ts): ask once more for those after a short wait.
    const scores = fetchSeasonality(ids)
      .then(async (b) => {
        const missing = ids.filter((id) => !b.cities[id]);
        if (!missing.length) return b.cities;
        await new Promise((r) => setTimeout(r, RETRY_MISSING_MS));
        if (!live) return b.cities;
        const again = await fetchSeasonality(missing).catch(() => null);
        return again ? { ...b.cities, ...again.cities } : b.cities;
      })
      .catch(() => ({}) as Record<string, SeasonMonth[] | null>);
    const events = fetch(apiUrl(`/api/overlays/events?cityIds=${encodeURIComponent(key)}`))
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((b: { events?: SeasonEvent[] }) => b.events ?? [])
      .catch(() => [] as SeasonEvent[]);
    Promise.all([scores, events]).then(([s, e]) => {
      if (live) setData({ scores: s, events: e });
    });
    return () => {
      live = false;
    };
  }, [key]);

  return data;
}

/** 12 comfort cells; months outside `months` are faded. Decorative: the text beside it carries the meaning. */
export function MonthStrip({ scores, months }: { scores: SeasonMonth[] | null | undefined; months?: MonthSpan }) {
  return (
    <span className="trips-season-strip" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const score = scores?.[i]?.score;
        const on = months ? spanHas(months, m) : true;
        return (
          <span
            key={m}
            className={cx("trips-season-cell", !on && "is-off", score === undefined && "is-empty")}
            style={score !== undefined ? { background: `var(--ramp-${rampStep(score / 100)})` } : undefined}
            title={`${monthName(m)}${score !== undefined ? ` · comfort ${score}` : ""}`}
          />
        );
      })}
    </span>
  );
}

const MONTH_OPTIONS = [
  { value: "", label: "—" },
  ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: monthName(i + 1) })),
];

/** "From / to" month pickers. Clearing "from" clears the span. */
function MonthSpanPicker({
  value,
  onChange,
  label,
}: {
  value: MonthSpan | undefined;
  onChange: (span: MonthSpan | undefined) => void;
  label: string;
}) {
  return (
    <span className="trips-season-picker" role="group" aria-label={label}>
      <Select
        size="sm"
        aria-label={`${label}: from`}
        value={value ? String(value.start) : ""}
        options={MONTH_OPTIONS}
        onChange={(e) => {
          const start = Number(e.target.value);
          onChange(start ? { start, end: value?.end ?? start } : undefined);
        }}
      />
      <span aria-hidden="true">to</span>
      <Select
        size="sm"
        aria-label={`${label}: to`}
        value={value ? String(value.end) : ""}
        disabled={!value}
        options={MONTH_OPTIONS.slice(1)}
        onChange={(e) => value && onChange({ start: value.start, end: Number(e.target.value) })}
      />
    </span>
  );
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** A stop's place in the season: months, comfort there, and events while you're there. */
export function StopSeason({
  trip,
  index,
  node,
  data,
  dates,
}: {
  trip: Trip;
  index: number;
  node: TripNode;
  data: TripSeasonData;
  dates: DatedSpan | null;
}) {
  const scores = data.scores[node.cityId];
  const comfort = stopComfort(node.months, scores);
  const events = stopEvents(node, data.events, dates);
  return (
    <div className="trips-season-stop">
      <MonthSpanPicker
        label={`Months in ${node.name}`}
        value={node.months}
        onChange={(m) => useMeridianStore.getState().setStopMonths(trip.id, index, m)}
      />
      <MonthStrip scores={scores} months={node.months} />
      <span className="trips-season-note">
        {node.months ? (
          <>
            {comfort !== null ? <span className="tabular">Comfort {comfort}</span> : null}
            {dates ? (
              <span className="tabular">
                {formatDay(dates.start)} – {formatDay(dates.end)}
              </span>
            ) : null}
          </>
        ) : (
          <span>Pick when in the season you're here</span>
        )}
      </span>
      {events.length ? (
        <span className="trips-season-events">
          {events.map((e) => (
            <Badge key={e.id} tone={e.recurring ? "neutral" : "warning"} title={e.title}>
              {e.title.split(":")[0].split(" (")[0]}
              {e.date ? ` · ${formatDay(e.date)}` : ` · ${monthName(e.month)}`}
            </Badge>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** Per-stop dates for the chosen year (all null while the trip is any-year). */
export function useStopDates(trip: Trip): (DatedSpan | null)[] {
  return useMemo(
    () => (trip.year ? stopDates(trip, trip.year) : trip.nodes.map(() => null)),
    [trip]
  );
}

/** Editor sidebar: the trip's season and which year it's planned for. */
export function SeasonCard({ trip }: { trip: Trip }) {
  const season = tripSeason(trip);
  const placedStops = trip.nodes.some((n) => n.months);
  const years = season ? upcomingYears(season) : [];
  if (trip.year && !years.includes(trip.year)) years.unshift(trip.year);

  return (
    <div className="trips-season-card">
      <p className="trips-season-headline">
        {season ? spanLabel(season, "long") : "No season yet"}
        {season ? <span className="trips-season-sub">{seasonText(trip)}</span> : null}
      </p>
      {placedStops ? (
        <p className="trips-season-help">Set by the months on each stop.</p>
      ) : (
        <>
          <MonthSpanPicker
            label="Trip season"
            value={trip.season}
            onChange={(s) => useMeridianStore.getState().setTripSeason(trip.id, s)}
          />
          <p className="trips-season-help">Or give each stop its own months in the route.</p>
        </>
      )}
      {season ? (
        <div className="trips-ed-field">
          <span className="trips-ed-label">Plan for</span>
          <Segmented<string>
            label="Plan this season for a year"
            value={trip.year ? String(trip.year) : "any"}
            block
            onChange={(v) => useMeridianStore.getState().setTripYear(trip.id, v === "any" ? undefined : Number(v))}
            options={[{ value: "any", label: "Any year" }, ...years.map((y) => ({ value: String(y), label: String(y) }))]}
          />
          <p className="trips-season-help">
            {trip.year
              ? "Stops get dates, flight searches start on them, and that year's holidays show up."
              : "The season repeats every year. Pick a year to get dates and search flights."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
