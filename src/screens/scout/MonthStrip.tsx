import { cx } from "../../ui";
import { monthShort, stripCells } from "../../lib/atlasFormat";
import type { WishlistPlace } from "../../lib/atlasApi";

/**
 * Comfort Index for January to December, coloured with the same ramp as When to go.
 * A green bar marks the best months, hatching marks months to avoid, a dot marks months
 * the routine has researched. Details sit in each cell's title.
 */
export function MonthStrip({ place, nowMonth }: { place: Pick<WishlistPlace, "name" | "avoidMonths" | "season">; nowMonth: number }) {
  const cells = stripCells(place);
  return (
    <div className="scout-strip-scroll">
      <ol className="scout-strip" aria-label={`Comfort Index by month for ${place.name}`}>
        {cells.map((c) => (
          <li
            key={c.month}
            className={cx(
              "scout-cell",
              c.step != null && `scout-cell--s${c.step}`,
              c.step == null && "scout-cell--none",
              c.best && "is-best",
              c.avoided && "is-avoided",
              c.signal && "has-signal",
              c.month === nowMonth && "is-now"
            )}
            title={c.title}
          >
            <span className="scout-cell-m" aria-hidden="true">
              {monthShort(c.month)}
            </span>
            <span className="scout-cell-v num" aria-hidden="true">
              {c.comfort ?? "·"}
            </span>
            <span className="sr-only">{c.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Key for the strip: ramp, best month bar, avoided hatch, researched dot. */
export function StripLegend() {
  return (
    <p className="scout-legend" aria-hidden="true">
      <span>Comfort</span>
      <span className="scout-legend-ramp">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span key={i} className={`scout-cell--s${i}`} />
        ))}
      </span>
      <span className="scout-legend-item">
        <i className="scout-legend-best" /> Best month
      </span>
      <span className="scout-legend-item">
        <i className="scout-legend-avoid" /> Avoid
      </span>
      <span className="scout-legend-item">
        <i className="scout-legend-dot" /> Researched
      </span>
    </p>
  );
}
