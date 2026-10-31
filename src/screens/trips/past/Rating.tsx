import type { KeyboardEvent } from "react";
import type { Rating as RatingValue } from "../../../types";
import { IconStar } from "../../../ui/icons";

/** Read-only stars. Renders nothing when unrated. */
export function Stars({ value, label = "Rating" }: { value?: number; label?: string }) {
  if (!value) return null;
  return (
    <span className="trips-stars" role="img" aria-label={`${label}: ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? "is-on" : undefined} aria-hidden="true">
          <IconStar size={14} />
        </span>
      ))}
    </span>
  );
}

/** Five-star radiogroup. Picking the current value again clears it. Arrow keys move. */
export function RatingInput({
  value,
  onChange,
  label,
  id,
}: {
  value?: RatingValue;
  onChange: (r: RatingValue | undefined) => void;
  label: string;
  id?: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const cur = value ?? 0;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(5, cur + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(1, cur - 1);
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = 5;
    if (next === null) return;
    e.preventDefault();
    onChange(next as RatingValue);
    const group = e.currentTarget.parentElement;
    requestAnimationFrame(() => group?.querySelectorAll<HTMLButtonElement>("button")[next! - 1]?.focus());
  };
  return (
    <span className="trips-rating-input" role="radiogroup" aria-label={label} id={id}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} of 5`}
          tabIndex={value === n || (!value && n === 1) ? 0 : -1}
          className={n <= (value ?? 0) ? "is-on" : undefined}
          onClick={() => onChange(value === n ? undefined : (n as RatingValue))}
          onKeyDown={onKeyDown}
        >
          <IconStar size={20} />
        </button>
      ))}
    </span>
  );
}
