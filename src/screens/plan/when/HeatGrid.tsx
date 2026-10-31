import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Popover, Skeleton, cx } from "../../../ui";
import { MONTH_NAMES, MONTH_SHORT, scoreStep } from "../../../lib/repeatCopy";
import "./heatgrid.css";

// Months heatmap shared by When to go and Repeat a trip. A table with a sticky first
// column; it scrolls sideways inside its own container on narrow screens. Cells are
// painted from the sequential ramp tokens. Columns are 0-based (0 = January).

export interface HeatCell {
  /** 0-100. */
  score: number;
  /** Drawn faded (e.g. a climate-only score that was not ranked). */
  muted?: boolean;
  /** Small dot: the row's peak month or the picked result. */
  dot?: boolean;
  /** Ring: the trip's own month. */
  ring?: boolean;
  /** Accessible name, e.g. "Lisbon, May: comfort 82, great". */
  label: string;
}

export interface HeatRow {
  key: string;
  label: string;
  sublabel?: string;
  /** Makes the row name a button (opens the city, picks the result). */
  onOpen?: () => void;
  openLabel?: string;
  state: "ready" | "loading" | "none" | "unavailable";
  /** Length 12 when ready. null = no score for that month. */
  cells?: (HeatCell | null)[];
  /** Last column (best months, match). */
  trail?: ReactNode;
  /** Extra control after the trail (remove button). */
  extra?: ReactNode;
  selected?: boolean;
}

export interface HeatGroup {
  key: string;
  title?: string;
  rows: HeatRow[];
}

export interface HeatGridProps {
  groups: HeatGroup[];
  /** Accessible name of the table. */
  label: string;
  firstHeader: string;
  trailHeader?: string;
  /** Header marks, e.g. the trip's month. */
  markedCols?: { col: number; label: string }[];
  /** Highlight the current month column header. Default true. */
  showNow?: boolean;
  /** Popover body for a cell; null for none. */
  renderPopover: (row: HeatRow, col: number) => ReactNode | null;
  onCellClick?: (row: HeatRow, col: number) => void;
  className?: string;
}

const NONE_TEXT: Record<Exclude<HeatRow["state"], "ready" | "loading">, string> = {
  none: "No climate data for this place yet",
  unavailable: "Unavailable right now",
};

type Tip = { rowKey: string; col: number; pinned: boolean };

export function HeatGrid({
  groups,
  label,
  firstHeader,
  trailHeader,
  markedCols,
  showNow = true,
  renderPopover,
  onCellClick,
  className,
}: HeatGridProps) {
  const nowCol = new Date().getMonth();
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const readyIdx = useMemo(() => rows.map((r, i) => (r.state === "ready" ? i : -1)).filter((i) => i >= 0), [rows]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const tableRef = useRef<HTMLTableElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: -1, col: nowCol });
  const [tip, setTip] = useState<Tip | null>(null);

  // Keep the roving focus on a ready row.
  const focusRow = readyIdx.includes(focus.row) ? focus.row : (readyIdx[0] ?? -1);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const cellEl = (row: number, col: number) =>
    tableRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${row}:${col}"]`) ?? null;

  const show = useCallback((rowKey: string, col: number, el: HTMLElement, pinned: boolean) => {
    window.clearTimeout(closeTimer.current);
    anchorRef.current = el;
    setTip({ rowKey, col, pinned });
  }, []);

  const hideSoon = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setTip((t) => (t && !t.pinned ? null : t)), 120);
  }, []);

  const move = (row: number, col: number) => {
    const c = Math.max(0, Math.min(11, col));
    setFocus({ row, col: c });
    const el = cellEl(row, c);
    el?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (focusRow < 0) return;
    const pos = readyIdx.indexOf(focusRow);
    const { col } = { col: focus.col };
    switch (e.key) {
      case "ArrowLeft":
        move(focusRow, col - 1);
        break;
      case "ArrowRight":
        move(focusRow, col + 1);
        break;
      case "ArrowUp":
        if (pos > 0) move(readyIdx[pos - 1]!, col);
        break;
      case "ArrowDown":
        if (pos < readyIdx.length - 1) move(readyIdx[pos + 1]!, col);
        break;
      case "Home":
        move(focusRow, 0);
        break;
      case "End":
        move(focusRow, 11);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const tipRow = tip ? rowByKey.get(tip.rowKey) : undefined;
  const tipBody = tip && tipRow ? renderPopover(tipRow, tip.col) : null;

  let flat = -1;
  return (
    <div className={cx("plan-heat", className)}>
      <div className="plan-heat-scroll">
        <table ref={tableRef} className="plan-heat-table" aria-label={label} onKeyDown={onKeyDown}>
          <thead>
            <tr>
              <th scope="col" className="plan-heat-corner">
                {firstHeader}
              </th>
              {MONTH_SHORT.map((m, col) => {
                const mark = markedCols?.find((x) => x.col === col);
                return (
                  <th
                    key={m}
                    scope="col"
                    className={cx("plan-heat-mh", showNow && col === nowCol && "is-now", mark && "is-marked")}
                    aria-label={`${MONTH_NAMES[col]}${mark ? `, ${mark.label}` : ""}${showNow && col === nowCol ? ", this month" : ""}`}
                    title={mark?.label}
                  >
                    <span className="plan-heat-mh-long" aria-hidden="true">
                      {m}
                    </span>
                    <span className="plan-heat-mh-short" aria-hidden="true">
                      {m[0]}
                    </span>
                  </th>
                );
              })}
              {trailHeader !== undefined && (
                <th scope="col" className="plan-heat-trail-h">
                  {trailHeader}
                </th>
              )}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key}>
              {g.title && g.rows.length > 0 && (
                <tr className="plan-heat-group">
                  <th scope="rowgroup" colSpan={1}>
                    {g.title}
                  </th>
                  <td colSpan={12 + (trailHeader !== undefined ? 1 : 0)} aria-hidden="true" />
                </tr>
              )}
              {g.rows.map((row) => {
                flat++;
                const rowIndex = flat;
                return (
                  <tr key={row.key} className={cx("plan-heat-row", row.selected && "is-selected")}>
                    <th scope="row" className="plan-heat-name">
                      {row.onOpen ? (
                        <button type="button" className="plan-heat-name-btn" onClick={row.onOpen} aria-label={row.openLabel}>
                          <span className="plan-heat-name-main">{row.label}</span>
                          {row.sublabel && <span className="plan-heat-name-sub">{row.sublabel}</span>}
                        </button>
                      ) : (
                        <span className="plan-heat-name-btn is-static">
                          <span className="plan-heat-name-main">{row.label}</span>
                          {row.sublabel && <span className="plan-heat-name-sub">{row.sublabel}</span>}
                        </span>
                      )}
                    </th>
                    {row.state === "ready" && row.cells ? (
                      row.cells.map((cell, col) => (
                        <td key={col} className="plan-heat-td">
                          {cell ? (
                            <button
                              type="button"
                              data-cell={`${rowIndex}:${col}`}
                              tabIndex={rowIndex === focusRow && col === focus.col ? 0 : -1}
                              className={cx(
                                "plan-heat-cell",
                                `plan-heat-s${scoreStep(cell.score)}`,
                                cell.muted && "is-muted",
                                cell.ring && "is-ring",
                                cell.dot && "is-dot",
                                tip?.rowKey === row.key && tip.col === col && "is-active"
                              )}
                              aria-label={cell.label}
                              aria-expanded={tip?.rowKey === row.key && tip.col === col && tip.pinned}
                              onPointerEnter={(e) => {
                                if (e.pointerType === "mouse") show(row.key, col, e.currentTarget, false);
                              }}
                              onPointerLeave={(e) => {
                                if (e.pointerType === "mouse") hideSoon();
                              }}
                              onFocus={(e) => {
                                setFocus({ row: rowIndex, col });
                                if (e.currentTarget.matches(":focus-visible")) show(row.key, col, e.currentTarget, false);
                              }}
                              onBlur={hideSoon}
                              onClick={(e) => {
                                const same = tip?.rowKey === row.key && tip.col === col && tip.pinned;
                                if (same) setTip(null);
                                else show(row.key, col, e.currentTarget, true);
                                onCellClick?.(row, col);
                              }}
                            />
                          ) : (
                            <span className="plan-heat-cell is-empty" role="img" aria-label={`${MONTH_NAMES[col]}: no score`} />
                          )}
                        </td>
                      ))
                    ) : (
                      <td colSpan={12} className="plan-heat-state">
                        {row.state === "loading" ? (
                          <Skeleton height={20} radius={6} />
                        ) : (
                          <span className="plan-heat-state-text">{NONE_TEXT[row.state as "none" | "unavailable"]}</span>
                        )}
                      </td>
                    )}
                    {trailHeader !== undefined && (
                      <td className="plan-heat-trail">
                        <span className="plan-heat-trail-in">
                          {row.trail}
                          {row.extra}
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>

      {tip && tipBody && (
        <Popover
          key={`${tip.rowKey}:${tip.col}`}
          open
          onClose={() => setTip(null)}
          anchorRef={anchorRef}
          placement="bottom-start"
          label={`${tipRow?.label ?? ""}, ${MONTH_NAMES[tip.col]}`}
          role="group"
          autoFocus={false}
          className="plan-heat-pop"
        >
          {tipBody}
        </Popover>
      )}
    </div>
  );
}

/** Ramp key: "Low [7 swatches] High". */
export function HeatLegend({ low, high, extra }: { low: string; high: string; extra?: ReactNode }) {
  return (
    <div className="plan-heat-legend" aria-hidden="true">
      <span>{low}</span>
      <span className="plan-heat-legend-ramp">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} className={`plan-heat-legend-sw plan-heat-s${i}`} />
        ))}
      </span>
      <span>{high}</span>
      {extra}
    </div>
  );
}

/** Label/value line inside a cell popover. */
export function PopRow({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="plan-heat-pop-row">
      <span className="plan-heat-pop-k">{k}</span>
      <span className="plan-heat-pop-v">{v}</span>
    </div>
  );
}
