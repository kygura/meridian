import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Count or dot shown after the label. */
  badge?: ReactNode;
  /** When set, the tab renders as a link (route tabs). */
  href?: string;
}

export interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  value: T;
  onChange?: (value: T) => void;
  /** Accessible name, e.g. "Plan sections". */
  label: string;
  className?: string;
}

/**
 * Underline page tabs. With `href` on items they render as links (navigation, aria-current);
 * otherwise as an ARIA tablist with arrow-key movement.
 */
export function Tabs<T extends string>({ items, value, onChange, label, className }: TabsProps<T>) {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const asLinks = items.some((i) => i.href);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    if (!asLinks) onChange?.(items[next].value);
  };

  if (asLinks) {
    return (
      <nav className={cx("ui-tabs", className)} aria-label={label}>
        {items.map((item, i) => {
          const active = item.value === value;
          return (
            <a
              key={item.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              href={item.href}
              className={cx("ui-tab", active && "ui-tab--active")}
              aria-current={active ? "page" : undefined}
              onClick={() => onChange?.(item.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {item.label}
              {item.badge !== undefined && item.badge !== null && item.badge !== false ? (
                <span className="ui-tab-badge">{item.badge}</span>
              ) : null}
            </a>
          );
        })}
      </nav>
    );
  }

  return (
    <div className={cx("ui-tabs", className)} role="tablist" aria-label={label}>
      {items.map((item, i) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={cx("ui-tab", active && "ui-tab--active")}
            onClick={() => onChange?.(item.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {item.label}
            {item.badge !== undefined && item.badge !== null && item.badge !== false ? (
              <span className="ui-tab-badge">{item.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string = string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name, e.g. "Trip status". */
  label: string;
  size?: "sm" | "md";
  /** Stretch to fill the row. */
  block?: boolean;
  className?: string;
}

/** Pill switch for 2–4 mutually exclusive options (radiogroup). */
export function Segmented<T extends string>({ options, value, onChange, label, size = "md", block, className }: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    for (let step = 1; step <= options.length; step++) {
      const next = (index + dir * step + options.length) % options.length;
      if (!options[next].disabled) {
        refs.current[next]?.focus();
        onChange(options[next].value);
        return;
      }
    }
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx("ui-seg", `ui-seg--${size}`, block && "ui-seg--block", className)}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={o.disabled}
            className={cx("ui-seg-item", active && "ui-seg-item--active")}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
