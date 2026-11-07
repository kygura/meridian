import "./map.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../store";
import { openAsk } from "../../shell/uiStore";
import { navigate, hrefFor } from "../../lib/router";
import { displayCountry } from "../../lib/countryNames";
import { resolveTripColor } from "../../lib/tripColors";
import { bestWindow } from "../../lib/seasonality";
import { stopNights } from "../../lib/journal";
import { refreshJourneys } from "../../lib/journalApi";
import { setWatchPrefill } from "../../lib/watchPrefill";
import { filterNewsByRegion, formatNewsTime, newsForCountry, newsPlace, regionFromContinent, regionLabel } from "../../lib/newsRegions";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Popover,
  Sheet,
  Skeleton,
  UnlockCard,
  toast,
  useJournalToken,
} from "../../ui";
import { IconAsk, IconBell, IconCalendar, IconCheck, IconPin, IconPlane, IconPlus } from "../../ui/icons";
import { ago, CITY_METRICS, sentenceCase, SUBJECT_TOPIC, TOPIC_LABELS, useCityMetrics, useCitySeasonality, usePlaceNews, type NewsIssue, type NewsTopic } from "./cityData";
import { countryInfo } from "./countries";
import { MONTH_NAMES, MONTH_SHORT } from "./basemap";
import { useNews } from "../world/useNews";
import type { City, Journey, TripNode } from "../../types";
import type { SeasonMonth } from "../../lib/seasonalityApi";

export interface CityPanelProps {
  /** City to show (useMeridianStore.cities[].id). */
  cityId: string;
  /** Closes the panel (uiStore.closeCity). */
  onClose: () => void;
}

const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const NUM = new Intl.NumberFormat();

function monthYear(iso: string): string {
  const [y, m] = iso.slice(0, 10).split("-").map(Number);
  return y && m ? MONTH_YEAR.format(new Date(Date.UTC(y, m - 1, 15))) : iso;
}

function nodeOf(c: City): TripNode {
  return { cityId: c.id, name: c.name, iata: c.iata, lat: c.lat, lng: c.lng };
}

function formatPopulation(n: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} million`;
  return NUM.format(Math.round(n / 1000) * 1000);
}

/**
 * Owner: map agent. Global: rendered by App whenever uiStore.cityPanel is set, from any
 * route. Right side sheet on desktop (non-modal so the map stays usable), bottom sheet on phones.
 */
export default function CityPanel({ cityId, onClose }: CityPanelProps) {
  const city = useMeridianStore((s) => s.cities.find((c) => c.id === cityId));
  const citiesLoaded = useMeridianStore((s) => s.cities.length > 0);

  if (!city) {
    return (
      <Sheet open onClose={onClose} modal={false} title={citiesLoaded ? "City not found" : "Loading…"}>
        {citiesLoaded ? (
          <EmptyState icon={<IconPin />} title="We couldn’t find this city" description="It may have been renamed or removed." />
        ) : (
          <Skeleton lines={6} />
        )}
      </Sheet>
    );
  }

  const country = displayCountry(city.country);
  return (
    <Sheet
      open
      onClose={onClose}
      modal={false}
      title={city.name}
      description={
        <span className="map-city-sub">
          <span>{country}</span>
          {city.iata ? <span className="iata">{city.iata}</span> : null}
        </span>
      }
    >
      <div className="map-city">
        <Actions city={city} onClose={onClose} />
        <BestMonths cityId={city.id} />
        <AtAGlance city={city} />
        <Visits city={city} />
        <Watch city={city} />
        <News city={city} />
      </div>
    </Sheet>
  );
}

// ── Actions ─────────────────────────────────────────────────────────

function Actions({ city, onClose }: { city: City; onClose: () => void }) {
  const hasAirport = !!city.iata;
  return (
    <section className="map-city-section" aria-label="Actions">
      <div className="map-actions">
        <AddToTrip city={city} />
        <Button icon={<IconCalendar />} onClick={() => useMeridianStore.getState().openQuickLog({ prefillStops: [city.id] })}>
          Log a visit
        </Button>
        <Button
          icon={<IconPlane />}
          disabled={!hasAirport}
          onClick={() => useMeridianStore.getState().openBookingModal({ dest: nodeOf(city) })}
        >
          Book a flight
        </Button>
        <Button
          icon={<IconBell />}
          onClick={() => {
            setWatchPrefill({ cityId: city.id });
            onClose();
            navigate("/plan/watches");
          }}
        >
          Watch prices
        </Button>
        <Button icon={<IconAsk />} onClick={() => openAsk(`What is ${city.name} like to visit, and when is the best time to go?`)}>
          Ask about it
        </Button>
      </div>
      {!hasAirport ? <p className="map-city-note">No airport is listed for {city.name}, so flights can’t be booked here.</p> : null}
    </section>
  );
}

function AddToTrip({ city }: { city: City }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const trips = useMeridianStore((s) => s.trips);
  const mine = trips.filter((t) => t.origin !== "agent");

  const added = (tripId: string, tripName: string) => {
    setOpen(false);
    toast(`Added ${city.name} to ${tripName}`, {
      action: { label: "Open trip", onClick: () => navigate(`/trips/plan/${encodeURIComponent(tripId)}`) },
    });
  };

  const addTo = (tripId: string) => {
    const s = useMeridianStore.getState();
    const trip = s.trips.find((t) => t.id === tripId);
    if (!trip) return;
    s.addCityToTrip(tripId, nodeOf(city));
    added(tripId, trip.name);
  };

  const addNew = () => {
    const s = useMeridianStore.getState();
    const name = `Trip to ${city.name}`;
    const id = s.createTrip(name);
    s.addCityToTrip(id, nodeOf(city));
    added(id, name);
  };

  return (
    <div>
      <Button
        ref={anchor}
        variant="primary"
        block
        icon={<IconPlus />}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (mine.length ? setOpen((o) => !o) : addNew())}
      >
        Add to trip
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-start" label="Add to trip">
        <div className="map-trip-menu">
          <p className="map-trip-menu-label">Add {city.name} to</p>
          {mine.map((t) => {
            const inTrip = t.nodes.some((n) => n.cityId === city.id);
            return (
              <button key={t.id} type="button" className="map-trip-option" onClick={() => addTo(t.id)}>
                <span className="map-trip-dot" style={{ background: resolveTripColor(t.color) }} aria-hidden="true" />
                <span>{t.name}</span>
                {inTrip ? (
                  <small>
                    <IconCheck size={16} /> <span className="sr-only">Already in this trip.</span>
                  </small>
                ) : (
                  <small>{t.nodes.length === 1 ? "1 stop" : `${t.nodes.length} stops`}</small>
                )}
              </button>
            );
          })}
          <div className="map-trip-sep" role="separator" />
          <button type="button" className="map-trip-option" onClick={addNew}>
            <IconPlus size={16} />
            <span>New trip</span>
          </button>
        </div>
      </Popover>
    </div>
  );
}

// ── Best months ─────────────────────────────────────────────────────

function comfortWord(score: number): string {
  if (score >= 84) return "Excellent";
  if (score >= 67) return "Very good";
  if (score >= 51) return "Good";
  if (score >= 34) return "Fair";
  if (score >= 17) return "Poor";
  return "Harsh";
}

function rampVar(score: number): string {
  return `var(--ramp-${Math.max(0, Math.min(6, Math.round((score / 100) * 6)))})`;
}

function BestMonths({ cityId }: { cityId: string }) {
  const season = useCitySeasonality(cityId);
  const months = season.status === "ready" ? season.months : null;
  const win = useMemo(() => bestWindow(months), [months]);
  const [picked, setPicked] = useState<number | null>(null);

  let body: React.ReactNode;
  if (season.status === "loading") body = <Skeleton height={48} />;
  else if (season.status === "none") body = <p className="map-city-note">No climate data for this city yet.</p>;
  else if (season.status === "error")
    body = (
      <ErrorState
        message={season.unavailable ? "Climate data is unavailable right now." : "Couldn’t load climate data."}
        onRetry={season.retry}
      />
    );
  else {
    const ms = season.months as SeasonMonth[];
    const shown = picked ?? win?.peakMonth ?? new Date().getMonth();
    const m = ms[shown];
    body = (
      <>
        <div className="map-months-strip" role="group" aria-label="Comfort by month">
          {ms.map((mo, i) => (
            <button
              key={i}
              type="button"
              className="map-month-cell"
              aria-pressed={i === shown}
              aria-label={`${MONTH_NAMES[i]}: ${comfortWord(mo.score).toLowerCase()}`}
              onClick={() => setPicked(i)}
            >
              <span style={{ background: rampVar(mo.score) }} />
              <span>{MONTH_SHORT[i].charAt(0)}</span>
            </button>
          ))}
        </div>
        {m ? (
          <p className="map-month-detail" aria-live="polite">
            {MONTH_NAMES[shown]}: {comfortWord(m.score).toLowerCase()}.{" "}
            <span className="num">
              {Math.round(m.tempC)}°C, {Math.round(m.precipMm)} mm rain
            </span>
          </p>
        ) : null}
      </>
    );
  }

  let summary = "";
  if (win) {
    if (win.startMonth === 0 && win.endMonth === 11) summary = "Good all year";
    else if (win.startMonth === win.endMonth) summary = `Best in ${MONTH_NAMES[win.startMonth]}`;
    else summary = `Best ${MONTH_NAMES[win.startMonth]} to ${MONTH_NAMES[win.endMonth]}`;
  }

  return (
    <section className="map-city-section" aria-labelledby={`${cityId}-months`}>
      <h3 className="map-city-h" id={`${cityId}-months`}>
        When to go {summary ? <small>{summary}</small> : null}
      </h3>
      {body}
    </section>
  );
}

// ── At a glance (metrics) ───────────────────────────────────────────

function AtAGlance({ city }: { city: City }) {
  const { data, status, retry } = useCityMetrics(city.id);
  const rows = CITY_METRICS.filter((r) => data?.[r.id]);
  const tz = city.timezone ? (/^[+-]/.test(city.timezone) ? `UTC${city.timezone}` : city.timezone) : "";

  return (
    <section className="map-city-section" aria-labelledby={`${city.id}-glance`}>
      <h3 className="map-city-h" id={`${city.id}-glance`}>
        At a glance
      </h3>
      <div className="map-facts">
        {city.population ? (
          <span>
            Population <b className="num">{formatPopulation(city.population)}</b>
          </span>
        ) : null}
        {city.currency ? (
          <span>
            Currency <b>{city.currency}</b>
          </span>
        ) : null}
        {tz ? (
          <span>
            Time zone <b>{tz}</b>
          </span>
        ) : null}
        {city.capital ? <Badge>Capital</Badge> : null}
      </div>
      {status === "loading" ? (
        <div className="map-metrics">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={36} />
          ))}
        </div>
      ) : status === "error" ? (
        <ErrorState message="Couldn’t load local stats." onRetry={retry} />
      ) : rows.length === 0 ? (
        <p className="map-city-note">No local stats for this city yet.</p>
      ) : (
        <div className="map-metrics">
          {rows.map((r) => {
            const v = data![r.id];
            const pct = Math.max(0, Math.min(100, Math.round(v.normalized)));
            return (
              <div key={r.id} className="map-metric" title={r.hint}>
                <div className="map-metric-top">
                  <span>{r.label}</span>
                  <span className="num">{pct}</span>
                </div>
                <div className="map-metric-value">{sentenceCase(v.label) || "—"}</div>
                <div
                  className="map-meter"
                  role="meter"
                  aria-label={r.label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                >
                  <span style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Your visits ─────────────────────────────────────────────────────

function Visits({ city }: { city: City }) {
  const { unlocked, token } = useJournalToken();
  const journeys = useMeridianStore((s) => s.journeys);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Load the journal once if nobody has yet.
  const missing = journeys === null;
  useEffect(() => {
    if (!unlocked || !missing) return;
    setError(false);
    refreshJourneys().catch(() => setError(true));
  }, [unlocked, token, missing, attempt]);

  const visits = useMemo(() => {
    if (!journeys) return [];
    const out: { j: Journey; arrive: string; nights: number }[] = [];
    for (const j of journeys) {
      const stops = j.stops.filter((s) => s.cityId === city.id);
      if (!stops.length) continue;
      out.push({ j, arrive: stops[0].arrive, nights: stops.reduce((n, s) => n + stopNights(s), 0) });
    }
    return out.sort((a, b) => b.arrive.localeCompare(a.arrive));
  }, [journeys, city.id]);

  let body: React.ReactNode;
  if (!unlocked) body = <UnlockCard compact title="Unlock to see your visits" />;
  else if (error && journeys === null) body = <ErrorState message="Couldn’t load your trips." onRetry={() => setAttempt((n) => n + 1)} />;
  else if (journeys === null) body = <Skeleton lines={2} />;
  else if (!visits.length) body = <p className="map-city-note">You haven’t logged a visit here yet.</p>;
  else
    body = (
      <ul className="map-list">
        {visits.slice(0, 5).map(({ j, arrive, nights }) => (
          <li key={j.id}>
            <a className="map-list-item" href={hrefFor({ view: "trips", tab: "past", journeyId: j.id })}>
              <span className="map-list-title">{j.title || "Untitled trip"}</span>
              <span className="map-list-meta">
                {monthYear(arrive)}
                {nights ? ` · ${nights === 1 ? "1 night" : `${nights} nights`}` : ""}
                {j.status === "draft" ? " · Draft" : ""}
              </span>
            </a>
          </li>
        ))}
      </ul>
    );

  return (
    <section className="map-city-section" aria-labelledby={`${city.id}-visits`}>
      <h3 className="map-city-h" id={`${city.id}-visits`}>
        Your visits {unlocked && visits.length ? <small className="num">{visits.length}</small> : null}
      </h3>
      {body}
    </section>
  );
}

// ── Watch: advisories and recurring risk news ───────────────────────

const ISSUE_LEVEL: Record<NewsIssue["level"], string> = {
  systemic: "Pattern",
  incident: "Recent incident",
  recurring: "Recurring",
};

/** Issues worth showing: every pattern, plus incidents and recurring problems up to a cap. */
const WATCH_LIMIT = 4;

function Watch({ city }: { city: City }) {
  const { data } = usePlaceNews(city.id);
  if (!data) return null;
  const { advisories, flags, issues } = data;
  const shownIssues = issues.filter((i, k) => i.level === "systemic" || k < WATCH_LIMIT);
  // Don't repeat a topic an issue or a curated advisory already covers.
  const covered = new Set<string>([
    ...advisories.map((a) => a.topic ?? ""),
    ...shownIssues.map((i) => SUBJECT_TOPIC[i.subject] ?? ""),
  ]);
  const newsFlags = flags.filter((f) => !covered.has(f.topic)).slice(0, Math.max(0, WATCH_LIMIT - shownIssues.length));
  if (!advisories.length && !shownIssues.length && !newsFlags.length) return null;
  const country = displayCountry(city.country);
  return (
    <section className="map-city-section" aria-labelledby={`${city.id}-watch`}>
      <h3 className="map-city-h" id={`${city.id}-watch`}>
        Watch in {country}
      </h3>
      <ul className="map-watch">
        {advisories.map((a) => (
          <li key={a.id} className="map-watch-item" data-sev={a.severity}>
            <span className="map-watch-kicker">
              {a.kind === "conflict" ? "Conflict" : (TOPIC_LABELS[a.topic as NewsTopic] ?? "Advisory")}
              {a.since ? ` · since ${fmtSince(a.since)}` : ""}
            </span>
            <span className="map-watch-title">{a.label}</span>
            {a.detail ? <span className="map-watch-detail">{a.detail}</span> : null}
            {a.sources?.length ? (
              <span className="map-watch-sources">
                {a.sources.map((src, i) => (
                  <a key={src.url} href={src.url} target="_blank" rel="noopener noreferrer">
                    {i === 0 ? "Sources: " : ""}
                    {src.title}
                  </a>
                ))}
              </span>
            ) : null}
          </li>
        ))}
        {shownIssues.map((issue) => (
          <li key={issue.subject} className="map-watch-item" data-sev={issue.level === "systemic" ? 3 : 2}>
            <span className="map-watch-kicker">
              {ISSUE_LEVEL[issue.level]} · from {issue.headlineCount} {issue.headlineCount === 1 ? "headline" : "headlines"}
            </span>
            <span className="map-watch-title">{issue.label}</span>
            <span className="map-watch-detail">{issue.summary}</span>
            {issue.headlines.length ? (
              <span className="map-watch-sources">
                {issue.headlines.map((h) => (
                  <a key={h.url || h.title} href={h.url} target="_blank" rel="noopener noreferrer">
                    {h.title}
                    {h.source ? (
                      <>
                        {" "}
                        (<bdi>{h.source}</bdi>, {fmtSince(h.pubDate.slice(0, 7))})
                      </>
                    ) : (
                      ` (${fmtSince(h.pubDate.slice(0, 7))})`
                    )}
                  </a>
                ))}
              </span>
            ) : null}
          </li>
        ))}
        {newsFlags.map((f) => (
          <li key={f.topic} className="map-watch-item" data-sev={f.severity}>
            <span className="map-watch-kicker">
              {TOPIC_LABELS[f.topic]} · {f.count} {f.count === 1 ? "headline" : "headlines"} · in the news
            </span>
            {f.url ? (
              <a className="map-watch-title" href={f.url} target="_blank" rel="noopener noreferrer">
                {f.headline}
              </a>
            ) : (
              <span className="map-watch-title">{f.headline}</span>
            )}
            <span className="map-watch-detail">Latest {ago(f.latest).toLowerCase()}</span>
          </li>
        ))}
      </ul>
      {shownIssues.length || newsFlags.length ? (
        <p className="map-city-note">Detected automatically from recent headlines. Read the sources before deciding.</p>
      ) : null}
    </section>
  );
}

function fmtSince(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return y && m ? `${MONTH_SHORT[m - 1]} ${y}` : ym;
}

// ── News ────────────────────────────────────────────────────────────

const NEWS_LIMIT = 5;

/** Local headlines (city, then country) from the place search; the world feed as fallback. */
function News({ city }: { city: City }) {
  const place = usePlaceNews(city.id);
  const placeItems = useMemo(() => {
    const all = place.data?.available ? place.data.items : [];
    // Headlines that name the place first; search hits about elsewhere only as filler.
    const named = all.filter((i) => i.mentions !== false);
    const items = named.length >= 3 ? named : all;
    const recent = items.filter((i) => Date.now() - Date.parse(i.pubDate) < 21 * 86_400_000);
    const pool = recent.length >= 3 ? recent : items;
    const cityFirst = [...pool.filter((i) => i.scope === "city"), ...pool.filter((i) => i.scope === "country")];
    return cityFirst.slice(0, NEWS_LIMIT);
  }, [place.data]);

  if (place.status === "loading")
    return (
      <section className="map-city-section" aria-label="News">
        <h3 className="map-city-h">News</h3>
        <Skeleton lines={3} />
      </section>
    );
  if (!placeItems.length) return <WorldNews city={city} />;

  const country = displayCountry(city.country);
  const hasCity = placeItems.some((i) => i.scope === "city");
  return (
    <section className="map-city-section" aria-labelledby={`${city.id}-news`}>
      <h3 className="map-city-h" id={`${city.id}-news`}>
        {hasCity && city.name !== country ? `News from ${city.name} and ${country}` : `News from ${country}`}
      </h3>
      <ul className="map-list">
        {placeItems.map((it) => {
          const meta = [ago(it.pubDate), it.severity > 1 ? it.topics.map((t) => TOPIC_LABELS[t]).join(", ") : ""]
            .filter(Boolean)
            .join(" · ");
          const inner = (
            <>
              <span className="map-list-title">{it.title}</span>
              <span className="map-list-meta">
                {it.source ? (
                  <>
                    {/* Publisher names can be right-to-left; keep them from reordering the line. */}
                    <bdi>{it.source}</bdi>
                    {meta ? " · " : ""}
                  </>
                ) : null}
                {meta}
              </span>
            </>
          );
          return (
            <li key={it.url || it.title}>
              {it.url ? (
                <a className="map-list-item" href={it.url} target="_blank" rel="noopener noreferrer">
                  {inner}
                </a>
              ) : (
                <div className="map-list-item">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WorldNews({ city }: { city: City }) {
  const { items, status, reload } = useNews();
  const country = displayCountry(city.country);
  const local = useMemo(() => newsForCountry(items, city.country), [items, city.country]);
  const info = countryInfo(city.country);
  const region = regionFromContinent(info?.continent, info?.subregion);
  const regional = useMemo(
    () => (local.length || !region ? [] : filterNewsByRegion(items, region)),
    [local.length, region, items]
  );
  const shown = (local.length ? local : regional).slice(0, 3);

  let body: React.ReactNode;
  if (status === "loading") body = <Skeleton lines={3} />;
  else if (status === "error") body = <ErrorState message="Couldn’t load the news." onRetry={reload} />;
  else if (!shown.length)
    body = (
      <p className="map-city-note">
        No recent news about {country}. <a href={hrefFor({ view: "world" })}>See world news</a>
      </p>
    );
  else
    body = (
      <ul className="map-list">
        {shown.map((it, i) => {
          const meta = [it.source, local.length ? null : newsPlace(it.location).name, formatNewsTime(it.time)]
            .filter(Boolean)
            .join(" · ");
          const inner = (
            <>
              <span className="map-list-title">{it.text}</span>
              {meta ? <span className="map-list-meta">{meta}</span> : null}
            </>
          );
          return (
            <li key={`${it.text}-${i}`}>
              {it.url ? (
                <a className="map-list-item" href={it.url} target="_blank" rel="noopener noreferrer">
                  {inner}
                </a>
              ) : (
                <div className="map-list-item">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    );

  return (
    <section className="map-city-section" aria-labelledby={`${city.id}-news`}>
      <h3 className="map-city-h" id={`${city.id}-news`}>
        {local.length || !region || !shown.length ? `News from ${country}` : `News from ${regionLabel(region)}`}
      </h3>
      {body}
    </section>
  );
}
