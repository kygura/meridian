import { useId } from "react";

/** Native range input with a signed readout, a center detent and a fill from center (DESIGN-journal §7.2). */
export default function BendSlider({
  label,
  value,
  min,
  max,
  step,
  readout,
  spoken,
  disabled,
  centered = true,
  resetTo = 0,
  extra,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  readout: string;
  /** aria-valuetext, e.g. "3 degrees warmer". */
  spoken: string;
  disabled?: boolean;
  /** false = fill from the left edge (weights). */
  centered?: boolean;
  /** Double-click target. */
  resetTo?: number;
  /** Rendered between the label and the readout (e.g. a toggle). */
  extra?: React.ReactNode;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const from = centered ? pct(0) : 0;
  const to = pct(value);
  const style = { "--jr-a": `${Math.min(from, to)}%`, "--jr-b": `${Math.max(from, to)}%` } as React.CSSProperties;
  return (
    <div className={`jr-bend${disabled ? " off" : ""}`}>
      <div className="jr-bend-top">
        <label className="jr-bend-label" htmlFor={id}>
          {label}
        </label>
        {extra}
        <span className="jr-bend-val" aria-hidden="true">
          {readout}
        </span>
      </div>
      <div className="jr-bend-track">
        {centered && <span className="jr-bend-tick" aria-hidden="true" />}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          style={style}
          aria-valuetext={spoken}
          title="Double-click to reset"
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => !disabled && onChange(resetTo)}
        />
      </div>
    </div>
  );
}
