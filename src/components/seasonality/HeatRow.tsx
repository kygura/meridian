import { useState } from "react";
import HeatCell, { type CellState } from "./HeatCell";
import {
  bestWindow,
  isMonthInWindow,
  formatBestSpan,
  comfortBin,
  COMFORT_LABELS,
  MONTH_ABBR,
  type BestWindow,
} from "../../lib/seasonality";

/** One cell's data — regions carry score only, cities carry temp/precip too. */
export interface RowMonth {
  score: number;
  tempC?: number;
  precipMm?: number;
}

export interface RenderRow {
  /** Stable key: cityId, or "region:<name>". */
  key: string;
  kind: "city" | "region";
  cityId?: string;
  label: string;
  country?: string;
  iata?: string;
  badge: "SELECTED" | "SHORTLIST" | "TRIP" | "REGION" | "VISITED" | "NEW";
  /** True for SHORTLIST rows only — shows the remove ✕. */
  removable: boolean;
  /** Badge tooltip for TRIP-only rows: "From a trip". */
  badgeTitle?: string;
  /** Array = covered, null = uncovered, or a transient state. */
  months: (RowMonth | null)[] | null | "loading" | "unavailable";
  /** Replay extras, all optional. false skips the best-window rings and BEST summary window (default true). */
  bestWindow?: boolean;
  /** Length 12: per-cell template outline, event titles, na tooltip. */
  cellMeta?: ({ template?: boolean; eventTitles?: string[]; naTitle?: string; muted?: boolean } | undefined)[];
  /** Replaces the BEST summary. */
  trail?: { label: string; score: number };
  /** Replaces the comfort-worded aria label. */
  cellLabel?: (col: number, m: RowMonth | undefined) => string;
  /** Gutter styled as the selected row (as badge SELECTED does). */
  active?: boolean;
  /** Gutter highlighted from outside (as hovering the row does). */
  highlight?: boolean;
}

export function rowWindow(row: RenderRow): BestWindow | null {
  if (!Array.isArray(row.months) || row.bestWindow === false) return null;
  return bestWindow(row.months.map((m) => ({ score: m?.score ?? 0, tempC: 0, precipMm: 0 })));
}

export interface HeatRowProps {
  row: RenderRow;
  rowIndex: number;
  nowMonth: number;
  focusedCol: number | null;
  cellId: (rowIndex: number, col: number) => string;
  onHoverCell: (row: RenderRow, month: number, anchor: DOMRect | null) => void;
  /** `col` is passed for cell clicks only. */
  onSelect: (row: RenderRow, col?: number) => void;
  onGoto: (row: RenderRow) => void;
  onRemove: (row: RenderRow) => void;
  onFocusCell: (rowIndex: number, col: number) => void;
}

/** One destination row: gutter + 12 HeatCells + BEST summary (DESIGN §3.4). */
export default function HeatRow(props: HeatRowProps) {
  const {
    row,
    rowIndex,
    nowMonth,
    focusedCol,
    cellId,
    onHoverCell,
    onSelect,
    onGoto,
    onRemove,
    onFocusCell,
  } = props;
  const [hovered, setHovered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const window = rowWindow(row);
  const covered = Array.isArray(row.months);
  const uncovered = row.months === null;
  const cellState: CellState = covered
    ? "score"
    : row.months === "loading"
      ? "skeleton"
      : row.months === "unavailable"
        ? "unavailable"
        : "na";

  const peak =
    covered && window
      ? (row.months as RowMonth[])[window.peakMonth]!.score
      : undefined;
  const monthAt = (col: number) => (covered ? (row.months as (RowMonth | null)[])[col] ?? undefined : undefined);

  const leavingClass = leaving ? " hm-row-leaving" : "";
  const hoverClass = hovered || row.highlight ? " hm-row-hover" : "";

  const handleRemove = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => onRemove(row), 150);
  };

  return (
    <div
      style={{ display: "contents" }}
      role="row"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Left gutter */}
      <div
        role="rowheader"
        className={`hm-gutter${row.badge === "SELECTED" || row.active ? " active" : ""}${leavingClass}${hoverClass}`}
        onClick={row.kind === "city" ? () => onSelect(row) : undefined}
      >
        {row.kind === "region" ? (
          <>
            <div className="hg-main">
              <div className="hg-region-name">{row.label}</div>
            </div>
            <span className="sr-pill">REGION</span>
          </>
        ) : (
          <>
            <span className="hg-iata">{row.iata ?? "—"}</span>
            <div className="hg-main">
              <div className="hg-name">{row.label}</div>
              {row.country ? <div className="hg-country">{row.country}</div> : null}
            </div>
            <span className="sr-pill" title={row.badgeTitle}>
              {row.badge}
            </span>
            {uncovered && <span className="sr-pill dim">UNCOVERED</span>}
            {row.removable ? (
              <button
                className="hg-remove"
                title="Remove from shortlist"
                aria-label={`Remove ${row.label} from shortlist`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove();
                }}
              >
                ✕
              </button>
            ) : (
              <button
                className="hg-remove"
                title="View on globe"
                aria-label={`View ${row.label} on globe`}
                onClick={(e) => {
                  e.stopPropagation();
                  onGoto(row);
                }}
              >
                ↗
              </button>
            )}
          </>
        )}
      </div>

      {/* 12 month cells */}
      {Array.from({ length: 12 }, (_, month) => {
        const m = monthAt(month);
        const meta = row.cellMeta?.[month];
        const inWindow = covered && isMonthInWindow(window, month);
        return (
          <HeatCell
            key={month}
            cellId={cellId(rowIndex, month)}
            state={covered && !m ? "na" : cellState}
            score={m?.score}
            ariaLabel={cellAriaLabel(row, month, m, meta?.eventTitles)}
            isTemplate={meta?.template}
            eventCount={meta?.eventTitles?.length}
            naTitle={meta?.naTitle}
            muted={meta?.muted}
            isBest={inWindow}
            isBestStart={inWindow && window?.startMonth === month}
            isBestEnd={inWindow && window?.endMonth === month}
            isBestPeak={inWindow && window?.peakMonth === month}
            isNowCol={month === nowMonth}
            focused={focusedCol === month}
            leaving={leaving}
            onHover={(anchor) => onHoverCell(row, month, anchor)}
            onSelect={() => onSelect(row, month)}
            onGoto={() => onGoto(row)}
            onFocusCell={() => onFocusCell(rowIndex, month)}
          />
        );
      })}

      {/* Trailing BEST summary */}
      <div className={`hm-best${leavingClass}`}>
        {row.trail ? (
          <>
            <span className="hb-span">{row.trail.label}</span>
            <span className={`hb-peak peak-b${comfortBin(row.trail.score)}`}>{row.trail.score}</span>
          </>
        ) : covered && window && peak !== undefined ? (
          <>
            <span className="hb-span">{formatBestSpan(window)}</span>
            <span className={`hb-peak peak-b${comfortBin(peak)}`}>{peak}</span>
          </>
        ) : (
          <span className="hb-none">—</span>
        )}
      </div>
    </div>
  );
}

function cellAriaLabel(row: RenderRow, month: number, m?: RowMonth, eventTitles?: string[]): string {
  const base = row.cellLabel ? row.cellLabel(month, m) : comfortLabel(row, month, m);
  return eventTitles?.length ? `${base}, event: ${eventTitles.join(", ")}` : base;
}

function comfortLabel(row: RenderRow, month: number, m?: RowMonth): string {
  const monthName = MONTH_ABBR[month];
  if (!m) return `${row.label}, ${monthName}: no data`;
  const word = COMFORT_LABELS[comfortBin(m.score)].toLowerCase();
  const parts = [`${row.label}, ${monthName}: comfort ${m.score}, ${word}`];
  if (m.tempC !== undefined) parts.push(`${Math.round(m.tempC)} degrees`);
  if (m.precipMm !== undefined) parts.push(`${Math.round(m.precipMm)} millimetres`);
  return parts.join(", ");
}
