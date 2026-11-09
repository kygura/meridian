import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { Spinner } from "./Spinner";

/** "danger" is filled and belongs in confirm dialogs; "danger-outline" opens one. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-outline";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon element before the label, e.g. <IconPlus />. */
  icon?: ReactNode;
  /** Icon element after the label. */
  iconRight?: ReactNode;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Full width. */
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** One filled (primary) button per screen. Default variant is secondary. */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  loading,
  block,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("ui-btn", `ui-btn--${variant}`, `ui-btn--${size}`, block && "ui-btn--block", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon}
      {children !== undefined && children !== null && <span className="ui-btn-label">{children}</span>}
      {iconRight}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name (required): "Close", "Delete stop". Also the tooltip. */
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "secondary" | "primary" | "danger" | "danger-outline";
  size?: ButtonSize;
  /** Small dot or count shown on the corner. */
  badge?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** Square icon-only button. Touch target is 44px on phones. */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  badge,
  className,
  type = "button",
  title,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cx("ui-iconbtn", `ui-btn--${variant}`, `ui-iconbtn--${size}`, className)}
      {...rest}
    >
      {icon}
      {badge !== undefined && badge !== null && badge !== false && <span className="ui-iconbtn-badge">{badge}</span>}
    </button>
  );
}

export interface FabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
}

/** Floating primary action ("Log a trip" on the Map only; content pages use the header action). Sits bottom-right. */
export function Fab({ icon, children, className, type = "button", ...rest }: FabProps) {
  return (
    <button type={type} className={cx("ui-fab", className)} {...rest}>
      {icon}
      <span>{children}</span>
    </button>
  );
}
