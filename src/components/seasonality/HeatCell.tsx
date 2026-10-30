import { heatClass } from "../../lib/seasonality";

export type CellState = "score" | "na" | "skeleton" | "unavailable";

export interface HeatCellProps {
  cellId: string;
  state: CellState;
  score?: number;
  ariaLabel: string;
  isBest: boolean;
  isBestStart: boolean;
  isBestEnd: boolean;
  isBestPeak: boolean;
  isNowCol: boolean;
  focused: boolean;
  leaving: boolean;
  onHover: (anchor: DOMRect | null) => void;
  onSelect: () => void;
  onGoto: () => void;
  onFocusCell: () => void;
  /** Replay: the template's original month (outlined). */
  isTemplate?: boolean;
  /** Replay: renders the event marker when > 0. */
  eventCount?: number;
  /** Replay: overrides the "NOT IN DATASET" title of an na cell. */
  naTitle?: string;
  /** Replay: a climate-stage score only (not ranked); drawn hatched over the ramp. */
  muted?: boolean;
}

/** One month cell (DESIGN-heatmap.md §3.5). Paints itself via .heat-bN CSS vars. */
export default function HeatCell(props: HeatCellProps) {
  const {
    cellId,
    state,
    score,
    ariaLabel,
    isBest,
    isBestStart,
    isBestEnd,
    isBestPeak,
    isNowCol,
    focused,
    leaving,
    onHover,
    onSelect,
    onGoto,
    onFocusCell,
    isTemplate,
    eventCount,
    naTitle,
    muted,
  } = props;

  const interactive = state === "score";
  const classes = ["heat-cell"];
  if (state === "score" && score !== undefined) {
    classes.push(heatClass(score));
    if (isBest) classes.push("is-best");
    if (isBestStart) classes.push("best-start");
    if (isBestEnd) classes.push("best-end");
    if (isBestPeak) classes.push("best-peak");
  } else if (state === "skeleton") {
    classes.push("skeleton");
  } else {
    classes.push("heat-na");
  }
  if (isNowCol) classes.push("now-col");
  if (leaving) classes.push("hm-row-leaving");
  if (isTemplate) classes.push("jr-tpl");
  if (muted) classes.push("jr-unranked");

  const title =
    state === "na"
      ? naTitle ?? "NOT IN DATASET"
      : state === "unavailable"
        ? "SEASONALITY UNAVAILABLE"
        : undefined;

  return (
    <div
      id={cellId}
      role="gridcell"
      className={classes.join(" ")}
      tabIndex={focused ? 0 : -1}
      aria-label={ariaLabel}
      title={title}
      onFocus={onFocusCell}
      onMouseEnter={
        interactive
          ? (e) => onHover(e.currentTarget.getBoundingClientRect())
          : undefined
      }
      onMouseLeave={interactive ? () => onHover(null) : undefined}
      onClick={interactive ? onSelect : undefined}
      onDoubleClick={interactive ? onGoto : undefined}
    >
      {eventCount ? <span className="jr-ev" aria-hidden="true" /> : null}
      {state === "score" ? score : state === "skeleton" ? "" : "—"}
    </div>
  );
}
