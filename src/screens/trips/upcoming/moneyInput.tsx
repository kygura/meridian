// Amount + currency for itinerary prices (stays, activities, recorded bookings).
// Unlike the journal's MoneyField, nothing is converted: a planned price is kept exactly
// as it was entered.

import { useId } from "react";
import { Input, Select } from "../../../ui";
import type { MoneyInput as Money } from "../../../types";

export interface MoneyDraftValue {
  amount: string;
  currency: string;
}

// EUR first, then the usual travel currencies (same list as the journal's forms).
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "PLN", "CZK", "SEK", "NOK", "DKK", "HUF", "RON", "TRY", "JPY", "CNY", "KRW", "THB", "VND", "IDR", "MYR", "INR", "LKR", "AED", "AUD", "NZD", "CAD", "MXN", "COP", "BRL", "ARS", "ZAR", "MAD"];

export function moneyDraft(m: Money | undefined): MoneyDraftValue {
  return { amount: m ? String(m.amount) : "", currency: m?.currency ?? "EUR" };
}

/** undefined = left empty; "invalid" = something typed that isn't a non-negative number. */
export function moneyFromDraft(d: MoneyDraftValue): Money | undefined | "invalid" {
  const raw = d.amount.trim().replace(",", ".");
  if (!raw) return undefined;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return "invalid";
  return { amount, currency: d.currency };
}

export function MoneyInput({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: MoneyDraftValue;
  onChange: (v: MoneyDraftValue) => void;
  hint?: string;
}) {
  const id = useId();
  const bad = moneyFromDraft(value) === "invalid";
  const options = CURRENCIES.includes(value.currency) ? CURRENCIES : [value.currency, ...CURRENCIES];
  return (
    <div className={bad ? "ui-field ui-field--error" : "ui-field"}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
        <span className="ui-field-optional"> (optional)</span>
      </label>
      <div className="trips-itin-money">
        <Input
          id={id}
          inputMode="decimal"
          placeholder="0"
          className="num"
          value={value.amount}
          aria-invalid={bad || undefined}
          aria-describedby={bad ? `${id}-err` : hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange({ ...value, amount: e.target.value })}
        />
        <Select
          aria-label={`${label}: currency`}
          value={value.currency}
          onChange={(e) => onChange({ ...value, currency: e.target.value })}
          options={options.map((c) => ({ value: c, label: c }))}
        />
      </div>
      {bad ? (
        <p id={`${id}-err`} className="ui-field-error" role="alert">
          Enter a number, like 120 or 89.50.
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="ui-field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
