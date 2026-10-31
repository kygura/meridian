import type { ReactNode } from "react";
import { cx } from "./cx";

export interface EmptyStateProps {
  /** An icon element, e.g. <IconInbox />. */
  icon?: ReactNode;
  /** One line: "Nothing to review". */
  title: ReactNode;
  /** Optional second line in muted text. */
  description?: ReactNode;
  /** One action, usually a <Button>. */
  action?: ReactNode;
  /** "page" centers in the available height; "inline" is compact for lists and panels. */
  size?: "page" | "inline";
  className?: string;
}

export function EmptyState({ icon, title, description, action, size = "inline", className }: EmptyStateProps) {
  return (
    <div className={cx("ui-empty", `ui-empty--${size}`, className)}>
      {icon ? <div className="ui-empty-icon">{icon}</div> : null}
      <p className="ui-empty-title">{title}</p>
      {description ? <p className="ui-empty-desc">{description}</p> : null}
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  message?: ReactNode;
  onRetry?: () => void;
  className?: string;
}

/** One line plus Retry (DESIGN-v3.md §7). */
export function ErrorState({ message = "Something went wrong.", onRetry, className }: ErrorStateProps) {
  return (
    <div className={cx("ui-error", className)} role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={onRetry}>
          <span className="ui-btn-label">Retry</span>
        </button>
      ) : null}
    </div>
  );
}
