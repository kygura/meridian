import type { Fingerprint, FingerprintDim, Journey, Money } from "../../types";
import { MONTHS, comfortSentence, formatDay, formatEur, spendBreakdown } from "../../lib/journal";

const CROWD_TITLE =
  "Estimated from the city's comfort season and school holidays in its main source markets — not measured crowds.";
const PENDING_TITLE = "Weather service quota hit — retries automatically";

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

interface Dim {
  dim: FingerprintDim;
  key: string;
  value: (f: Fingerprint) => number | undefined;
  text: (n: number) => string;
  /** Bar fill 0-1. Fixed display scales, not statistics. */
  fill: (n: number) => number;
}

const DIMS: Dim[] = [
  { dim: "month", key: "MONTH", value: (f) => f.month, text: (n) => MONTHS[n - 1] ?? "—", fill: (n) => n / 12 },
  { dim: "comfort", key: "COMFORT", value: (f) => f.comfort, text: (n) => String(Math.round(n)), fill: (n) => n / 100 },
  { dim: "tempC", key: "TEMP", value: (f) => f.tempC, text: (n) => `${Math.round(n)}°C`, fill: (n) => (n + 10) / 50 },
  { dim: "precipMm", key: "RAIN", value: (f) => f.precipMm, text: (n) => `${Math.round(n)} mm`, fill: (n) => n / 300 },
  { dim: "dailySpendEur", key: "SPEND / DAY", value: (f) => f.dailySpendEur, text: formatEur, fill: (n) => n / 400 },
  { dim: "flightCostEurPer1000km", key: "FLIGHT / 1000 KM", value: (f) => f.flightCostEurPer1000km, text: formatEur, fill: (n) => n / 400 },
  { dim: "crowdProxy", key: "CROWD (PROXY)", value: (f) => f.crowdProxy, text: (n) => String(Math.round(n)), fill: (n) => n / 100 },
];

/** "€412 · from 2,350 PLN at 14 May 2024" lines for every non-EUR amount. */
function fxNote(monies: (Money | undefined)[]): string | undefined {
  const lines = monies
    .filter((m): m is Money => !!m && m.currency !== "EUR")
    .map((m) => `${formatEur(m.eur)} · from ${m.amount.toLocaleString("en-US")} ${m.currency} at ${formatDay(m.rateDate)} ${m.rateDate.slice(0, 4)}`);
  return lines.length ? lines.join("\n") : undefined;
}

/** Fingerprint of the journey (or one stop): sentence, per-dimension status, spend (§5). */
export default function FingerprintPanel({
  journey,
  stopIndex,
  stopName,
  fingerprint,
  onClearStop,
  onFindSimilar,
}: {
  journey: Journey;
  stopIndex: number | null;
  stopName?: string;
  fingerprint?: Fingerprint;
  onClearStop: () => void;
  onFindSimilar: () => void;
}) {
  const stop = stopIndex !== null ? journey.stops[stopIndex] : undefined;
  const sentence = comfortSentence(stop ? [stop] : journey.stops);
  const spend = spendBreakdown(journey);
  const scopeName = stop ? stopName ?? stop.cityId : null;

  return (
    <aside className="jr-fp" aria-label="Fingerprint">
      <div className="jr-fp-head">
        <span className="jr-eyebrow">
          FINGERPRINT{scopeName ? ` · ${scopeName.toUpperCase()}` : ""}
          {stop && (
            <button type="button" className="tp-link jr-fp-back" onClick={onClearStop}>
              × JOURNEY
            </button>
          )}
        </span>
        {fingerprint && <span className="jr-fp-time">{fingerprint.computedAt.slice(0, 10)}</span>}
      </div>

      <p className={`jr-fp-sentence${sentence.kind === "unknown" ? " dim" : ""}`}>{sentence.text}</p>

      {fingerprint ? (
        DIMS.map((d) => {
          const status = fingerprint.status[d.dim] ?? "absent";
          const v = d.value(fingerprint);
          const isCrowd = d.dim === "crowdProxy";
          const override = isCrowd && fingerprint.crowdIsOverride;
          const title = status === "pending" ? PENDING_TITLE : isCrowd ? CROWD_TITLE : undefined;
          return (
            <div key={d.dim} className={`micro-row jr-fp-row ${status}`} title={title}>
              <span className="mr-key">{d.key}</span>
              <span className="mr-bar">
                {status === "ok" && v !== undefined && <span className="fill" style={{ width: `${clamp01(d.fill(v)) * 100}%` }} />}
              </span>
              <span className="mr-val">{status === "ok" && v !== undefined ? d.text(v) : status === "pending" ? "…" : "—"}</span>
              <span className={`jr-fp-chip ${status}${override ? " override" : ""}`}>
                {override ? "YOUR CALL" : status === "pending" ? "PENDING" : status === "absent" ? "NO DATA" : ""}
              </span>
            </div>
          );
        })
      ) : (
        <p className="jr-fp-none">Fingerprint not computed yet.</p>
      )}

      {!stop && (
        <div className="jr-fp-spend">
          <div className="jr-label">SPEND (EUR)</div>
          {spend.priced ? (
            ([
              ["STAYS", spend.stays, spend.has.stays, fxNote(journey.stops.map((s) => s.lodging?.cost))],
              ["TRANSPORT", spend.transport, spend.has.transport, fxNote(journey.segments.map((s) => s.cost))],
              ["EXPERIENCES", spend.experiences, spend.has.experiences, fxNote(journey.experiences.map((x) => x.cost))],
              ["TOTAL", spend.total, true, undefined],
            ] as [string, number, boolean, string | undefined][]).map(([k, v, has, note]) => (
              <div key={k} className={`micro-row jr-fp-row${has ? "" : " absent"}`} title={note}>
                <span className="mr-key">{k}</span>
                <span className="mr-bar">
                  {has && <span className="fill" style={{ width: `${spend.total ? (v / spend.total) * 100 : 0}%` }} />}
                </span>
                <span className="mr-val">{has ? formatEur(v) : "—"}</span>
                <span />
              </div>
            ))
          ) : (
            <p className="jr-fp-none">No money recorded.</p>
          )}
        </div>
      )}

      <button type="button" className="tp-link" onClick={onFindSimilar}>
        FIND SIMILAR ↗
      </button>
    </aside>
  );
}
