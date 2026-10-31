import { cx } from "./cx";

export function Spinner({ size = 20, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <span
      className={cx("ui-spinner", className)}
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  /** Render n stacked text lines instead of one block. */
  lines?: number;
  className?: string;
}

export function Skeleton({ width, height = 14, radius, lines, className }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <span className={cx("ui-skeleton-lines", className)} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span
            key={i}
            className="ui-skeleton"
            style={{ height, width: i === lines - 1 ? "60%" : width ?? "100%", borderRadius: radius }}
          />
        ))}
      </span>
    );
  }
  return (
    <span
      className={cx("ui-skeleton", className)}
      aria-hidden="true"
      style={{ width: width ?? "100%", height, borderRadius: radius }}
    />
  );
}
