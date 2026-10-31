import { useId, type CSSProperties, type ReactNode } from "react";
import { cx } from "../../../ui";

export interface BendSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Visible value, e.g. "3°C warmer". Also the spoken value. */
  readout: string;
  disabled?: boolean;
  /** Fill from the centre (bends) or from the left (priorities). Default centre. */
  centered?: boolean;
  /** Muted line under the slider. */
  hint?: ReactNode;
  onChange: (v: number) => void;
}

/** Native range input with a readout and a fill from the centre (ported from the old replay controls). */
export function BendSlider({ label, value, min, max, step, readout, disabled, centered = true, hint, onChange }: BendSliderProps) {
  const id = useId();
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const from = centered ? pct(0) : 0;
  const to = pct(value);
  const style = { "--plan-repeat-a": `${Math.min(from, to)}%`, "--plan-repeat-b": `${Math.max(from, to)}%` } as CSSProperties;
  return (
    <div className={cx("plan-repeat-slider", disabled && "is-disabled")}>
      <div className="plan-repeat-slider-top">
        <label htmlFor={id}>{label}</label>
        <span className="plan-repeat-slider-val tabular" aria-hidden="true">
          {readout}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={style}
        aria-valuetext={readout}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="plan-repeat-slider-hint">{hint}</p>}
    </div>
  );
}
