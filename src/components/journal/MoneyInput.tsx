import type { MoneyDraft } from "../../lib/journalForm";

// EUR first, then the usual travel currencies. Free-typed ISO codes from an import stay selectable.
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "PLN", "CZK", "SEK", "NOK", "DKK", "HUF", "RON", "TRY", "JPY", "CNY", "KRW", "THB", "IDR", "INR", "AED", "AUD", "NZD", "CAD", "MXN", "BRL", "ARS", "ZAR", "MAD"];

export default function MoneyInput({
  id,
  value,
  onChange,
  label,
  error,
}: {
  id?: string;
  value: MoneyDraft;
  onChange: (m: MoneyDraft) => void;
  label: string;
  error?: string;
}) {
  const options = CURRENCIES.includes(value.currency) ? CURRENCIES : [value.currency, ...CURRENCIES];
  return (
    <div className="jr-money">
      <div className="jr-money-row">
        <input
          id={id}
          className="jr-input jr-money-amount"
          inputMode="decimal"
          placeholder="0"
          aria-label={`${label} amount`}
          aria-invalid={!!error}
          value={value.amount}
          onChange={(e) => onChange({ ...value, amount: e.target.value })}
        />
        <select
          className="jr-input jr-money-cur"
          aria-label={`${label} currency`}
          value={value.currency}
          onChange={(e) => onChange({ ...value, currency: e.target.value })}
        >
          {options.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      {error && <div className="jr-err">{error}</div>}
      {!error && value.currency !== "EUR" && value.amount.trim() !== "" && (
        <div className="jr-hint">CONVERTED TO EUR AT THAT DAY'S RATE ON SAVE</div>
      )}
    </div>
  );
}
