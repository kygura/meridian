// Money normalization (spec-journal D7, ruling R5).
//
// Every amount keeps its original currency + amount and gains an EUR value at the
// ECB reference rate for its date, via Frankfurter (keyless). The base URL is
// api.frankfurter.dev/v1 — the old api.frankfurter.app host now 301-redirects.
// Weekend/holiday dates resolve to the prior business day; that returned date is
// stored as `rateDate`.
//
// Cache: data/cache/fx.json keyed "<requested date>|<CUR>". Network failure (and
// 5xx/429) falls back to the most recent cached rate for that currency; with none,
// or on a definitive answer (other 4xx, no rate in the body), we throw
// FxUnavailableError instead of storing a guessed number. EUR is identity, no I/O.

import type { Money } from "../../src/types.js";
import { createJsonStore } from "./jsonStore.js";

export const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";

export type FxFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class FxUnavailableError extends Error {
  constructor(
    public readonly currency: string,
    public readonly date: string,
    reason?: string,
  ) {
    super(`No EUR rate available for ${currency} on ${date}${reason ? ` (${reason})` : ""}`);
    this.name = "FxUnavailableError";
  }
}

interface CachedRate {
  /** EUR per 1 unit of the currency. */
  rate: number;
  rateDate: string;
  fetchedAt: string;
}

interface FxCache {
  rates: Record<string, CachedRate>;
}

const cache = createJsonStore<FxCache>("cache/fx.json", () => ({ rates: {} }));

const defaultFetch: FxFetch = (url) => fetch(url, { signal: AbortSignal.timeout(8000) });
let fxFetch: FxFetch = defaultFetch;

/** Test seam: inject a fake fetch; call with no argument to restore the real one. */
export function setFxFetch(f?: FxFetch): void {
  fxFetch = f ?? defaultFetch;
}

const inflight = new Map<string, Promise<CachedRate>>();

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A definitive answer from Frankfurter (4xx other than 429, or no rate): no cached fallback (R5). */
class FxDefinitiveError extends Error {}

async function fetchRate(currency: string, date: string): Promise<CachedRate> {
  const res = await fxFetch(`${FRANKFURTER_BASE}/${date}?from=${currency}&to=EUR`);
  if (!res.ok) {
    const msg = `frankfurter ${res.status}`;
    throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new FxDefinitiveError(msg) : new Error(msg);
  }
  const body = (await res.json()) as { date?: unknown; rates?: { EUR?: unknown } };
  const rate = body.rates?.EUR;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) throw new FxDefinitiveError("frankfurter: no EUR rate");
  const rateDate = typeof body.date === "string" ? body.date : date;
  return { rate, rateDate, fetchedAt: new Date().toISOString() };
}

async function resolveRate(currency: string, date: string): Promise<CachedRate> {
  const key = `${date}|${currency}`;
  const hit = (await cache.read()).rates[key];
  if (hit) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const fresh = await fetchRate(currency, date);
      await cache.update((c) => {
        c.rates[key] = fresh;
      });
      return fresh;
    } catch (err) {
      if (err instanceof FxDefinitiveError) throw new FxUnavailableError(currency, date, err.message);
      // Network failure / 5xx / 429 fallback: latest cached rate for this currency (by rateDate).
      const latest = Object.entries((await cache.read()).rates)
        .filter(([k]) => k.endsWith(`|${currency}`))
        .map(([, v]) => v)
        .sort((a, b) => b.rateDate.localeCompare(a.rateDate))[0];
      if (latest) return latest;
      throw new FxUnavailableError(currency, date, err instanceof Error ? err.message : String(err));
    }
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** Convert `amount` in `currency` on `date` (YYYY-MM-DD or ISO datetime) to a full Money. */
export async function toMoney(amount: number, currency: string, date: string): Promise<Money> {
  const cur = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw new FxUnavailableError(currency, date, "invalid currency code");
  const day = DATE_RE.exec(date)?.[0];
  if (!day) throw new FxUnavailableError(cur, date, "invalid date");
  if (cur === "EUR") return { amount, currency: cur, eur: round2(amount), rateDate: day };
  const { rate, rateDate } = await resolveRate(cur, day);
  return { amount, currency: cur, eur: round2(amount * rate), rateDate };
}

export interface MoneyInput {
  amount: number;
  currency: string;
  eur?: number;
  rateDate?: string;
}

/**
 * Fill `eur`/`rateDate` when missing (R5: clients may omit them). A Money that
 * already carries both is kept as recorded. `date` is the record's own date
 * (stay arrival, segment departure, experience date), used when `rateDate` is absent.
 */
export async function normalizeMoney(m: MoneyInput, date: string): Promise<Money> {
  const currency = m.currency.trim().toUpperCase();
  if (typeof m.eur === "number" && m.rateDate) {
    return { amount: m.amount, currency, eur: m.eur, rateDate: m.rateDate };
  }
  return toMoney(m.amount, currency, m.rateDate ?? date);
}
