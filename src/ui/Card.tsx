import type { HTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Hover/press styling for clickable cards. Put the click target (a link or button) inside. */
  interactive?: boolean;
  padding?: "none" | "sm" | "md";
  ref?: Ref<HTMLDivElement>;
}

export function Card({ interactive, padding = "md", className, ...rest }: CardProps) {
  return <div className={cx("ui-card", `ui-card--pad-${padding}`, interactive && "ui-card--interactive", className)} {...rest} />;
}

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}

/** Label over a big tabular number. */
export function Stat({ label, value, hint, className }: StatProps) {
  return (
    <div className={cx("ui-stat", className)}>
      <div className="ui-stat-label">{label}</div>
      <div className="ui-stat-value">{value}</div>
      {hint ? <div className="ui-stat-hint">{hint}</div> : null}
    </div>
  );
}

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** "solid" for counts in the nav; "soft" (default) for status labels. */
  appearance?: "soft" | "solid";
}

/** Status label ("Draft", "Confirmed", "Mock") or a count. */
export function Badge({ tone = "neutral", appearance = "soft", className, ...rest }: BadgeProps) {
  return <span className={cx("ui-badge", `ui-badge--${tone}`, `ui-badge--${appearance}`, className)} {...rest} />;
}

export interface ChipProps extends Omit<HTMLAttributes<HTMLButtonElement>, "onClick"> {
  /** Toggle state; rendered as aria-pressed when onClick is set. */
  selected?: boolean;
  onClick?: () => void;
  /** Shows a remove (x) affordance and calls this. */
  onRemove?: () => void;
  icon?: ReactNode;
  disabled?: boolean;
}

/** Filter or tag chip. Clickable when onClick is set, otherwise static. */
export function Chip({ selected, onClick, onRemove, icon, children, className, disabled, ...rest }: ChipProps) {
  const cls = cx("ui-chip", selected && "ui-chip--selected", (onClick || onRemove) && "ui-chip--interactive", className);
  if (onRemove && !onClick) {
    return (
      <span className={cls}>
        {icon}
        <span>{children}</span>
        <button type="button" className="ui-chip-remove" aria-label={`Remove ${typeof children === "string" ? children : ""}`.trim()} onClick={onRemove} disabled={disabled}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
        </button>
      </span>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls} aria-pressed={selected} onClick={onClick} disabled={disabled} {...rest}>
        {icon}
        <span>{children}</span>
      </button>
    );
  }
  return (
    <span className={cls} {...(rest as HTMLAttributes<HTMLSpanElement>)}>
      {icon}
      <span>{children}</span>
    </span>
  );
}
