import { useId, useState, type ReactNode } from "react";
import type { City } from "../../../types";
import type { MoneyDraft } from "../../../lib/journalForm";
import { Button, CitySearch, Input, Select } from "../../../ui";
import { sentence } from "./format";

/** Error text from journalForm (upper case) as a plain sentence. */
export function FieldError({ id, children }: { id?: string; children?: string }) {
  if (!children) return null;
  return (
    <p id={id} className="trips-ql-error" role="alert">
      {children === children.toUpperCase() ? sentence(children) : children}
    </p>
  );
}

/** Label + free content (for groups that are not a single control). */
export function Group({ label, htmlFor, optional, children, className }: { label: string; htmlFor?: string; optional?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={`trips-ql-group${className ? ` ${className}` : ""}`}>
      {htmlFor ? (
        <label className="trips-ql-label" htmlFor={htmlFor}>
          {label}
          {optional ? <span className="trips-ql-optional"> (optional)</span> : null}
        </label>
      ) : (
        <span className="trips-ql-label">
          {label}
          {optional ? <span className="trips-ql-optional"> (optional)</span> : null}
        </span>
      )}
      {children}
    </div>
  );
}

/** Picked city as a chip-like box with "Change", or a CitySearch while empty. */
export function CityPicker({
  id,
  cityId,
  cityIdx,
  onChange,
  label,
  placeholder = "Search cities or airports",
  invalid,
  describedBy,
}: {
  id: string;
  cityId: string;
  cityIdx: Map<string, City>;
  onChange: (cityId: string) => void;
  label: string;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [changing, setChanging] = useState(false);
  if (cityId) {
    const c = cityIdx.get(cityId);
    return (
      <div className="trips-ql-city">
        <span className="trips-ql-city-name">
          {c?.name ?? cityId}
          {c?.country ? <span className="trips-ql-city-country">{c.country}</span> : null}
        </span>
        <Button
          id={id}
          variant="ghost"
          size="sm"
          aria-label={`Change ${label}`}
          onClick={() => {
            setChanging(true);
            onChange("");
          }}
        >
          Change
        </Button>
      </div>
    );
  }
  return (
    <CitySearch
      id={id}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      placeholder={placeholder}
      autoFocus={changing}
      onPick={(c) => {
        setChanging(false);
        onChange(c.id);
      }}
    />
  );
}

// EUR first, then the usual travel currencies. A code from an import stays selectable.
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "PLN", "CZK", "SEK", "NOK", "DKK", "HUF", "RON", "TRY", "JPY", "CNY", "KRW", "THB", "IDR", "INR", "AED", "AUD", "NZD", "CAD", "MXN", "BRL", "ARS", "ZAR", "MAD"];

/** Amount + currency. Non-euro amounts are converted on save at that day's rate. */
export function MoneyField({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: MoneyDraft;
  onChange: (m: MoneyDraft) => void;
  error?: string;
}) {
  const hintId = useId();
  const errId = useId();
  const options = CURRENCIES.includes(value.currency) ? CURRENCIES : [value.currency, ...CURRENCIES];
  const showHint = !error && value.currency !== "EUR" && value.amount.trim() !== "";
  return (
    <div className="trips-ql-group">
      <label className="trips-ql-label" htmlFor={id}>
        {label}
        <span className="trips-ql-optional"> (optional)</span>
      </label>
      <div className="trips-ql-money">
        <Input
          id={id}
          inputMode="decimal"
          placeholder="0"
          className="num"
          value={value.amount}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : showHint ? hintId : undefined}
          onChange={(e) => onChange({ ...value, amount: e.target.value })}
        />
        <Select
          aria-label={`${label} currency`}
          value={value.currency}
          onChange={(e) => onChange({ ...value, currency: e.target.value })}
          options={options.map((c) => ({ value: c, label: c }))}
        />
      </div>
      <FieldError id={errId}>{error}</FieldError>
      {showHint ? (
        <p id={hintId} className="trips-ql-hint">
          Converted to euros at that day's rate when you save.
        </p>
      ) : null}
    </div>
  );
}
