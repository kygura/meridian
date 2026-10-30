import { useEffect, useRef } from "react";
import { MONTHS, formatEur } from "../../lib/journal";
import { comfortBin } from "../../lib/seasonality";
import { points, resultKey } from "../../lib/replayGrid";
import type { City, FingerprintDim, ReplayResult } from "../../types";

const SHORT: Record<FingerprintDim, string> = {
  month: "MONTH",
  comfort: "CLIMATE",
  tempC: "TEMP",
  precipMm: "RAIN",
  dailySpendEur: "SPEND",
  flightCostEurPer1000km: "FLIGHT",
  crowdProxy: "CROWD",
};

const bars = (share: number): string => {
  const n = Math.max(1, Math.min(5, Math.round(share * 5)));
  return "▮".repeat(n) + "▯".repeat(5 - n);
};

function priceDelta(p: NonNullable<ReplayResult["price"]>): number | undefined {
  return p.priceEur !== undefined && p.baselineEur ? Math.round(((p.priceEur - p.baselineEur) / p.baselineEur) * 100) : undefined;
}

/** Right column: ranked results with Repeat and Watch (DESIGN-journal §7.5). */
export default function ReplayResultList({
  results,
  cityById,
  selectedKey,
  watchedKey,
  onSelect,
  onHover,
  onRepeat,
  onWatch,
}: {
  results: ReplayResult[];
  cityById: Map<string, City>;
  /** `cityId:month` of the selected result. */
  selectedKey: string | null;
  /** Key whose WATCH just saved (flashes WATCHING), or "query" for the header button. */
  watchedKey: string | null;
  onSelect: (r: ReplayResult) => void;
  onHover: (cityId: string | null) => void;
  onRepeat: (r: ReplayResult) => void;
  /** No result = watch the whole query. */
  onWatch: (r?: ReplayResult) => void;
}) {
  const selected = useRef<HTMLLIElement>(null);
  useEffect(() => {
    selected.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedKey]);

  return (
    <aside className="jr-rl" aria-label="Ranked results">
      <div className="jr-rl-head">
        <span className="jr-label">RANKED · {results.length}</span>
        <button type="button" className="tm-action-btn" onClick={() => onWatch()}>
          {watchedKey === "query" ? "WATCHING" : "WATCH THIS QUERY"}
        </button>
      </div>
      <ol className="jr-rl-list">
        {results.map((r, i) => {
          const key = resultKey(r);
          const c = cityById.get(r.cityId);
          const name = c?.name ?? r.cityId;
          const top = [...r.dims].sort((a, b) => b.contribution - a.contribution).slice(0, 2);
          const delta = r.price ? priceDelta(r.price) : undefined;
          const on = key === selectedKey;
          return (
            <li
              key={key}
              ref={on ? selected : undefined}
              className={`jr-rl-row${on ? " on" : ""}`}
              onMouseEnter={() => onHover(r.cityId)}
              onMouseLeave={() => onHover(null)}
            >
              <button
                type="button"
                className="jr-rl-main"
                aria-pressed={on}
                aria-label={`${i + 1}. ${name}, ${MONTHS[r.month - 1]}: match ${points(r.match)}`}
                onClick={() => onSelect(r)}
              >
                <span className="jr-rl-rank">{String(i + 1).padStart(2, "0")}</span>
                <span className="jr-rl-iata">{c?.iata ?? "—"}</span>
                <span className="jr-rl-name">
                  {name} · {MONTHS[r.month - 1]}
                </span>
                <span className={`jr-rl-match peak-b${comfortBin(points(r.match))}`}>{points(r.match)}</span>
              </button>
              <div className="jr-rl-meta">
                {r.price && (
                  <span>
                    ✈ {r.price.priceEur !== undefined ? formatEur(r.price.priceEur) : `${Math.round(r.price.priceAmount)} ${r.price.currency}`}
                    {r.price.source === "mock" && (
                      <span className="bk-badge bk-badge-mock jr-mock" aria-label="Mock price, not used for scoring">MOCK</span>
                    )}
                    {delta !== undefined && <span className={delta < 0 ? "jr-good" : undefined}> {delta < 0 ? "−" : "+"}{Math.abs(delta)}%</span>}
                  </span>
                )}
                {r.events?.length ? <span className="jr-ev-txt">◆ {r.events.length} EVENT{r.events.length > 1 ? "S" : ""}</span> : null}
                <span>{r.visitedBefore ? "VISITED" : "NEW"}</span>
              </div>
              <div className="jr-rl-why">
                {top.map((d) => (
                  <span key={d.name}>
                    {bars(d.contribution)} {SHORT[d.name]}
                  </span>
                ))}
              </div>
              <div className="jr-rl-actions">
                <button type="button" className="tm-action-btn" onClick={() => onRepeat(r)}>
                  ↻ REPEAT
                </button>
                <button type="button" className="tm-action-btn" aria-label={`Watch ${name} in ${MONTHS[r.month - 1]}`} onClick={() => onWatch(r)}>
                  {watchedKey === key ? "WATCHING" : "WATCH"}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
