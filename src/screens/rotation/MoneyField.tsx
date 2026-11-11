import { useId } from "react";
import { Input, Select } from "../../ui";
import { moneyFromDraft, type MoneyDraftValue } from "../trips/upcoming/moneyInput";

// Amount + currency, kept exactly as entered (never converted), like itinerary prices.
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "PLN", "CZK", "SEK", "NOK", "DKK", "HUF", "TRY", "JPY", "KRW", "THB", "VND", "IDR", "MYR", "INR", "LKR", "AED", "AUD", "NZD", "CAD", "MXN", "COP", "BRL", "ARS", "ZAR", "MAD", "GEL"];

export function MoneyField({ label, value, onChange }: { label: string; value: MoneyDraftValue; onChange: (v: MoneyDraftValue) => void }) {
  const id = useId();
  const bad = moneyFromDraft(value) === "invalid";
  const options = CURRENCIES.includes(value.currency) ? CURRENCIES : [value.currency, ...CURRENCIES];
  return (
    <div className={bad ? "ui-field ui-field--error" : "ui-field"}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
        <span className="ui-field-optional"> (optional)</span>
      </label>
      <div className="rotation-money">
        <Input
          id={id}
          inputMode="decimal"
          placeholder="0"
          className="num"
          value={value.amount}
          aria-invalid={bad || undefined}
          onChange={(e) => onChange({ ...value, amount: e.target.value })}
        />
        <Select
          aria-label={`${label}: currency`}
          value={value.currency}
          onChange={(e) => onChange({ ...value, currency: e.target.value })}
          options={options.map((c) => ({ value: c, label: c }))}
        />
      </div>
      {bad && (
        <p className="ui-field-error" role="alert">
          Enter a number, like 1200.
        </p>
      )}
    </div>
  );
}
