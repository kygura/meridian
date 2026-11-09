// City panel section: how good the city is to live in, and how beautiful it is, with the
// parts and plain facts behind each score (GET /api/livability/:cityId).

import { useEffect, useState } from "react";
import { fetchLivability, livabilityFacts, type LivabilityDetail } from "../../lib/livability";
import { hrefFor } from "../../lib/router";
import { SectionHeader, Skeleton } from "../../ui";
import type { City } from "../../types";

function Meter({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  if (value === null) return null;
  return (
    <div className="map-metric" title={hint}>
      <div className="map-metric-top">
        <span>{label}</span>
        <span className="num">{value}</span>
      </div>
      <div className="map-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <span style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export default function CityLiveLove({ city }: { city: City }) {
  const [data, setData] = useState<LivabilityDetail | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setData(undefined);
    fetchLivability(city.id)
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [city.id]);

  if (data === null) return null; // no scores for this city
  const facts = data ? livabilityFacts(data) : null;

  return (
    <section className="map-city-section" aria-labelledby={`${city.id}-live`}>
      <SectionHeader level={3} id={`${city.id}-live`} title="Live & love" />
      {!data ? (
        <Skeleton height={120} />
      ) : (
        <div className="map-live">
          <div className="map-live-score">
            <span className="map-live-big num">{data.quality ?? "—"}</span>
            <span>
              Quality of life
              <small>{data.local > 0 ? "Air measured here; the rest are country figures" : "Country figures"}</small>
            </span>
          </div>
          <div className="map-metrics">
            <Meter label="Human development" value={data.qualityParts.hdi} hint="UNDP Human Development Index" />
            <Meter label="Life satisfaction" value={data.qualityParts.happiness} hint="World Happiness Report" />
            <Meter label="Low homicide rate" value={data.qualityParts.safety} hint="Intentional homicides per 100,000, World Bank" />
            <Meter label="Clean air" value={data.qualityParts.air} hint="Fine particles (PM2.5)" />
          </div>
          {facts!.quality.length ? <p className="map-live-facts">{facts!.quality.join(" · ")}</p> : null}

          <div className="map-live-score">
            <span className="map-live-big num">{data.beauty ?? "—"}</span>
            <span>
              Beauty
              <small>Natural setting and built character; the stronger counts more</small>
            </span>
          </div>
          <div className="map-metrics">
            <Meter label="Natural setting" value={data.setting} hint="Mountains, sea and lakes nearby" />
            <Meter label="Built character" value={data.character} hint="Heritage, how photographed, notable places" />
          </div>
          {[...facts!.setting, ...facts!.character].length ? (
            <p className="map-live-facts">{[...facts!.setting, ...facts!.character].join(" · ")}</p>
          ) : null}
          <a className="map-live-link" href={hrefFor({ view: "plan", tab: "live" })}>
            Compare every city on Live &amp; love →
          </a>
        </div>
      )}
    </section>
  );
}
