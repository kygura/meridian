import { createPortal } from "react-dom";
import { MONTH_ABBR, comfortBin } from "../../lib/seasonality";
import { MONTHS, formatEur } from "../../lib/journal";
import { matchWord, type ReplayRowModel } from "../../lib/replayGrid";
import type { FingerprintDim, ReplayDimScore, ReplayResult } from "../../types";

const DIM_LABEL: Record<FingerprintDim, string> = {
  month: "MONTH",
  comfort: "COMFORT",
  tempC: "TEMP",
  precipMm: "RAIN",
  dailySpendEur: "SPEND",
  flightCostEurPer1000km: "FLIGHT",
  crowdProxy: "CROWD",
};

const r0 = (n: number) => String(Math.round(n));

function dimValues(d: ReplayDimScore): string {
  switch (d.name) {
    case "month":
      return `${MONTHS[d.value - 1] ?? d.value} vs ${MONTHS[d.templateValue - 1] ?? d.templateValue}`;
    case "tempC":
      return `${r0(d.value)}°C vs ${r0(d.templateValue)}`;
    case "precipMm":
      return `${r0(d.value)} mm vs ${r0(d.templateValue)}`;
    case "crowdProxy":
      return `${r0(d.value)} vs ${r0(d.templateValue)} (PROXY)`;
    case "dailySpendEur":
      return `${formatEur(d.value)} vs ${formatEur(d.templateValue)}`;
    case "flightCostEurPer1000km":
      if (d.basis === "dealRating") return `${formatEur(d.value)} /1000 KM (DEAL RATING)`;
      return `${formatEur(d.value)} vs ${formatEur(d.templateValue)} /1000 KM`;
    default:
      return `${r0(d.value)} vs ${r0(d.templateValue)}`;
  }
}

const ALL_DIMS = Object.keys(DIM_LABEL) as FingerprintDim[];

function Price({ price }: { price: NonNullable<ReplayResult["price"]> }) {
  const mock = price.source === "mock";
  const amount = price.priceEur !== undefined ? formatEur(price.priceEur) : `${Math.round(price.priceAmount)} ${price.currency}`;
  const delta =
    price.priceEur !== undefined && price.baselineEur ? Math.round(((price.priceEur - price.baselineEur) / price.baselineEur) * 100) : undefined;
  return (
    <>
      <div className="ht-kv">
        <span className="k">FLIGHT</span>
        <span className="v">
          {amount}
          {mock ? (
            <span className="bk-badge bk-badge-mock jr-mock" aria-label="Mock price, not used for scoring">MOCK</span>
          ) : (
            <span className="jr-src">{price.source.toUpperCase()}</span>
          )}
        </span>
      </div>
      {price.baselineEur !== undefined && delta !== undefined && (
        <div className={`jr-base${delta < 0 ? " good" : ""}`}>
          baseline {formatEur(price.baselineEur)} · {delta < 0 ? "−" : "+"}
          {Math.abs(delta)} %
        </div>
      )}
      {mock && <div className="ht-hint">MOCK PRICE · NOT USED FOR SCORING</div>}
    </>
  );
}

/** Per-dimension breakdown + price provenance (DESIGN-journal §7.3). Reuses the .heat-tooltip shell. */
export default function ReplayTooltip({
  anchor,
  row,
  col,
  name,
  fromIata,
}: {
  anchor: DOMRect;
  row: ReplayRowModel;
  col: number;
  name: string;
  fromIata?: string;
}) {
  const cell = row.cells[col];
  if (!cell) return null;
  const result = cell.result;
  const bin = comfortBin(cell.match);

  const centerX = anchor.left + anchor.width / 2;
  const clampedX = Math.min(Math.max(centerX, 130), window.innerWidth - 130);
  const flipBelow = anchor.top < 380;
  const style: React.CSSProperties = flipBelow
    ? { left: clampedX, top: anchor.bottom + 8, transform: "translateX(-50%)" }
    : { left: clampedX, top: anchor.top - 8, transform: "translate(-50%, -100%)" };

  return createPortal(
    <div className="heat-tooltip jr-ttip" style={style} role="tooltip">
      <div className="ht-head jr-ttip-head">
        <span>
          {name.toUpperCase()} · {MONTH_ABBR[col]}
        </span>
        {result?.visitedBefore && <span className="sr-pill">VISITED</span>}
      </div>
      <div className="ht-rule" />
      <div className="ht-score-row">
        <span className={`ht-score peak-b${bin}`}>{cell.match}</span>
        <span className="ht-word">MATCH · {matchWord(cell.match)}</span>
      </div>
      {result ? (
        <>
          <div className="ht-rule" />
          {result.dims.map((d) => (
            <div key={d.name} className="micro-row jr-dimrow">
              <span className="mr-key">{DIM_LABEL[d.name]}</span>
              <span className="jr-dimval">{dimValues(d)}</span>
              <span className="mr-bar" aria-hidden="true">
                <span className="fill" style={{ width: `${Math.round(d.contribution * 100)}%` }} />
              </span>
              <span className="mr-val">{Math.round(d.contribution * 100)}%</span>
            </div>
          ))}
          {ALL_DIMS.filter((n) => !result.scoredOn.includes(n) && !(n === "flightCostEurPer1000km" && result.price)).map((n) => (
            <div key={n} className="micro-row jr-dimrow absent">
              <span className="mr-key">{DIM_LABEL[n]}</span>
              <span className="jr-dimval">NOT SCORED</span>
            </div>
          ))}
          {result.price && (
            <>
              <div className="ht-rule" />
              <Price price={result.price} />
              {fromIata && <div className="jr-src">FROM {fromIata}</div>}
            </>
          )}
          {result.events?.map((e) => (
            <div key={e.id} className="jr-evline">
              ◆ {e.title}
            </div>
          ))}
          <div className="ht-rule" />
          <div className="ht-hint">CLICK → SELECT · G → GLOBE</div>
        </>
      ) : (
        <>
          <div className="ht-rule" />
          <div className="ht-hint">CLIMATE-STAGE SCORE ONLY · NOT RANKED OR PRICED</div>
        </>
      )}
    </div>,
    document.body
  );
}
