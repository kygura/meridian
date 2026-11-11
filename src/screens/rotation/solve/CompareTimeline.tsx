import { cx } from "../../../ui";
import { timelineMonths, timelineX, FIT_LABEL, formatShortDate } from "../../../lib/rotation";
import { stayLevel } from "../../../lib/solver/view";
import type { ProposedRotation } from "../../../lib/solver/types";

const M = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

export interface CompareTimelineProps {
  from: string;
  to: string;
  proposals: ProposedRotation[];
  selected: number;
  onSelect: (i: number) => void;
}

/** Every proposal on one month axis, one row each, stays coloured by fit. */
export function CompareTimeline({ from, to, proposals, selected, onSelect }: CompareTimelineProps) {
  const months = timelineMonths(from, to);
  return (
    <div className="solve-cmp" role="group" aria-label="Proposals side by side">
      <div className="solve-cmp-row solve-cmp-row--axis" aria-hidden="true">
        <div className="solve-cmp-label" />
        <div className="solve-cmp-track">
          {months.map((m) => {
            const mm = Number(m.ym.slice(5, 7));
            return (
              <div key={m.ym} className={cx("solve-cmp-month", mm === 1 && "solve-cmp-month--year")} style={{ left: pct(m.left), width: pct(m.width) }}>
                {M[mm - 1]}
                {(mm === 1 || m.ym === months[0].ym) && <span className="solve-cmp-year">’{m.ym.slice(2, 4)}</span>}
              </div>
            );
          })}
        </div>
      </div>
      {proposals.map((p, i) => (
        <div key={p.id} className={cx("solve-cmp-row", i === selected && "solve-cmp-row--on")}>
          <button type="button" className="solve-cmp-label" onClick={() => onSelect(i)} aria-pressed={i === selected}>
            <span>Option {i + 1}</span>
            <span className="num">{p.total.toFixed(1)}</span>
          </button>
          <div className="solve-cmp-track">
            {p.stays.map((s) => {
              const left = timelineX(s.start, from, to);
              const right = timelineX(s.end, from, to);
              const level = stayLevel(s);
              const label = `${s.name}, ${formatShortDate(s.start)} to ${formatShortDate(s.end)}, ${FIT_LABEL[level]}${s.role !== "base" ? `, ${s.role}` : ""}`;
              return (
                <button
                  type="button"
                  key={s.id}
                  className={cx("solve-cmp-bar", `rotation-fit--${level}`, s.role === "fixed" && "solve-cmp-bar--fixed", s.role !== "base" && s.role !== "fixed" && "solve-cmp-bar--short")}
                  style={{ left: pct(left), width: pct(Math.max(0.004, right - left)) }}
                  title={label}
                  aria-label={label}
                  onClick={() => onSelect(i)}
                >
                  {right - left > 0.07 && <span className="solve-cmp-name">{s.name}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
