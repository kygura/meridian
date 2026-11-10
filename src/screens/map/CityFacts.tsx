// City panel section "Living here": cost, rent, internet, healthcare, safety and crowds from
// measured data (GET /api/metrics/facts/:cityId, ADR 0013). Every row names how local its figure
// is and whether it is an estimate; a figure the sources don't have is shown as "No data".

import { useEffect, useState } from "react";
import { busiestMonths, factRows, fetchPlaceFacts, grainLabel, type PlaceFactsResponse, type VisitorMonths } from "../../lib/placeFacts";
import { ErrorState, SectionHeader, Skeleton } from "../../ui";
import type { City } from "../../types";

const MONTH_LETTERS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Twelve bars, tallest = busiest month. */
function MonthBars({ months, cityName }: { months: VisitorMonths; cityName: string }) {
  const max = Math.max(...months.index, 1);
  const where = months.granularity === "city" ? cityName : (months.place ?? "the whole country");
  const what =
    months.basis === "nights"
      ? `Nights in tourist accommodation, ${where}${months.years.length ? `, ${months.years[0]}–${months.years[months.years.length - 1]}` : ""}`
      : `Wikipedia page views for ${cityName}: interest, not visitors`;
  return (
    <figure className="map-busy">
      <figcaption>
        <span>{months.basis === "nights" ? "Visitors by month" : "Interest by month"}</span>
        <small>
          {what}. {grainLabel(months.granularity)}.
        </small>
      </figcaption>
      <div className="map-busy-bars" role="img" aria-label={`Busiest months: ${busiestMonths(months.index)}`}>
        {months.index.map((v, i) => (
          <span key={i} className="map-busy-col" title={`${MONTH_NAMES[i]}: ${(v / 100).toFixed(1)}× an average month`}>
            <span className="map-busy-bar" style={{ height: `${Math.max(4, Math.round((v / max) * 100))}%` }} />
            <span className="map-busy-letter" aria-hidden="true">
              {MONTH_LETTERS[i]}
            </span>
          </span>
        ))}
      </div>
    </figure>
  );
}

export default function CityFacts({ city }: { city: City }) {
  const [data, setData] = useState<PlaceFactsResponse | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(false);
    fetchPlaceFacts(city.id)
      .then((d) => live && setData(d))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [city.id, attempt]);

  const rows = data ? factRows(data, city.name) : [];
  const used = data ? [...new Set(rows.flatMap((r) => r.sources))].filter((k) => data.sources[k] || k === "homicides") : [];
  const gaps = rows.filter((r) => r.missing).length;
  const months = data?.crowds.months ?? data?.crowds.interestMonths ?? null;

  return (
    <section className="map-city-section" aria-labelledby={`${city.id}-facts`}>
      <SectionHeader
        level={3}
        id={`${city.id}-facts`}
        title="Living here"
        meta={data ? (data.score.overall === null ? "No overall score" : `Score ${data.score.overall}`) : null}
      />
      {error ? (
        <ErrorState message="Couldn’t load the figures for this city." onRetry={() => setAttempt((n) => n + 1)} />
      ) : !data ? (
        <Skeleton height={220} />
      ) : (
        <>
          <dl className="map-fact-list">
            {rows.map((r) => (
              <div key={r.id} className="map-fact" data-missing={r.missing || undefined}>
                <dt>{r.label}</dt>
                <dd>
                  <span className="map-fact-value">
                    <b className={r.missing ? undefined : "num"}>{r.value}</b>
                    {typeof r.score === "number" ? (
                      <span className="map-meter" role="meter" aria-label={`${r.label} score`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.score}>
                        <span style={{ width: `${r.score}%` }} />
                      </span>
                    ) : null}
                  </span>
                  {r.detail ? <span className="map-fact-detail">{r.detail}</span> : null}
                  {r.tag ? <span className="map-fact-tag">{r.tag}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          {months ? <MonthBars months={months} cityName={city.name} /> : null}
          <p className="map-city-note">
            {data.score.overall === null
              ? `Too few measures for an overall score (${data.score.parts} of 6; it takes 3).`
              : `Overall score ${data.score.overall} of 100, from ${data.score.parts} of 6 measures.`}{" "}
            {gaps ? `${gaps === 1 ? "One figure has" : `${gaps} figures have`} no data and ${gaps === 1 ? "is" : "are"} left blank, not guessed.` : "Every figure here is measured or worked out from measured data."}
          </p>
          {used.length ? (
            <details className="map-sources">
              <summary>Where these figures come from</summary>
              <ul>
                {data.cost.monthlyEur && data.anchor ? (
                  <li>
                    Monthly cost is an estimate: what a resident of {data.anchor.place} spends a month (€
                    {data.anchor.monthlyEur.toLocaleString("en-US")}, {data.anchor.y}) repriced at this {data.cost.monthlyEur.granularity === "city" ? "city’s" : "country’s"} prices.
                  </li>
                ) : null}
                {used.map((k) =>
                  data.sources[k] ? (
                    <li key={k}>
                      <a href={data.sources[k].url} target="_blank" rel="noreferrer">
                        {data.sources[k].name}
                      </a>
                      <small> {data.sources[k].licence}</small>
                    </li>
                  ) : (
                    <li key={k}>Homicides per 100,000 people: World Bank (UNODC)</li>
                  )
                )}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
