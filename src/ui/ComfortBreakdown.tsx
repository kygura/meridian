import { breakdownRows, comfortBreakdown, weeklyComfortBreakdown, type YearClimate } from "../lib/comfort";
import { cx } from "./cx";
import "./comfortBreakdown.css";

export interface ComfortBreakdownProps {
  tempC: number;
  /** Rain: mm per month, or mm per 7 days when `per` is "week". */
  precipMm: number;
  /** Monthly (or weekly) mean PM2.5 in ug/m3; omit when the place has no air-quality data yet. */
  pm25?: number | null;
  /** Mean hours of sunshine a day; omit when the place has none yet (no Sky row, nothing taken off). */
  sunH?: number | null;
  per?: "month" | "week";
  /** The place's yearly rain (mm); adds the desert term when given. Prefer `year`. */
  annualPrecipMm?: number;
  /** The place's year (rain, warmest and coldest months): the desert term, scaled for mild ocean climates (ADR 0025). */
  year?: YearClimate;
  className?: string;
}

/**
 * How the Comfort Index is made up: temperature comfort, minus the rain penalty, minus the
 * air-quality penalty, minus the sky penalty for dull months, minus the desert penalty for very dry places. Used wherever the index is explained (city panel, When to go, Repeat a trip).
 */
export function ComfortBreakdown({ tempC, precipMm, pm25, sunH, per = "month", annualPrecipMm, year, className }: ComfortBreakdownProps) {
  const b =
    per === "week"
      ? weeklyComfortBreakdown(tempC, precipMm, pm25, year ?? annualPrecipMm, sunH)
      : comfortBreakdown(tempC, precipMm, pm25, year ?? annualPrecipMm, sunH);
  const rows = breakdownRows(b, tempC, precipMm, pm25, per === "week" ? "mm a week" : "mm a month", sunH);
  return (
    <dl className={cx("ui-comfort-bd", className)} aria-label="How the Comfort Index is made up">
      {rows.map((r) => (
        <div key={r.key} className={cx("ui-comfort-bd-row", r.key === "air" && !b.airKnown && "is-unknown")}>
          <dt>{r.label}</dt>
          <dd className="ui-comfort-bd-pts num">{r.text}</dd>
          <dd className="ui-comfort-bd-note">{r.note}</dd>
        </div>
      ))}
      <div className="ui-comfort-bd-row is-total">
        <dt>Comfort Index</dt>
        <dd className="ui-comfort-bd-pts num">{b.score}</dd>
        <dd className="ui-comfort-bd-note">out of 100</dd>
      </div>
    </dl>
  );
}
