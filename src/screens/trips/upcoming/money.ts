// Display currency for planned-trip estimates.
//
// The journal shows every amount in EUR (Money.eur, ECB rate from the server). Planned
// trip leg estimates are computed client-side in USD (lib/geo). When the journal is in
// use and we know a USD -> EUR rate, show estimates in EUR so Trips reads in one
// currency. Rates are only ever taken from server answers the client already has:
// journal Money values (amount + currency + eur) and replay prices (priceAmount +
// currency + priceEur). With no known rate we keep the original currency.

import { useEffect, useMemo } from "react";
import { useMeridianStore } from "../../../store";
import { refreshJourneys } from "../../../lib/journalApi";
import { formatUSD } from "../../../lib/tripPlan";
import { useJournalToken } from "../../../ui";
import type { Journey, Money } from "../../../types";

const STORAGE_KEY = "meridian.fx.eurPerUnit";

interface LearnedRate {
  /** EUR per one unit of the currency. */
  rate: number;
  /** ISO date the rate is for; newer wins. */
  date: string;
}

type RateMap = Record<string, LearnedRate>;

function readLearned(): RateMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as RateMap) : {};
  } catch {
    return {};
  }
}

function writeLearned(map: RateMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable: rates stay in memory only for this call */
  }
}

function better(a: LearnedRate | undefined, b: LearnedRate): boolean {
  return !a || b.date >= a.date;
}

/** Remember an EUR rate implied by a server-converted amount (replay prices, etc.). */
export function learnEurRate(currency: string | undefined, amount: number | undefined, eur: number | undefined, date?: string): void {
  if (!currency || currency === "EUR" || !amount || !eur || amount <= 0 || eur <= 0) return;
  const rate = eur / amount;
  if (!Number.isFinite(rate)) return;
  const map = readLearned();
  const next = { rate, date: date ?? new Date().toISOString().slice(0, 10) };
  if (better(map[currency], next)) {
    map[currency] = next;
    writeLearned(map);
  }
}

/** Rates implied by journal Money values (latest rateDate per currency). */
export function ratesFromJourneys(journeys: Journey[] | null): RateMap {
  const out: RateMap = {};
  if (!journeys) return out;
  const take = (m: Money | undefined) => {
    if (!m || m.currency === "EUR" || !(m.amount > 0) || !(m.eur > 0)) return;
    const next = { rate: m.eur / m.amount, date: m.rateDate };
    if (better(out[m.currency], next)) out[m.currency] = next;
  };
  for (const j of journeys) {
    j.stops.forEach((s) => take(s.lodging?.cost));
    j.segments.forEach((s) => take(s.cost));
    j.experiences.forEach((e) => take(e.cost));
  }
  return out;
}

function formatEUR(n: number): string {
  return formatUSD(n, "EUR");
}

/**
 * Formatter for planned-trip money: `fmt(amount, currency = "USD")`.
 * EUR (the journal's display currency) when the journal has loaded and a rate is known;
 * otherwise the original currency, as before.
 */
export function useTripMoney(): (amount: number, currency?: string) => string {
  const journeys = useMeridianStore((s) => s.journeys);
  const { unlocked } = useJournalToken();
  useEffect(() => {
    // Same pattern as Map / Inbox: load the journal once so its currency is known.
    if (unlocked && useMeridianStore.getState().journeys === null) refreshJourneys().catch(() => {});
  }, [unlocked]);
  return useMemo(() => {
    const journalInUse = journeys !== null && journeys.length > 0;
    const rates: RateMap = { ...readLearned(), ...ratesFromJourneys(journeys) };
    return (amount: number, currency = "USD") => {
      if (currency === "EUR") return formatEUR(amount);
      const r = rates[currency];
      if (journalInUse && r) return formatEUR(amount * r.rate);
      return formatUSD(amount, currency);
    };
  }, [journeys]);
}
