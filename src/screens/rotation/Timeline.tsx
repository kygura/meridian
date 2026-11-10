import { cx } from "../../ui";
import {
  FIT_LABEL,
  effectiveStatus,
  formatShortDate,
  staySpan,
  timelineMonths,
  timelineX,
  type Deadline,
  type RotationIssue,
  type RotationStay,
  type StayFit,
} from "../../lib/rotation";
import { STATUS_LABEL, KIND_LABEL, stayDatesText } from "./format";

const M = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const MS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface TimelineProps {
  from: string;
  to: string;
  today: string;
  stays: RotationStay[];
  fits: Map<string, StayFit>;
  deadlines: Map<string, Deadline>;
  issues: RotationIssue[];
  onOpen: (id: string) => void;
}

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

/**
 * The rotation as a Gantt over the horizon: one row per stay, the bar coloured by fit
 * (the owner's window first, else the Comfort Index), a diamond at the book-by date, a
 * line for today, and gaps and overlaps marked on the month axis.
 */
export function Timeline({ from, to, today, stays, fits, deadlines, issues, onOpen }: TimelineProps) {
  const months = timelineMonths(from, to);
  const todayX = today >= from && today < to ? timelineX(today, from, to) : null;
  const marks = issues.filter((i) => (i.kind === "gap" || i.kind === "overlap") && i.from && i.to && i.to > from && i.from < to);

  return (
    <div className="rotation-tl" role="group" aria-label="Rotation timeline">
      <div className="rotation-tl-scroll">
        <div className="rotation-tl-grid">
          <div className="rotation-tl-row rotation-tl-row--axis" aria-hidden="true">
            <div className="rotation-tl-label" />
            <div className="rotation-tl-track">
              {months.map((m) => {
                const mm = Number(m.ym.slice(5, 7));
                return (
                  <div key={m.ym} className={cx("rotation-tl-month", mm === 1 && "rotation-tl-month--year")} style={{ left: pct(m.left), width: pct(m.width) }}>
                    <span className="rotation-tl-month-long">{MS[mm - 1]}</span>
                    <span className="rotation-tl-month-short">{M[mm - 1]}</span>
                    {(mm === 1 || m.ym === months[0].ym) && <span className="rotation-tl-year">{m.ym.slice(0, 4)}</span>}
                  </div>
                );
              })}
              {marks.map((i, k) => (
                <div
                  key={k}
                  className={cx("rotation-tl-issue", `rotation-tl-issue--${i.kind}`, i.tentative && "rotation-tl-issue--tentative")}
                  style={{ left: pct(timelineX(i.from!, from, to)), width: pct(Math.max(0.004, timelineX(i.to!, from, to) - timelineX(i.from!, from, to))) }}
                  title={i.message}
                />
              ))}
            </div>
          </div>

          {stays.map((s) => {
            const span = staySpan(s);
            const fit = fits.get(s.id);
            const dl = deadlines.get(s.id);
            const status = effectiveStatus(s, today);
            const inRange = span && span.end > from && span.start < to;
            const left = span ? timelineX(span.start, from, to) : 0;
            const right = span ? timelineX(span.end, from, to) : 0;
            const label = `${s.place.name}, ${KIND_LABEL[s.kind].toLowerCase()}, ${STATUS_LABEL[status].toLowerCase()}, ${stayDatesText(s)}. ${fit ? FIT_LABEL[fit.level] : ""}${dl ? `. Book by ${formatShortDate(dl.bookBy)}` : ""}`;
            return (
              <div key={s.id} className={cx("rotation-tl-row", s.status === "idea" && "rotation-tl-row--idea")}>
                <button type="button" className="rotation-tl-label" onClick={() => onOpen(s.id)}>
                  <span className="rotation-tl-name">
                    {s.locked && <span className="rotation-lock" aria-label="Locked" title="Locked">●</span>}
                    {s.place.name}
                  </span>
                  <span className="rotation-tl-sub num">{stayDatesText(s, true)}</span>
                </button>
                <div className="rotation-tl-track">
                  {months.map((m) => (
                    <div key={m.ym} className="rotation-tl-cell" style={{ left: pct(m.left), width: pct(m.width) }} />
                  ))}
                  {inRange ? (
                    <button
                      type="button"
                      className={cx(
                        "rotation-tl-bar",
                        `rotation-fit--${fit?.level ?? "unknown"}`,
                        span!.approx && "rotation-tl-bar--approx",
                        s.kind === "pass-through" && "rotation-tl-bar--pass",
                        status === "current" && "rotation-tl-bar--current"
                      )}
                      style={{ left: pct(left), width: pct(Math.max(0.006, right - left)) }}
                      onClick={() => onOpen(s.id)}
                      aria-label={label}
                      title={label}
                    />
                  ) : (
                    <span className="rotation-tl-off">{span ? "Outside this view" : "No dates or months yet"}</span>
                  )}
                  {dl && dl.bookBy >= from && dl.bookBy < to && (
                    <span
                      className={cx("rotation-tl-bookby", dl.daysLeft < 0 && "rotation-tl-bookby--late")}
                      style={{ left: pct(timelineX(dl.bookBy, from, to)) }}
                      title={`Book by ${formatShortDate(dl.bookBy)}`}
                      aria-hidden="true"
                    />
                  )}
                  {todayX !== null && <span className="rotation-tl-today" style={{ left: pct(todayX) }} aria-hidden="true" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <ul className="rotation-tl-legend" aria-label="Legend">
        {(["great", "good", "fair", "poor", "avoid", "unknown"] as const).map((l) => (
          <li key={l}>
            <span className={cx("rotation-swatch", `rotation-fit--${l}`)} aria-hidden="true" />
            {FIT_LABEL[l]}
          </li>
        ))}
        <li>
          <span className="rotation-swatch rotation-swatch--bookby" aria-hidden="true" />
          Book by
        </li>
        <li>
          <span className="rotation-swatch rotation-swatch--approx" aria-hidden="true" />
          Month window, no dates yet
        </li>
      </ul>
    </div>
  );
}
