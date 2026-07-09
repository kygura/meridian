import { createPortal } from "react-dom";
import { comfortBin, COMFORT_LABELS } from "../../lib/seasonality";

export interface HeatTooltipData {
  /** e.g. "LISBON · MAY" or "REGION · PORTUGAL" */
  title: string;
  score: number;
  /** Omitted for region rows (aggregates carry scores only). */
  tempC?: number;
  precipMm?: number;
  /** Show the CLICK → SELECT · G → GLOBE hint (city cells only). */
  showHint?: boolean;
}

/**
 * Portal-rendered floating card (DESIGN-heatmap.md §4.1). Positioned above
 * the anchor cell, flipping below when there's no headroom.
 */
export default function HeatTooltip({
  anchor,
  data,
}: {
  anchor: DOMRect;
  data: HeatTooltipData;
}) {
  const bin = comfortBin(data.score);
  const word = COMFORT_LABELS[bin];

  const centerX = anchor.left + anchor.width / 2;
  const clampedX = Math.min(Math.max(centerX, 90), window.innerWidth - 90);
  const flipBelow = anchor.top < 160;
  const style: React.CSSProperties = flipBelow
    ? { left: clampedX, top: anchor.bottom + 8, transform: "translateX(-50%)" }
    : { left: clampedX, top: anchor.top - 8, transform: "translate(-50%, -100%)" };

  return createPortal(
    <div className="heat-tooltip" style={style} role="tooltip">
      <div className="ht-head">{data.title}</div>
      <div className="ht-rule" />
      <div className="ht-score-row">
        <span className={`ht-score peak-b${bin}`}>{data.score}</span>
        <span className="ht-word">COMFORT · {word}</span>
      </div>
      {(data.tempC !== undefined || data.precipMm !== undefined) && (
        <>
          <div className="ht-rule" />
          {data.tempC !== undefined && (
            <div className="ht-kv">
              <span className="k">TEMP</span>
              <span className="v">{Math.round(data.tempC)} °C</span>
            </div>
          )}
          {data.precipMm !== undefined && (
            <div className="ht-kv">
              <span className="k">RAIN</span>
              <span className="v">{Math.round(data.precipMm)} mm</span>
            </div>
          )}
        </>
      )}
      {data.showHint && (
        <>
          <div className="ht-rule" />
          <div className="ht-hint">CLICK → SELECT · G → GLOBE</div>
        </>
      )}
    </div>,
    document.body
  );
}
