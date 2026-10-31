import "./world.css";
import { useMemo, useState } from "react";
import { useMeridianStore } from "../../store";
import { openCity } from "../../shell/uiStore";
import { navigate } from "../../lib/router";
import { countryKey, displayCountry } from "../../lib/countryNames";
import {
  REGIONS,
  filterNewsByRegion,
  formatNewsTime,
  isMockNews,
  newsAgeMinutes,
  newsForCountry,
  newsPlace,
  regionLabel,
  type RegionKey,
} from "../../lib/newsRegions";
import { Badge, Button, Card, Chip, EmptyState, ErrorState, Page, PageHeader, Skeleton } from "../../ui";
import { IconExternal, IconMap, IconRefresh, IconWorld } from "../../ui/icons";
import { useNews } from "./useNews";
import { useCountryStats, type CountryStats } from "./useCountryStats";
import type { TickerItem } from "../../types";

const TONE: Record<TickerItem["glyph"], { label: string; cls: string }> = {
  alert: { label: "Alert", cls: "world-tone--danger" },
  hazard: { label: "Hazard", cls: "world-tone--warning" },
  good: { label: "Good news", cls: "world-tone--success" },
  info: { label: "Update", cls: "world-tone--neutral" },
};

/** Owner: world agent. Route #/world. No props. */
export default function WorldScreen() {
  const { items, status, refreshing, reload } = useNews();
  const [region, setRegion] = useState<RegionKey | null>(null);
  const [country, setCountry] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...items].sort((a, b) => newsAgeMinutes(a.time) - newsAgeMinutes(b.time)),
    [items]
  );
  const inRegion = useMemo(() => filterNewsByRegion(sorted, region), [sorted, region]);
  const shown = useMemo(() => (country ? newsForCountry(inRegion, country) : inRegion), [inRegion, country]);
  const counts = useMemo(() => {
    const m = new Map<RegionKey, number>();
    for (const it of items) {
      const r = newsPlace(it.location).region;
      if (r) m.set(r, (m.get(r) ?? 0) + 1);
    }
    return m;
  }, [items]);

  // Countries in the (region-filtered) news, most mentioned first.
  const places = useMemo(() => {
    const m = new Map<string, { name: string; country: string; count: number }>();
    for (const it of inRegion) {
      const p = newsPlace(it.location);
      if (!p.country) continue;
      const cur = m.get(p.country) ?? { name: p.name, country: p.country, count: 0 };
      cur.count += 1;
      m.set(p.country, cur);
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 6);
  }, [inRegion]);

  const mock = isMockNews(items);
  const pickRegion = (r: RegionKey | null) => {
    setRegion(r);
    setCountry(null);
  };
  const countryName = country ? (places.find((p) => p.country === country)?.name ?? displayCountry(country)) : "";

  return (
    <Page>
      <PageHeader
        kicker="Dispatches · news and conditions"
        title="World"
        subtitle="Headlines and local conditions, by region"
        actions={
          <Button icon={<IconRefresh />} loading={refreshing} onClick={reload} disabled={status === "loading"}>
            Refresh
          </Button>
        }
      />

      <div className="world-filters" role="group" aria-label="Region">
        <Chip selected={region === null} onClick={() => pickRegion(null)}>
          All regions
        </Chip>
        {REGIONS.map((r) => (
          <Chip key={r.value} selected={region === r.value} onClick={() => pickRegion(region === r.value ? null : r.value)}>
            {r.label}
            {counts.get(r.value) ? <span className="world-count num">{counts.get(r.value)}</span> : null}
          </Chip>
        ))}
      </div>

      <div className="world-grid">
        <section className="world-news" aria-labelledby="world-news-h">
          <div className="world-section-head">
            <h2 id="world-news-h" className="world-h2">
              {country ? `Headlines about ${countryName}` : region ? `Headlines from ${regionLabel(region)}` : "Headlines"}
            </h2>
            {mock ? <Badge tone="warning">Mock</Badge> : null}
            {country ? (
              <Chip onRemove={() => setCountry(null)} aria-label={`Clear ${countryName} filter`}>
                {countryName}
              </Chip>
            ) : null}
          </div>
          <NewsList
            status={status}
            items={shown}
            onRetry={reload}
            emptyAction={
              region || country ? (
                <Button onClick={() => pickRegion(null)}>Show all regions</Button>
              ) : (
                <Button icon={<IconRefresh />} onClick={reload}>
                  Check again
                </Button>
              )
            }
            emptyTitle={
              country
                ? `No headlines about ${countryName} right now`
                : region
                  ? `No headlines from ${regionLabel(region)} right now`
                  : "No headlines right now"
            }
          />
        </section>

        <aside className="world-places" aria-labelledby="world-places-h">
          <div className="world-section-head">
            <h2 id="world-places-h" className="world-h2">
              Places in the news
            </h2>
          </div>
          <PlaceCards
            newsStatus={status}
            places={places}
            selected={country}
            onSelect={(c) => setCountry(c === country ? null : c)}
          />
        </aside>
      </div>
    </Page>
  );
}

function NewsList({
  status,
  items,
  onRetry,
  emptyTitle,
  emptyAction,
}: {
  status: "loading" | "ready" | "error";
  items: TickerItem[];
  onRetry: () => void;
  emptyTitle: string;
  emptyAction: React.ReactNode;
}) {
  if (status === "loading")
    return (
      <Card padding="none" className="world-list" aria-busy="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="world-row">
            <Skeleton lines={2} />
          </div>
        ))}
      </Card>
    );
  if (status === "error") return <ErrorState message="Couldn’t load the news." onRetry={onRetry} />;
  if (!items.length) return <EmptyState icon={<IconWorld />} title={emptyTitle} action={emptyAction} />;
  return (
    <Card padding="none" className="world-list">
      <ul className="world-rows">
        {items.map((it, i) => {
          const tone = TONE[it.glyph] ?? TONE.info;
          const place = newsPlace(it.location).name;
          const time = formatNewsTime(it.time);
          const body = (
            <>
              <span className={`world-tone ${tone.cls}`} aria-hidden="true" />
              <span className="world-row-main">
                <span className="world-row-title">
                  <span className="sr-only">{tone.label}: </span>
                  {it.text}
                </span>
                <span className="world-row-meta">
                  {[place, it.source, time].filter(Boolean).join(" · ")}
                </span>
              </span>
              {it.url ? <IconExternal size={16} className="world-row-ext" /> : null}
            </>
          );
          return (
            <li key={`${it.text}-${i}`}>
              {it.url ? (
                <a className="world-row world-row--link" href={it.url} target="_blank" rel="noopener noreferrer">
                  {body}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                <div className="world-row">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const STAT_ROWS: { id: keyof CountryStats["values"]; label: string; word: (v: number) => string }[] = [
  { id: "stability", label: "Safety", word: (v) => (v >= 80 ? "Very stable" : v >= 60 ? "Stable" : v >= 40 ? "Mixed" : "Unsettled") },
  { id: "cost", label: "Cost of living", word: (v) => (v >= 70 ? "Affordable" : v >= 45 ? "Moderate" : "Pricey") },
  { id: "tourism", label: "Crowds", word: (v) => (v >= 70 ? "Busy" : v >= 45 ? "Active" : "Quiet") },
];

function weatherWord(v: number): string {
  if (v >= 67) return "Pleasant";
  if (v >= 45) return "Mixed";
  return "Harsh";
}

const MONTH_NOW = new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date());

function PlaceCards({
  newsStatus,
  places,
  selected,
  onSelect,
}: {
  newsStatus: "loading" | "ready" | "error";
  places: { name: string; country: string; count: number }[];
  selected: string | null;
  onSelect: (country: string) => void;
}) {
  const { stats, status, retry } = useCountryStats();
  const cities = useMeridianStore((s) => s.cities);

  if (newsStatus === "loading" || (status === "loading" && places.length))
    return (
      <div className="world-cards">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <Skeleton width="40%" height={18} />
            <div style={{ height: 12 }} />
            <Skeleton lines={3} />
          </Card>
        ))}
      </div>
    );
  if (newsStatus === "error") return null;
  if (!places.length)
    return <p className="world-note">No single country stands out in these headlines.</p>;
  if (status === "error") return <ErrorState message="Couldn’t load local conditions." onRetry={retry} />;

  const openOnMap = (country: string) => {
    const key = countryKey(country);
    const inCountry = cities.filter((c) => countryKey(c.country) === key);
    const pick = inCountry.find((c) => c.capital) ?? inCountry.sort((a, b) => b.population - a.population)[0];
    if (!pick) return;
    navigate("/");
    openCity(pick.id);
  };

  return (
    <div className="world-cards">
      {places.map((p) => {
        const s = stats(p.country);
        const weather = s?.weatherNow ?? s?.values.weather;
        return (
          <Card key={p.country} className="world-card" data-selected={selected === p.country || undefined}>
            <div className="world-card-head">
              <h3 className="world-card-title">{p.name}</h3>
              <span className="world-card-count">{p.count === 1 ? "1 story" : `${p.count} stories`}</span>
            </div>
            {s ? (
              <dl className="world-stats">
                {typeof weather === "number" ? (
                  <div className="world-stat">
                    <dt>{s.weatherNow !== undefined ? `Weather in ${MONTH_NOW}` : "Weather"}</dt>
                    <dd>
                      {weatherWord(weather)}
                      <Meter value={weather} label="Weather" />
                    </dd>
                  </div>
                ) : null}
                {STAT_ROWS.map((r) => {
                  const v = s.values[r.id];
                  if (typeof v !== "number") return null;
                  return (
                    <div key={r.id} className="world-stat">
                      <dt>{r.label}</dt>
                      <dd>
                        {r.word(v)}
                        <Meter value={v} label={r.label} />
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p className="world-note">No local stats for {p.name} yet.</p>
            )}
            <div className="world-card-actions">
              <Button size="sm" variant="ghost" aria-pressed={selected === p.country} onClick={() => onSelect(p.country)}>
                {selected === p.country ? "Show all stories" : "Show stories"}
              </Button>
              <Button size="sm" variant="ghost" icon={<IconMap />} onClick={() => openOnMap(p.country)}>
                Open on map
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <span className="world-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}
