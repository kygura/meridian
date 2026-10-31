import { useCallback, useEffect, useMemo, useState } from "react";
import { useMeridianStore } from "../../../store";
import { hrefFor, navigate } from "../../../lib/router";
import { JournalLockedError, refreshJourneys } from "../../../lib/journalApi";
import {
  DEFAULT_FILTERS,
  cityIndex,
  filterJourneys,
  filtersActive,
  formatEur,
  groupByYear,
  journalTags,
  journalYears,
  journeyNights,
  journeyStats,
  spendEur,
  type JournalFilters,
} from "../../../lib/journal";
import type { Journey } from "../../../types";
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  PageActions,
  Select,
  Skeleton,
  Stat,
  UnlockCard,
  useJournalToken,
} from "../../../ui";
import { IconCalendar, IconFilter, IconPlus, IconUpload } from "../../../ui/icons";
import { Stars } from "./Rating";
import { num, plural, range, stopChain } from "./format";
import "./past.css";

type LoadState = "idle" | "loading" | "error";

/** Trips › Past: stats, year and tag filters, and the journal timeline grouped by year. */
export default function PastTimeline() {
  const { token, unlocked } = useJournalToken();
  const journeys = useMeridianStore((s) => s.journeys);
  const cities = useMeridianStore((s) => s.cities);
  const openQuickLog = useMeridianStore((s) => s.openQuickLog);
  const [load, setLoad] = useState<LoadState>("idle");

  const fetchJourneys = useCallback(async () => {
    setLoad("loading");
    try {
      await refreshJourneys();
      setLoad("idle");
    } catch (e) {
      // A 401 flips the lock in the store; the UnlockCard takes over.
      setLoad(e instanceof JournalLockedError ? "idle" : "error");
    }
  }, []);

  useEffect(() => {
    if (unlocked) void fetchJourneys();
  }, [token, unlocked, fetchJourneys]);

  const logTrip = () => openQuickLog();

  return (
    <div className="trips-past">
      <PageActions>
        <Button variant="primary" icon={<IconPlus />} onClick={logTrip}>
          Log a trip
        </Button>
      </PageActions>

      {!unlocked ? (
        <UnlockCard title="Your past trips are private" />
      ) : load === "error" && !journeys ? (
        <ErrorState message="Couldn't load your trips." onRetry={() => void fetchJourneys()} />
      ) : !journeys ? (
        <TimelineSkeleton />
      ) : journeys.length === 0 ? (
        <EmptyState
          size="page"
          icon={<IconCalendar />}
          title="No trips logged yet"
          description="Log a trip by hand, or import bookings and photos from your inbox."
          action={
            <Button icon={<IconUpload />} onClick={() => navigate({ view: "inbox" })}>
              Import trips
            </Button>
          }
        />
      ) : (
        <Timeline journeys={journeys} cities={cities} />
      )}
    </div>
  );
}

function Timeline({ journeys, cities }: { journeys: Journey[]; cities: ReturnType<typeof useMeridianStore.getState>["cities"] }) {
  const cityIdx = useMemo(() => cityIndex(cities), [cities]);
  const [filters, setFilters] = useState<JournalFilters>(DEFAULT_FILTERS);
  const set = (p: Partial<JournalFilters>) => setFilters((f) => ({ ...f, ...p }));

  const years = useMemo(() => journalYears(journeys), [journeys]);
  const tags = useMemo(() => journalTags(journeys), [journeys]);
  const draftCount = useMemo(() => journeys.filter((j) => j.status === "draft").length, [journeys]);
  const shown = useMemo(() => filterJourneys(journeys, filters), [journeys, filters]);
  const groups = useMemo(() => groupByYear(shown), [shown]);
  const stats = useMemo(() => journeyStats(shown, cityIdx), [shown, cityIdx]);
  const nameOf = useCallback((id: string) => cityIdx.get(id)?.name ?? id, [cityIdx]);

  const allUnpriced = stats.journeys > 0 && stats.unpriced === stats.journeys;
  const active = filtersActive(filters);

  return (
    <>
      <Card className="trips-past-stats" role="group" aria-label="Totals">
        <Stat label="Trips" value={num(stats.journeys)} />
        <Stat label="Countries" value={num(stats.countries)} />
        <Stat label="Nights away" value={num(stats.nights)} />
        <Stat
          label="Spent"
          value={allUnpriced || stats.journeys === 0 ? "—" : formatEur(stats.spendEur)}
          hint={stats.unpriced > 0 && !allUnpriced ? `${plural(stats.unpriced, "trip")} without costs` : undefined}
        />
      </Card>

      <div className="trips-past-filters" role="group" aria-label="Filters">
        <Select
          size="sm"
          aria-label="Year"
          className="trips-past-year"
          value={filters.year === null ? "" : String(filters.year)}
          onChange={(e) => set({ year: e.target.value ? Number(e.target.value) : null })}
          options={[{ value: "", label: "All years" }, ...years.map((y) => ({ value: String(y), label: String(y) }))]}
        />
        {tags.map((t) => {
          const on = filters.tags.includes(t);
          return (
            <Chip key={t} selected={on} onClick={() => set({ tags: on ? filters.tags.filter((x) => x !== t) : [...filters.tags, t] })}>
              {t}
            </Chip>
          );
        })}
        {draftCount > 0 ? (
          <Chip selected={filters.drafts} onClick={() => set({ drafts: !filters.drafts })}>
            {`Include drafts (${draftCount})`}
          </Chip>
        ) : null}
        {active ? (
          <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)}>
            Clear
          </Button>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<IconFilter />}
          title="No trips match these filters"
          action={
            <Button variant="ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      ) : (
        groups.map((g) => (
          <section key={g.year} className="trips-past-year-group" aria-labelledby={`trips-past-y${g.year}`}>
            <header className="trips-past-year-head">
              <h2 id={`trips-past-y${g.year}`} className="trips-past-year-title num">
                {g.year}
              </h2>
              <span className="trips-past-year-meta">
                {plural(g.journeys.length, "trip")} · {plural(g.nights, "night")}
              </span>
            </header>
            <Card padding="none">
              <ul className="trips-past-list">
                {g.journeys.map((j) => (
                  <li key={j.id}>
                    <JourneyRow journey={j} chain={stopChain(j, nameOf)} />
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ))
      )}
    </>
  );
}

function JourneyRow({ journey: j, chain }: { journey: Journey; chain: string }) {
  const nights = journeyNights(j);
  const spent = spendEur(j);
  return (
    <a className="trips-past-row" href={hrefFor({ view: "trips", tab: "past", journeyId: j.id })}>
      <span className="trips-past-row-dates num">{range(j.startDate, j.endDate, false)}</span>
      <span className="trips-past-row-main">
        <span className="trips-past-row-title">
          {j.title}
          {j.status === "draft" ? (
            <Badge tone="warning" className="trips-past-row-badge">
              Draft
            </Badge>
          ) : null}
        </span>
        <span className="trips-past-row-chain">{chain}</span>
        {j.tags.length > 0 ? (
          <span className="trips-past-row-tags">
            {j.tags.map((t) => (
              <span key={t} className="trips-past-row-tag">
                {t}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="trips-past-row-side">
        <span className="trips-past-row-nights num">
          {plural(nights, "night")}
          {spent !== null ? <b className="trips-past-row-spent">{formatEur(spent)}</b> : null}
        </span>
        <Stars value={j.rating} label="Trip rating" />
      </span>
    </a>
  );
}

function TimelineSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading trips">
      <Card className="trips-past-stats">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="trips-past-skel-stat">
            <Skeleton width={56} height={12} />
            <Skeleton width={72} height={24} />
          </div>
        ))}
      </Card>
      <div className="trips-past-year-head">
        <Skeleton width={64} height={20} />
      </div>
      <Card padding="none">
        {[0, 1, 2].map((i) => (
          <div key={i} className="trips-past-skel-row">
            <Skeleton width={88} />
            <Skeleton lines={2} />
          </div>
        ))}
      </Card>
    </div>
  );
}
