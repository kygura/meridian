// City panel section: is this place the source of its experience, or a lighter echo of one?
// GET /api/likeness?like=<city> (ADR 0019). Hidden for cities without setting or character data.

import { useEffect, useState } from "react";
import { AXIS_LABELS, type LikenessCityRow, type LikenessResponse } from "../../lib/likeness";
import { fetchLikeness, setSourcesSeed } from "../../lib/likenessApi";
import { hrefFor, navigate } from "../../lib/router";
import { openCity } from "../../shell/uiStore";
import { SectionHeader, Skeleton } from "../../ui";
import type { City } from "../../types";

export default function CityLikeness({ city }: { city: City }) {
  const [data, setData] = useState<Extract<LikenessResponse, { level: "city" }> | null | undefined>(undefined);

  useEffect(() => {
    const ctl = new AbortController();
    setData(undefined);
    fetchLikeness({ vibes: [], like: [city.id], level: "city", limit: 4 }, ctl.signal)
      .then((d) => setData(d.level === "city" ? d : null))
      .catch(() => {
        if (!ctl.signal.aborted) setData(null);
      });
    return () => ctl.abort();
  }, [city.id]);

  if (data === null) return null;
  const self = data ? [...data.sources, ...data.echoes].find((r) => r.cityId === city.id) : undefined;
  const others = (rows: LikenessCityRow[]) => rows.filter((r) => r.cityId !== city.id);

  let summary = "";
  if (self?.role === "source") summary = `${city.name} is a source: no alike place has more of it.`;
  else if (self?.echoOf) {
    const lesser = self.lesser?.length ? `, with ${self.lesser.map((a) => AXIS_LABELS[a].less).join(" and ")}` : "";
    summary = `${city.name} is a lighter ${self.echoOf.name}${lesser}.`;
  }

  return (
    <section className="map-city-section" aria-labelledby={`${city.id}-like`}>
      <SectionHeader level={3} id={`${city.id}-like`} title="The source and its echoes" />
      {!data ? (
        <Skeleton height={80} />
      ) : (
        <div className="map-like">
          {summary ? <p className="map-city-note">{summary}</p> : null}
          <LikeList label="Sources" rows={others(data.sources).slice(0, 3)} />
          <LikeList label="Lighter echoes" rows={others(data.echoes).slice(0, 4)} />
          <a
            className="map-live-link"
            href={hrefFor({ view: "plan", tab: "sources" })}
            onClick={(e) => {
              e.preventDefault();
              setSourcesSeed(city.id);
              navigate({ view: "plan", tab: "sources" });
            }}
          >
            Explore places like {city.name} in Sources →
          </a>
        </div>
      )}
    </section>
  );
}

function LikeList({ label, rows }: { label: string; rows: LikenessCityRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="map-like-group">
      <span className="map-like-label">{label}</span>
      <div className="map-like-chips">
        {rows.map((r) => (
          <button key={r.cityId} type="button" className="map-like-place" onClick={() => openCity(r.cityId)} title={`Strength ${r.strength} · likeness ${r.likeness}`}>
            {r.name}
            <span className="num">{r.strength}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
