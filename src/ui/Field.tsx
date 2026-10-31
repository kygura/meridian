import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "./cx";
import { IconChevronDown } from "./icons";

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Error text; also sets aria-invalid on the control. */
  error?: ReactNode;
  /** Visually hide the label (still read by screen readers). */
  hideLabel?: boolean;
  /** Marks the label with "(optional)". */
  optional?: boolean;
  /** The single control: <Input>, <Textarea>, <Select>, or CitySearch. Gets id + aria wiring. */
  children: ReactElement;
  className?: string;
}

/** Label, control, hint and error with ids wired up. */
export function Field({ label, hint, error, hideLabel, optional, children, className }: FieldProps) {
  const auto = useId();
  const child = Children.only(children);
  const childProps = (isValidElement(child) ? (child.props as Record<string, unknown>) : {}) as {
    id?: string;
    "aria-describedby"?: string;
  };
  const id = childProps.id ?? `f${auto}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [childProps["aria-describedby"], hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("ui-field", error ? "ui-field--error" : undefined, className)}>
      <label htmlFor={id} className={cx("ui-field-label", hideLabel && "sr-only")}>
        {label}
        {optional ? <span className="ui-field-optional"> (optional)</span> : null}
      </label>
      {cloneElement(child as ReactElement<Record<string, unknown>>, {
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="ui-field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="ui-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md";
  /** Icon inside the left edge (e.g. <IconSearch />). */
  icon?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ size = "md", icon, className, ...rest }: InputProps) {
  if (icon) {
    return (
      <span className={cx("ui-input-wrap", className)}>
        <span className="ui-input-icon" aria-hidden="true">
          {icon}
        </span>
        <input className={cx("ui-input", `ui-input--${size}`, "ui-input--with-icon")} {...rest} />
      </span>
    );
  }
  return <input className={cx("ui-input", `ui-input--${size}`, className)} {...rest} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, rows = 3, ...rest }: TextareaProps) {
  return <textarea className={cx("ui-input", "ui-textarea", className)} rows={rows} {...rest} />;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  /** Either pass options or <option> children. */
  options?: SelectOption[];
  size?: "sm" | "md";
  ref?: Ref<HTMLSelectElement>;
}

/** Native select, styled. */
export function Select({ options, size = "md", className, children, ...rest }: SelectProps) {
  return (
    <span className={cx("ui-select-wrap", className)}>
      <select className={cx("ui-input", "ui-select", `ui-input--${size}`)} {...rest}>
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <IconChevronDown className="ui-select-caret" size={16} />
    </span>
  );
}

export interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/** "More details" style collapsible section (native details/summary). */
export function Disclosure({ summary, children, defaultOpen, className }: DisclosureProps) {
  return (
    <details className={cx("ui-disclosure", className)} open={defaultOpen}>
      <summary className="ui-disclosure-summary">
        <IconChevronDown className="ui-disclosure-caret" size={16} />
        {summary}
      </summary>
      <div className="ui-disclosure-body">{children}</div>
    </details>
  );
}
