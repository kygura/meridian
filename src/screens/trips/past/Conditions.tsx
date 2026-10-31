import type { City, Experience, Fingerprint, Journey, Segment, Stop } from "../../../types";
import { MODE_LABEL, comfortSentence, formatEur, formatMoney, legKm, spendBreakdown, stopNights } from "../../../lib/journal";
import { Badge, Button, Card } from "../../../ui";
import { Stars } from "./Rating";
import {
  crowdCondition,
  day,
  fingerprintRows,
  num,
  plural,
  range,
  sourceLabel,
  weatherCondition,
  weatherPending,
  WEATHER_PENDING,
  when,
  type Condition,
} from "./format";

const LODGING_KIND: Record<string, string> = {
  hotel: "Hotel",
  apartment: "Apartment",
  hostel: "Hostel",
  friends: "With friends",
  other: "Other",
};

const EXPERIENCE_KIND: Record<string, string> = {
  food: "Food",
  tour: "Tour",
  nature: "Nature",
  event: "Event",
  culture: "Culture",
  nightlife: "Nightlife",
  other: "Other",
};

export { LODGING_KIND, EXPERIENCE_KIND };

function ConditionLine({ label, c }: { label: string; c: Condition }) {
  return (
    <div className="trips-jd-cond" data-state={c.state}>
      <dt className="trips-jd-cond-label">{label}</dt>
      <dd className="trips-jd-cond-value">
        <span className="trips-jd-cond-text">
          {c.text}
          {c.badge ? (
            <Badge tone={c.tone === "success" ? "success" : c.tone === "warning" ? "warning" : "neutral"}>{c.badge}</Badge>
          ) : null}
        </span>
        {c.detail ? <span className="trips-jd-cond-detail">{c.detail}</span> : null}
      </dd>
    </div>
  );
}

/** One stop: city, dates, stay, and the conditions met (observed weather vs normal, crowds). */
export function StopCard({
  stop: s,
  index,
  city,
  journeyFp,
  selected,
  onSelect,
}: {
  stop: Stop;
  index: number;
  city?: City;
  journeyFp?: Fingerprint;
  selected: boolean;
  onSelect: () => void;
}) {
  const nights = stopNights(s);
  const source = sourceLabel(s.provenance?.source);
  return (
    <li className="trips-jd-stop">
      <span className="trips-jd-stop-n num" aria-hidden="true">
        {index + 1}
      </span>
      <Card className="trips-jd-stop-card" data-selected={selected || undefined}>
        <div className="trips-jd-stop-head">
          <div className="trips-jd-stop-titles">
            <h3 className="trips-jd-stop-name">
              <span className="sr-only">{`Stop ${index + 1}: `}</span>
              {city?.name ?? s.cityId}
            </h3>
            {city?.country ? <span className="trips-jd-stop-country">{city.country}</span> : null}
          </div>
          <Stars value={s.rating} label="Stop rating" />
        </div>
        <p className="trips-jd-stop-dates">
          <span className="trips-nowrap num">{range(s.arrive, s.depart, false)}</span>
          <span aria-hidden="true"> · </span>
          <span className="trips-nowrap">{plural(nights, "night")}</span>
          {source ? (
            <>
              {" "}
              <Badge>{source}</Badge>
            </>
          ) : null}
        </p>
        {s.lodging ? (
          <p className="trips-jd-stop-stay">
            Stayed at {s.lodging.name}
            {s.lodging.kind ? ` · ${LODGING_KIND[s.lodging.kind] ?? ""}` : ""}
            {s.lodging.cost ? <span className="num"> · {formatMoney(s.lodging.cost)}</span> : null}
          </p>
        ) : null}
        <dl className="trips-jd-conds">
          <ConditionLine label="Weather" c={weatherCondition(s, journeyFp)} />
          <ConditionLine label="Crowds" c={crowdCondition(s, journeyFp)} />
        </dl>
        <div className="trips-jd-stop-actions">
          <Button variant="ghost" size="sm" aria-pressed={selected} onClick={onSelect}>
            {selected ? "Show whole trip" : "Show this stop's fingerprint"}
          </Button>
        </div>
      </Card>
    </li>
  );
}

/** Fingerprint of the trip or of one stop: what it was like, as used to find similar places. */
export function FingerprintCard({
  journey,
  stop,
  stopName,
  fingerprint,
  onClearStop,
}: {
  journey: Journey;
  stop?: Stop;
  stopName?: string;
  fingerprint?: Fingerprint;
  onClearStop: () => void;
}) {
  const sentence = comfortSentence(stop ? [stop] : journey.stops);
  const pending = weatherPending(fingerprint) || (!fingerprint && weatherPending(journey.fingerprint));
  const lead =
    sentence.kind === "unknown"
      ? pending
        ? `${WEATHER_PENDING}.`
        : "No weather recorded for these dates yet."
      : sentence.kind === "kinder"
        ? "Nicer weather than the season usually gives."
        : sentence.kind === "rougher"
          ? "Rougher weather than the season usually gives."
          : "About what the season usually gives.";
  const tone = sentence.kind === "kinder" ? "success" : sentence.kind === "rougher" ? "warning" : undefined;

  return (
    <Card className="trips-jd-fp" aria-labelledby="trips-jd-fp-title">
      <div className="trips-jd-card-head">
        <h2 id="trips-jd-fp-title" className="trips-jd-card-title">
          {stop ? `Fingerprint · ${stopName ?? stop.cityId}` : "Fingerprint"}
        </h2>
        {stop ? (
          <Button variant="ghost" size="sm" onClick={onClearStop}>
            Whole trip
          </Button>
        ) : null}
      </div>
      <p className="trips-jd-fp-lead" data-tone={tone}>
        {lead}
      </p>
      {fingerprint ? (
        <dl className="trips-jd-meters">
          {fingerprintRows(fingerprint).map((r) => (
            <div key={r.dim} className="trips-jd-meter" data-state={r.state}>
              <dt>{r.label}</dt>
              <dd>
                <span className="trips-jd-meter-bar" aria-hidden="true">
                  {r.state === "ok" ? <span style={{ width: `${Math.round(r.fill * 100)}%` }} /> : null}
                </span>
                <span className="trips-jd-meter-value num">
                  {r.value}
                  {r.note ? <span className="trips-jd-meter-note"> · {r.note}</span> : null}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {fingerprint && sentence.kind !== "unknown" && weatherPending(fingerprint) ? (
        <p className="trips-jd-muted">{WEATHER_PENDING}.</p>
      ) : null}
      {fingerprint ? null : (
        <p className="trips-jd-muted">{pending ? WEATHER_PENDING : "Not worked out yet. It appears shortly after saving."}</p>
      )}
    </Card>
  );
}

/** Stays, transport and experiences in euros. Unpriced categories show a dash, never zero. */
export function SpendCard({ journey }: { journey: Journey }) {
  const spend = spendBreakdown(journey);
  const rows: [string, number, boolean][] = [
    ["Stays", spend.stays, spend.has.stays],
    ["Transport", spend.transport, spend.has.transport],
    ["Experiences", spend.experiences, spend.has.experiences],
  ];
  return (
    <Card className="trips-jd-spend" aria-labelledby="trips-jd-spend-title">
      <div className="trips-jd-card-head">
        <h2 id="trips-jd-spend-title" className="trips-jd-card-title">
          Spending
        </h2>
        {spend.priced ? <span className="trips-jd-spend-total num">{formatEur(spend.total)}</span> : null}
      </div>
      {spend.priced ? (
        <dl className="trips-jd-meters">
          {rows.map(([label, v, has]) => (
            <div key={label} className="trips-jd-meter" data-state={has ? "ok" : "none"}>
              <dt>{label}</dt>
              <dd>
                <span className="trips-jd-meter-bar" aria-hidden="true">
                  {has ? <span style={{ width: `${spend.total ? Math.round((v / spend.total) * 100) : 0}%` }} /> : null}
                </span>
                <span className="trips-jd-meter-value num">{has ? formatEur(v) : "—"}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="trips-jd-muted">No costs recorded.</p>
      )}
    </Card>
  );
}

export function SegmentItem({ seg: g, cities }: { seg: Segment; cities: Map<string, City> }) {
  const km = legKm(g, cities);
  const name = (id: string) => cities.get(id)?.name ?? id;
  const source = sourceLabel(g.provenance?.source);
  const meta = [
    when(g.departAt),
    [g.carrier, g.number].filter(Boolean).join(" "),
    km !== undefined ? `${num(km)} km` : "",
    g.cost ? formatMoney(g.cost) : "",
  ].filter(Boolean);
  return (
    <li className="trips-jd-item">
      <div className="trips-jd-item-main">
        <span className="trips-jd-item-title">
          {MODE_LABEL[g.mode] ?? "Other"} · {name(g.fromCityId)} → {name(g.toCityId)}
        </span>
        <span className="trips-jd-item-meta num">{meta.join(" · ")}</span>
      </div>
      {source ? <Badge>{source}</Badge> : null}
    </li>
  );
}

export function ExperienceItem({ x, cities }: { x: Experience; cities: Map<string, City> }) {
  const source = sourceLabel(x.provenance?.source);
  const meta = [
    cities.get(x.cityId)?.name ?? x.cityId,
    day(x.date),
    x.kind ? EXPERIENCE_KIND[x.kind] : "",
    x.cost ? formatMoney(x.cost) : "",
  ].filter(Boolean);
  return (
    <li className="trips-jd-item">
      <div className="trips-jd-item-main">
        <span className="trips-jd-item-title">{x.title}</span>
        <span className="trips-jd-item-meta num">{meta.join(" · ")}</span>
      </div>
      <span className="trips-jd-item-side">
        <Stars value={x.rating} label="Rating" />
        {source ? <Badge>{source}</Badge> : null}
      </span>
    </li>
  );
}
