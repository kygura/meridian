// Plan › Sources: pick a vibe or places you love; see where that experience is strongest (the
// sources) and which places are alike but lighter (the echoes), by city, region or country.
// Data: GET /api/likeness (ADR 0019). Click a row to open the city.

import { useEffect, useMemo, useState } from "react";
import { useMeridianStore } from "../../../store";
import { openCity } from "../../../shell/uiStore";
import { displayCountry } from "../../../lib/countryNames";
import { AXIS_LABELS, VIBES, type LikenessCityRow, type LikenessGroupRow, type LikenessLevel, type LikenessResponse } from "../../../lib/likeness";
import { fetchLikeness, takeSourcesSeed } from "../../../lib/likenessApi";
import { Card, Chip, CitySearch, EmptyState, ErrorState, SectionHeader, Segmented, Select, Skeleton } from "../../../ui";
import { IconWorld } from "../../../ui/icons";
import "./sources.css";

const LEVELS: { value: LikenessLevel; label: string }[] = [
  { value: "city", label: "Cities" },
  { value: "region", label: "Regions" },
  { value: "country", label: "Countries" },
];

type Row = LikenessCityRow | LikenessGroupRow;
const isCity = (r: Row): r is LikenessCityRow => "cityId" in r;

export default function Sources() {
  const cities = useMeridianStore((s) => s.cities);
  const [vibes, setVibes] = useState<string[]>([]);
  const [like, setLike] = useState<string[]>(() => {
    const seed = takeSourcesSeed();
    return seed ? [seed] : [];
  });
  const [level, setLevel] = useState<LikenessLevel>("city");
  const [within, setWithin] = useState("");
  const [data, setData] = useState<LikenessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const byId = useMemo(() => new Map(cities.map((c) => [c.id, c])), [cities]);
  const countries = useMemo(() => [...new Set(cities.map((c) => c.country))].sort((a, b) => displayCountry(a).localeCompare(displayCountry(b))), [cities]);
  const asking = vibes.length > 0 || like.length > 0;

  useEffect(() => {
    if (!asking) {
      setData(null);
      return;
    }
    const ctl = new AbortController();
    setError(null);
    setData(null);
    fetchLikeness({ vibes, like, level, within: within || undefined, limit: 12 }, ctl.signal)
      .then(setData)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Couldn’t compare places.");
      });
    return () => ctl.abort();
  }, [asking, vibes, like, level, within, attempt]);

  const toggleVibe = (id: string) => setVibes((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));

  return (
    <div className="plan-sources">
      <p className="plan-sources-intro">
        Pick a vibe or places you love. <strong>Sources</strong> are the alike places with the most of that experience;{" "}
        <strong>echoes</strong> are alike but lighter, so you can go to the real thing, or choose the quieter or cheaper copy on purpose.
      </p>

      <div className="plan-sources-pick">
        <div className="plan-sources-chips" role="group" aria-label="Vibes">
          {VIBES.map((v) => (
            <Chip key={v.id} selected={vibes.includes(v.id)} onClick={() => toggleVibe(v.id)} title={v.detail}>
              {v.label}
            </Chip>
          ))}
        </div>
        <div className="plan-sources-like">
          <CitySearch size="sm" placeholder="Like a place…" aria-label="Add a place to be like" excludeIds={like} onPick={(c) => setLike((l) => [...l, c.id])} />
          {like.map((id) => (
            <Chip key={id} selected onRemove={() => setLike((l) => l.filter((x) => x !== id))}>
              {byId.get(id)?.name ?? id}
            </Chip>
          ))}
        </div>
        <div className="plan-sources-controls">
          <Segmented<LikenessLevel> label="Compare by" size="sm" options={LEVELS} value={level} onChange={setLevel} />
          <Select size="sm" aria-label="Where" value={within} onChange={(e) => setWithin(e.target.value)}>
            <option value="">Anywhere</option>
            {countries.map((c) => (
              <option key={c} value={c}>
                {displayCountry(c)}
              </option>
            ))}
          </Select>
        </div>
        {level === "region" ? <p className="plan-sources-note">Regions are the EU’s NUTS 2 areas, so this view covers Europe.</p> : null}
      </div>

      {!asking ? (
        <EmptyState size="page" icon={<IconWorld />} title="Start with a vibe or a place" description="Old towns, mountain lakes, a city you loved: Meridian finds the places alike and tells the original from the copies." />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setAttempt((a) => a + 1)} />
      ) : !data ? (
        <Skeleton height={240} />
      ) : (
        <div className="plan-sources-results">
          <ResultList title="Sources" meta={count(data.counts.sources, data.level)} rows={data.sources} empty="No source in this selection." />
          <ResultList title="Lighter echoes" meta={count(data.counts.echoes, data.level)} rows={data.echoes} empty="Nothing lighter alike: the sources stand alone." />
          <p className="plan-sources-note">
            Alike means the same traits stand out (mountains, water, sea, heritage, how photographed, notable places, size), measured, not rated.
            Strength is how much of the strongest source’s experience a place carries. Climate narrows a vibe only where Meridian has measured it; elsewhere it goes by latitude.
          </p>
        </div>
      )}
    </div>
  );
}

function count(n: number, level: LikenessLevel): string {
  const noun = level === "city" ? ["city", "cities"] : level === "region" ? ["region", "regions"] : ["country", "countries"];
  return `${n} ${n === 1 ? noun[0] : noun[1]}`;
}

function ResultList({ title, meta, rows, empty }: { title: string; meta: string; rows: Row[]; empty: string }) {
  return (
    <Card className="plan-sources-card">
      <SectionHeader level={3} title={title} meta={meta} />
      {rows.length ? (
        <ol className="plan-sources-list">
          {rows.map((r) => (
            <li key={isCity(r) ? r.cityId : r.id}>
              <ResultRow row={r} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="plan-sources-note">{empty}</p>
      )}
    </Card>
  );
}

function ResultRow({ row }: { row: Row }) {
  const city = isCity(row);
  const target = city ? row.cityId : row.lead.id;
  const where = city ? displayCountry(row.country) : row.country ? displayCountry(row.country) : `${row.cities} alike ${row.cities === 1 ? "place" : "places"}, led by ${row.lead.name}`;
  const why: string[] = [];
  if (row.echoOf) why.push(`A lighter ${row.echoOf.name}`);
  if (city && row.lesser?.length) why.push(row.lesser.map((a) => AXIS_LABELS[a].less).join(", "));
  if (city && row.gains?.length) why.push(row.gains.join(", "));
  if (!city && row.country) why.unshift(`Led by ${row.lead.name}`);
  return (
    <button type="button" className="plan-sources-row" onClick={() => openCity(target)}>
      <span className="plan-sources-name">
        {row.name}
        {city && row.seed ? <span className="plan-sources-seed">yours</span> : null}
        <span className="plan-sources-where">{where}</span>
      </span>
      <span className="plan-sources-meter" role="meter" aria-label="Strength" aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.strength} title={`Strength ${row.strength} · likeness ${row.likeness}`}>
        <span style={{ width: `${row.strength}%` }} />
      </span>
      <span className="plan-sources-num num">{row.strength}</span>
      {why.length ? <span className="plan-sources-why">{why.join(" · ")}</span> : null}
    </button>
  );
}
