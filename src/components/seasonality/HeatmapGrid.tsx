import { useEffect, useRef, useState, type ReactNode } from "react";
import HeatRow, { rowWindow, type RenderRow } from "./HeatRow";
import HeatTooltip, { type HeatTooltipData } from "./HeatTooltip";
import { MONTH_INITIALS, MONTH_ABBR } from "../../lib/seasonality";

export interface HeatmapGridProps {
  regionRows: RenderRow[];
  cityRows: RenderRow[];
  /** Group eyebrow for the region block ("REGIONS" or "REGIONS · SAMPLE"). */
  regionsLabel: string;
  /** City pinned first (SELECTED) — its peak cell receives initial focus (flow F). */
  autoFocusCityId: string | null;
  /** `col` is passed for cell clicks only. */
  onSelect: (row: RenderRow, col?: number) => void;
  onGoto: (row: RenderRow) => void;
  onRemove: (row: RenderRow) => void;
  // Optional extras (replay). Defaults keep SEASONS unchanged.
  ariaLabel?: string;
  gutterHeader?: string;
  trailHeader?: string;
  /** Header marks: the template's month (underlined) and its bent target (▸). */
  markedCols?: { col: number; kind: "template" | "target" }[];
  /** Replaces the default tooltip; return null for none. */
  renderTooltip?: (row: RenderRow, col: number, anchor: DOMRect) => ReactNode | null;
  /** Live-region text for the focused cell. */
  describeCell?: (row: RenderRow, col: number) => string;
}

/**
 * The role="grid" heatmap (DESIGN §3.3): sticky month header, now-column,
 * group rules, roving-tabindex 2D keyboard navigation (§4.3).
 */
export default function HeatmapGrid(props: HeatmapGridProps) {
  const {
    regionRows,
    cityRows,
    regionsLabel,
    autoFocusCityId,
    onSelect,
    onGoto,
    onRemove,
    ariaLabel = "Seasonality heatmap calendar",
    gutterHeader = "CITY",
    trailHeader = "BEST",
    markedCols,
    renderTooltip,
    describeCell,
  } = props;
  const nowMonth = new Date().getMonth();
  const gridId = useRef(`hmgrid-${Math.random().toString(36).slice(2, 8)}`);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoFocusedRef = useRef(false);

  // Display order: region rows first, then destinations.
  const allRows: RenderRow[] = [...regionRows, ...cityRows];

  const [focused, setFocused] = useState<{ row: number; col: number }>({
    row: 0,
    col: 0,
  });
  const [liveMessage, setLiveMessage] = useState("");
  const [tooltip, setTooltip] = useState<{
    anchor: DOMRect;
    row: RenderRow;
    col: number;
  } | null>(null);

  const cellId = (rowIndex: number, col: number) =>
    `${gridId.current}-${rowIndex}-${col}`;

  // Clamp focus when rows change (removals, sorts).
  const rowCount = allRows.length;
  useEffect(() => {
    setFocused((f) => ({
      row: Math.min(f.row, Math.max(0, rowCount - 1)),
      col: f.col,
    }));
  }, [rowCount]);

  // Flow F: focus the pinned city's peak-month cell once its data arrives.
  useEffect(() => {
    if (!autoFocusCityId || autoFocusedRef.current) return;
    const idx = allRows.findIndex((r) => r.cityId === autoFocusCityId);
    if (idx < 0) return;
    const window = rowWindow(allRows[idx]!);
    if (!window) return;
    autoFocusedRef.current = true;
    setFocused({ row: idx, col: window.peakMonth });
    const el = document.getElementById(cellId(idx, window.peakMonth));
    el?.scrollIntoView({ block: "center" });
    el?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocusCityId, allRows]);

  const moveFocus = (row: number, col: number) => {
    const r = Math.min(Math.max(row, 0), rowCount - 1);
    const c = Math.min(Math.max(col, 0), 11);
    setFocused({ row: r, col: c });
    document.getElementById(cellId(r, c))?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const { row, col } = focused;
    const current = allRows[row];
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(row, col - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(row, col + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(row - 1, col);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(row + 1, col);
        break;
      case "Home":
        e.preventDefault();
        moveFocus(row, 0);
        break;
      case "End":
        e.preventDefault();
        moveFocus(row, 11);
        break;
      case "PageUp":
        e.preventDefault();
        moveFocus(0, col);
        break;
      case "PageDown":
        e.preventDefault();
        moveFocus(rowCount - 1, col);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (current && current.kind === "city") onSelect(current, col);
        break;
      case "g":
      case "G":
        // No-op for region rows — a region isn't a point on the globe.
        if (current && current.kind === "city") {
          e.preventDefault();
          onGoto(current);
        }
        break;
    }
  };

  const handleFocusCell = (rowIndex: number, col: number) => {
    setFocused({ row: rowIndex, col });
    const row = allRows[rowIndex];
    if (row && describeCell) {
      setLiveMessage(describeCell(row, col));
    } else if (row && Array.isArray(row.months)) {
      const m = row.months[col];
      if (m) {
        const temp =
          m.tempC !== undefined ? `, ${Math.round(m.tempC)} degrees` : "";
        const rain =
          m.precipMm !== undefined
            ? `, ${Math.round(m.precipMm)} millimetres`
            : "";
        setLiveMessage(
          `${row.label}, ${MONTH_ABBR[col]}: comfort ${m.score}${temp}${rain}`
        );
      }
    }
  };

  const handleHoverCell = (row: RenderRow, month: number, anchor: DOMRect | null) => {
    if (!anchor || !Array.isArray(row.months)) {
      setTooltip(null);
      return;
    }
    if (!row.months[month]) return;
    setTooltip({ anchor, row, col: month });
  };

  const defaultTooltip = (row: RenderRow, month: number, anchor: DOMRect) => {
    const m = Array.isArray(row.months) ? row.months[month] : null;
    if (!m) return null;
    const title =
      row.kind === "region"
        ? `REGION · ${row.label.toUpperCase()}`
        : `${row.label.toUpperCase()} · ${MONTH_ABBR[month]}`;
    const data: HeatTooltipData = {
      title,
      score: m.score,
      tempC: m.tempC,
      precipMm: m.precipMm,
      showHint: row.kind === "city",
    };
    return <HeatTooltip anchor={anchor} data={data} />;
  };

  const renderRow = (row: RenderRow, rowIndex: number) => (
    <HeatRow
      key={row.key}
      row={row}
      rowIndex={rowIndex}
      nowMonth={nowMonth}
      focusedCol={focused.row === rowIndex ? focused.col : null}
      cellId={cellId}
      onHoverCell={handleHoverCell}
      onSelect={onSelect}
      onGoto={onGoto}
      onRemove={onRemove}
      onFocusCell={handleFocusCell}
    />
  );

  return (
    <div className="hm-scroll" ref={scrollRef}>
      <div
        className="heatmap-grid"
        role="grid"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Sticky month-header row */}
        <div role="row" style={{ display: "contents" }}>
          <div className="hm-mh gutter" role="columnheader">
            {gutterHeader}
          </div>
          {MONTH_INITIALS.map((initial, i) => {
            const mark = markedCols?.find((c) => c.col === i)?.kind;
            return (
              <div
                key={i}
                className={`hm-mh${i === nowMonth ? " now" : ""}${mark ? ` jr-mh-${mark}` : ""}`}
                role="columnheader"
                aria-label={mark ? `${MONTH_ABBR[i]} (${mark} month)` : MONTH_ABBR[i]}
              >
                {mark === "target" && <span className="jr-mh-arrow" aria-hidden="true">▸</span>}
                {initial}
              </div>
            );
          })}
          <div className="hm-mh trail" role="columnheader">
            {trailHeader}
          </div>
        </div>

        {regionRows.length > 0 && (
          <>
            <div className="hm-group">{regionsLabel}</div>
            {regionRows.map((row, i) => renderRow(row, i))}
          </>
        )}

        {cityRows.length > 0 && (
          <>
            {regionRows.length > 0 && <div className="hm-group">DESTINATIONS</div>}
            {cityRows.map((row, i) => renderRow(row, regionRows.length + i))}
          </>
        )}
      </div>

      {/* Screen-reader announcement of the focused cell (§4.3) */}
      <div
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
        }}
      >
        {liveMessage}
      </div>

      {tooltip &&
        (renderTooltip ?? defaultTooltip)(tooltip.row, tooltip.col, tooltip.anchor)}
    </div>
  );
}
