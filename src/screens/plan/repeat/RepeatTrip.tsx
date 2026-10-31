import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../../store";
import { JournalApiError, JournalLockedError, getJourney, refreshJourneys, runReplay } from "../../../lib/journalApi";
import { resultKey } from "../../../lib/replayGrid";
import {
  DEFAULT_CONTROLS,
  buildQuery,
  controlsFromQuery,
  narrowQuery,
  shiftMonth,
  templateFingerprint,
  templateMonth,
  type ReplayControls as Controls,
  type ReplayTemplateRef,
} from "../../../lib/replayQuery";
import { monthName, querySentence } from "../../../lib/repeatCopy";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Segmented,
  Skeleton,
  Spinner,
  UnlockCard,
  cx,
  toast,
  useJournalToken,
} from "../../../ui";
import { IconBell, IconInfo, IconPlus, IconRefresh, IconSearch } from "../../../ui/icons";
import { navigate } from "../../../lib/router";
import type { City, Journey, ReplayQuery, ReplayResponse, ReplayResult, Watch } from "../../../types";
import { TemplatePicker } from "./TemplatePicker";
import { RepeatToolbar } from "./RepeatToolbar";
import { ResultCard } from "./ResultCard";
import { ResultGrid } from "./ResultGrid";
import WatchSheet from "../watches/WatchSheet";
import "./repeat.css";
import { learnEurRate } from "../../trips/upcoming/money";

export interface RepeatTripProps {
  /** Seed journey from #/plan/repeat/<journeyId>. */
  journeyId?: string;
  /** Seed stop index from #/plan/repeat/<journeyId>/<stopIndex> (0-based). */
  stopIndex?: number;
}

const DEBOUNCE_MS = 350;
const FLASH_MS = 2500;
const FIRST_PAGE = 12;

type Failure = { kind: "template_not_found" | "template_not_fingerprinted" | "other" };
type View = "list" | "grid";

function toFailure(e: unknown): Failure {
  if (e instanceof JournalApiError) {
    if (e.code === "template_not_found") return { kind: "template_not_found" };
    if (e.code === "template_not_fingerprinted") return { kind: "template_not_fingerprinted" };
  }
  return { kind: "other" };
}

/** Confirmed journeys (plus the seeded one), best rated first, then newest. */
function selectable(journeys: Journey[], keepId?: string): Journey[] {
  return journeys
    .filter((j) => j.status === "confirmed" || j.id === keepId)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.startDate.localeCompare(a.startDate));
}

/**
 * #/plan/repeat[/<journeyId>[/<stopIndex>]]: find places like a past trip.
 * Remounts when the seed changes. Applies store.replayPrefill (from an alert) once.
 */
export default function RepeatTrip(props: RepeatTripProps) {
  const { unlocked } = useJournalToken();
  if (!unlocked) {
    return (
      <div className="plan-repeat">
        <UnlockCard title="Unlock your journal to repeat a trip" />
      </div>
    );
  }
  return <RepeatTripInner {...props} />;
}

function RepeatTripInner({ journeyId, stopIndex }: RepeatTripProps) {
  const { token } = useJournalToken();
  const cities = useMeridianStore((s) => s.cities);
  const journeys = useMeridianStore((s) => s.journeys);
  const prefill = useMeridianStore((s) => s.replayPrefill);
  const setReplayPrefill = useMeridianStore((s) => s.setReplayPrefill);
  const cityById = useMemo(() => new Map<string, City>(cities.map((c) => [c.id, c])), [cities]);

  // ── Journal list ──
  const [loadError, setLoadError] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setLoadError(false);
    refreshJourneys().catch((e) => {
      if (live && !(e instanceof JournalLockedError)) setLoadError(true);
    });
    return () => {
      live = false;
    };
  }, [token, loadNonce]);

  // ── Template and controls (an alert's prefill wins over defaults, once) ──
  const initialPrefill = useRef(useMeridianStore.getState().replayPrefill);
  const prefillTemplate = (q: ReplayQuery | undefined): ReplayTemplateRef | null =>
    q && "journeyId" in q.template ? { journeyId: q.template.journeyId, stopIndex: q.template.stopIndex ?? null } : null;

  const [chosen, setChosen] = useState<ReplayTemplateRef | null>(() =>
    journeyId ? { journeyId, stopIndex: stopIndex ?? null } : prefillTemplate(initialPrefill.current?.query)
  );
  const [controls, setControls] = useState<Controls>(() =>
    initialPrefill.current ? controlsFromQuery(initialPrefill.current.query, initialPrefill.current.month) : DEFAULT_CONTROLS
  );
  const focusRef = useRef<{ cityId: string; month: number } | null>(
    initialPrefill.current ? { cityId: initialPrefill.current.cityId, month: initialPrefill.current.month } : null
  );
  useEffect(() => {
    if (!prefill) return;
    if (prefill !== initialPrefill.current) {
      setControls(controlsFromQuery(prefill.query, prefill.month));
      const t = prefillTemplate(prefill.query);
      if (t) setChosen(t);
      focusRef.current = { cityId: prefill.cityId, month: prefill.month };
    }
    setReplayPrefill(null);
  }, [prefill, setReplayPrefill]);

  const options = useMemo(() => selectable(journeys ?? [], chosen?.journeyId), [journeys, chosen?.journeyId]);
  const template: ReplayTemplateRef | null = chosen ?? (options[0] ? { journeyId: options[0].id, stopIndex: null } : null);
  const tplId = template?.journeyId;
  const tplStop = template?.stopIndex ?? null;

  // The list copy can predate the server's fingerprint: read the template fresh, and again after the first run.
  const [resp, setResp] = useState<ReplayResponse | null>(null);
  const [fresh, setFresh] = useState<Journey | null>(null);
  const stored = journeys?.find((j) => j.id === tplId);
  const journey = fresh && fresh.id === tplId ? fresh : stored;
  useEffect(() => {
    if (!tplId) return;
    let live = true;
    getJourney(tplId)
      .then((j) => live && j && setFresh(j))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tplId, !!resp]);

  // ── Run the search: first run at once, later changes debounced, previous request aborted ──
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const immediate = useRef(true);
  const lastTpl = useRef(tplId);
  const doRetry = () => {
    immediate.current = true;
    setRetry((n) => n + 1);
  };
  const query = useMemo(() => (tplId ? buildQuery(controls, { journeyId: tplId, stopIndex: tplStop }) : null), [controls, tplId, tplStop]);
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    if (!query) return;
    const ctl = new AbortController();
    if (lastTpl.current !== tplId) {
      lastTpl.current = tplId;
      immediate.current = true;
    }
    const delay = immediate.current ? 0 : DEBOUNCE_MS;
    immediate.current = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const r = await runReplay(query, ctl.signal);
        if (ctl.signal.aborted) return;
        setResp(r);
        setFailure(null);
        // Server-converted prices tell Trips how to show its USD estimates in EUR.
        for (const res of r.results) if (res.price) learnEurRate(res.price.currency, res.price.priceAmount, res.price.priceEur);
      } catch (e) {
        if (ctl.signal.aborted) return;
        const f = toFailure(e);
        // Results for a template that can't be matched would mislead; keep them only for passing errors.
        if (f.kind !== "other") setResp(null);
        setFailure(f);
      }
      setLoading(false);
    }, delay);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, retry]);

  // ── Selection ──
  const [view, setView] = useState<View>("list");
  const [showAll, setShowAll] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (!resp) return;
    const focus = focusRef.current;
    const hit = focus && resp.results.find((r) => r.cityId === focus.cityId && r.month === focus.month);
    if (hit) {
      const key = resultKey(hit);
      focusRef.current = null;
      setSelectedKey(key);
      const idx = resp.results.indexOf(hit);
      if (idx >= FIRST_PAGE) setShowAll(true);
      requestAnimationFrame(() => itemRefs.current.get(key)?.scrollIntoView?.({ block: "center", behavior: "smooth" }));
      return;
    }
    setSelectedKey((k) => (k && resp.results.some((r) => resultKey(r) === k) ? k : (resp.results[0] ? resultKey(resp.results[0]) : null)));
  }, [resp]);

  // ── Words ──
  const fp = templateFingerprint(journey, tplStop);
  const tplMonth = templateMonth(journey, tplStop);
  const targetMonth = tplMonth && !controls.anyMonth ? shiftMonth(tplMonth, controls.monthShift) : undefined;
  const placeName = useMemo(() => {
    if (!journey) return "your trip";
    if (tplStop !== null) {
      const id = journey.stops[tplStop]?.cityId;
      return id ? cityById.get(id)?.name ?? journey.title : journey.title;
    }
    const ids = [...new Set(journey.stops.map((s) => s.cityId))];
    return ids.length === 1 ? cityById.get(ids[0]!)?.name ?? journey.title : journey.title;
  }, [journey, tplStop, cityById]);
  const likeWhat = tplMonth ? `${placeName} in ${monthName(tplMonth)}` : placeName;
  const heading = controls.anyMonth
    ? `Places like ${placeName}, any time of year`
    : targetMonth
      ? `Places like ${placeName} in ${monthName(targetMonth)}`
      : `Places like ${placeName}`;
  const fromCity = resp?.fromCityId ? cityById.get(resp.fromCityId) : undefined;
  const cityName = (id: string) => cityById.get(id)?.name ?? id;

  // ── Watch ──
  const [watch, setWatch] = useState<{ key: string; label: string; query: ReplayQuery; summary: string } | null>(null);
  const [watchedKeys, setWatchedKeys] = useState<Set<string>>(new Set());
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flash = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flash.current), []);
  const openWatch = (r?: ReplayResult) => {
    if (!query) return;
    const q = r ? narrowQuery(query, r.cityId, r.month) : query;
    const label = r ? `${cityName(r.cityId)} in ${monthName(r.month)}, like ${placeName}` : `Places like ${likeWhat}`;
    setWatch({ key: r ? resultKey(r) : "query", label, query: q, summary: querySentence(q, likeWhat, cityName) });
  };
  const watchSaved = (w: Watch) => {
    const st = useMeridianStore.getState();
    st.setWatches([...st.watches.filter((x) => x.id !== w.id), w]);
    if (!watch) return;
    const key = watch.key;
    setWatchedKeys((s) => new Set(s).add(key));
    setWatch(null);
    setFlashKey(key);
    window.clearTimeout(flash.current);
    flash.current = window.setTimeout(() => setFlashKey(null), FLASH_MS);
    toast("Watch saved. We'll tell you when prices look good.", {
      tone: "success",
      action: { label: "View watches", onClick: () => navigate({ view: "plan", tab: "watches" }) },
    });
  };

  // ── Early states ──
  if (journeys === null) {
    if (loadError) {
      return (
        <div className="plan-repeat">
          <ErrorState message="Couldn't load your journal." onRetry={() => setLoadNonce((n) => n + 1)} />
        </div>
      );
    }
    return (
      <div className="plan-repeat" aria-busy="true" aria-label="Loading your trips">
        <Card padding="md">
          <Skeleton height={36} width="min(420px, 100%)" />
        </Card>
        <ListSkeleton />
      </div>
    );
  }

  if (!template) {
    return (
      <div className="plan-repeat">
        <EmptyState
          size="page"
          icon={<IconRefresh />}
          title="Log a trip to repeat it"
          description="Pick a past trip and find other places that feel the same."
          action={
            <Button variant="primary" icon={<IconPlus />} onClick={() => useMeridianStore.getState().openQuickLog()}>
              Log a trip
            </Button>
          }
        />
      </div>
    );
  }

  const blocking = failure && failure.kind !== "other" ? failure : null;
  const stale = loading && !!resp;
  const results = resp?.results ?? [];
  const shown = showAll ? results : results.slice(0, FIRST_PAGE);
  const selected = results.find((r) => resultKey(r) === selectedKey);
  const rankOf = (r: ReplayResult) => results.indexOf(r) + 1;
  const isWatched = (key: string) => watchedKeys.has(key) || flashKey === key;

  return (
    <div className="plan-repeat">
      <TemplatePicker
        journeys={options}
        journey={journey}
        template={template}
        cityById={cityById}
        fingerprint={fp}
        month={tplMonth}
        onChange={(t) => {
          setChosen(t);
          setResp(null);
          setFailure(null);
        }}
      />

      <RepeatToolbar
        controls={controls}
        onChange={setControls}
        baseMonth={tplMonth}
        fingerprint={fp}
        templateClimate={resp?.templateClimate}
        fromCity={fromCity}
      />

      {resp?.templateClimate === "normal" && (
        <p className="plan-repeat-banner" role="status">
          <IconInfo size={18} />
          <span>
            {fp?.status.tempC === "pending"
              ? "Your trip's weather is pending — checks again later. Climate is compared with seasonal averages for now."
              : "There's no weather on record for your trip, so climate is compared with seasonal averages."}
          </span>
        </p>
      )}

      <section className="plan-repeat-results" aria-labelledby="plan-repeat-heading">
        <div className="plan-repeat-results-head">
          <div className="plan-repeat-results-titles">
            <h2 id="plan-repeat-heading">{heading}</h2>
            <p className="plan-repeat-status" role="status">
              {loading ? (
                <>
                  <Spinner size={14} /> {resp ? "Updating" : "Finding matches"}
                </>
              ) : resp ? (
                <>
                  {results.length} {results.length === 1 ? "match" : "matches"} from {resp.universeSize} places
                  {fromCity ? ` · Prices from ${fromCity.name}` : " · Set a home city to see prices"}
                  {resp.universeSize < 60 ? " · Only places with saved climate data" : ""}
                </>
              ) : null}
            </p>
          </div>
          {resp && results.length > 0 && (
            <div className="plan-repeat-results-actions">
              <Segmented<View>
                label="View"
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: "list", label: "List" },
                  { value: "grid", label: "By month" },
                ]}
              />
              <Button variant="ghost" icon={isWatched("query") ? undefined : <IconBell size={16} />} onClick={() => openWatch()}>
                {isWatched("query") ? "Watching this search" : "Watch this search"}
              </Button>
            </div>
          )}
        </div>

        {!loading && failure?.kind === "other" && resp && (
          <ErrorState message="Couldn't update the matches." onRetry={doRetry} />
        )}

        <div className={cx("plan-repeat-body", stale && "is-stale")}>
          {blocking ? (
            blocking.kind === "template_not_found" ? (
              <EmptyState
                icon={<IconSearch />}
                title="That trip is no longer in your journal"
                action={
                  options[0] && options[0].id !== tplId ? (
                    <Button onClick={() => setChosen({ journeyId: options[0]!.id, stopIndex: null })}>Use {options[0].title}</Button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                icon={<IconRefresh />}
                title="This trip's details are still being worked out"
                description="Weather and costs pending — checks again later."
                action={<Button onClick={doRetry}>Try again</Button>}
              />
            )
          ) : failure && !resp ? (
            <ErrorState message="Couldn't find matches." onRetry={doRetry} />
          ) : !resp ? (
            <ListSkeleton />
          ) : results.length === 0 ? (
            <EmptyState
              icon={<IconSearch />}
              title="Nothing matches these filters"
              description="Try a wider month range or fewer limits."
              action={<Button onClick={() => setControls({ ...DEFAULT_CONTROLS })}>Reset filters</Button>}
            />
          ) : view === "grid" ? (
            <>
              <ResultGrid
                resp={resp}
                cityById={cityById}
                templateMonth={tplMonth}
                targetMonth={targetMonth}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
              />
              {selected && (
                <ol className="plan-repeat-list plan-repeat-picked" aria-label="Picked place">
                  <ResultCard
                    result={selected}
                    rank={rankOf(selected)}
                    city={cityById.get(selected.cityId)}
                    origin={fromCity}
                    watched={isWatched(resultKey(selected))}
                    onWatch={() => openWatch(selected)}
                  />
                </ol>
              )}
            </>
          ) : (
            <>
              <ol className="plan-repeat-list">
                {shown.map((r, i) => {
                  const key = resultKey(r);
                  return (
                    <ResultCard
                      key={key}
                      ref={(el) => {
                        if (el) itemRefs.current.set(key, el);
                        else itemRefs.current.delete(key);
                      }}
                      result={r}
                      rank={i + 1}
                      city={cityById.get(r.cityId)}
                      origin={fromCity}
                      selected={key === selectedKey}
                      watched={isWatched(key)}
                      onSelect={() => setSelectedKey(key)}
                      onWatch={() => openWatch(r)}
                    />
                  );
                })}
              </ol>
              {results.length > FIRST_PAGE && !showAll && (
                <div className="plan-repeat-more">
                  <Button onClick={() => setShowAll(true)}>Show all {results.length}</Button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {watch && (
        <WatchSheet
          key={watch.key}
          open
          preset={{ label: watch.label, query: watch.query }}
          onClose={() => setWatch(null)}
          onSaved={watchSaved}
        />
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <ol className="plan-repeat-list" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="plan-repeat-item">
          <Card padding="md" className="plan-repeat-card">
            <Skeleton height={18} width="40%" />
            <div className="plan-repeat-skel-gap" />
            <Skeleton lines={2} height={12} />
          </Card>
        </li>
      ))}
    </ol>
  );
}
