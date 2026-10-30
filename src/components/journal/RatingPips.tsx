import type { Rating } from "../../types";
import { ratingText } from "../../lib/journal";
import { radioKeys } from "./radioKeys";

/** ●●●●○ read-only, or an interactive radiogroup when `onChange` is given (arrow keys). */
export default function RatingPips({
  value,
  onChange,
  label = "Rating",
}: {
  value?: number;
  onChange?: (r: Rating | undefined) => void;
  label?: string;
}) {
  if (!onChange) {
    if (!value) return null;
    return (
      <span className="jr-pips" role="img" aria-label={`${label}: ${ratingText(value)}`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={n <= value ? "on" : ""} aria-hidden="true">
            {n <= value ? "●" : "○"}
          </span>
        ))}
      </span>
    );
  }
  const set = (n: number) => onChange(n < 1 ? undefined : n > 5 ? 5 : (n as Rating));
  return (
    <span className="jr-pips jr-pips-edit" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} of 5`}
          tabIndex={value === n || (!value && n === 1) ? 0 : -1}
          className={n <= (value ?? 0) ? "on" : ""}
          onClick={() => set(value === n ? 0 : n)}
          onKeyDown={radioKeys}
        >
          {n <= (value ?? 0) ? "●" : "○"}
        </button>
      ))}
    </span>
  );
}
