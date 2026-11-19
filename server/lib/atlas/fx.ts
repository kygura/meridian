// Currency conversion for fares a connector reports outside EUR (Expedia answers in USD).
// Rates are the European Central Bank's euro reference rates, published each working day
// around 16:00 CET. Meridian never guesses a rate: a currency the ECB does not publish, or a
// failed fetch, leaves the fare without a EUR price and says why.

const ECB_DAILY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
/** The ECB publishes once a day; a few hours of reuse saves a fetch per scan. */
const CACHE_MS = 6 * 60 * 60 * 1000;

export interface EurRates {
  /** The ECB reference date the rates belong to (YYYY-MM-DD). */
  date: string;
  /** Units of each currency per 1 EUR, as the ECB publishes them. */
  perEur: Record<string, number>;
}

let cache: { at: number; rates: EurRates } | null = null;

/** For tests. */
export function resetEurRatesCache(): void {
  cache = null;
}

/** Parses the ECB daily XML: `<Cube time='2026-11-18'>` and `<Cube currency='USD' rate='1.0968'/>`. */
export function parseEcbDaily(xml: string): EurRates | null {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!date) return null;
  const perEur: Record<string, number> = {};
  for (const m of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) perEur[m[1]] = rate;
  }
  return Object.keys(perEur).length ? { date, perEur } : null;
}

/** Today's ECB rates, cached for a few hours. Throws when the feed cannot be read. */
export async function eurRates(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<EurRates> {
  if (cache && now - cache.at < CACHE_MS) return cache.rates;
  const res = await fetchImpl(ECB_DAILY, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ECB rates answered ${res.status}`);
  const rates = parseEcbDaily(await res.text());
  if (!rates) throw new Error("ECB rates could not be read");
  cache = { at: now, rates };
  return rates;
}

/** An amount in EUR, rounded to cents, or null when the ECB publishes no rate for the currency. */
export function toEur(amount: number, currency: string, rates: EurRates): { eur: number; rate: number } | null {
  const code = currency.toUpperCase();
  if (code === "EUR") return { eur: Math.round(amount * 100) / 100, rate: 1 };
  const rate = rates.perEur[code];
  if (!rate) return null;
  return { eur: Math.round((amount / rate) * 100) / 100, rate };
}
