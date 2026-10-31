// Plain-language text for watches and alerts. Pure functions only.

import type { Alert, City, Journey, ReplayQuery, Watch, WatchPriceRule } from "../../../types";

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** 1-based month to its name. */
export function monthName(m: number): string {
  return MONTH_NAMES[m - 1] ?? "";
}

/** "June", "June and July", "June, July and August". */
export function listText(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function eur(n: number): string {
  return `€${Math.round(n).toLocaleString("en-US")}`;
}

/** The price rule as a sentence fragment that follows "Alert me when the fare is …". */
export function ruleText(rule: WatchPriceRule): string {
  if (rule === "below_my_median") return "below what you usually pay";
  if (rule === "deal_low") return "marked as a low fare by the provider";
  return `under ${eur(rule.maxEur)}`;
}

/** "Alert me when the fare is below what you usually pay." */
export function ruleSentence(rule: WatchPriceRule): string {
  return `Alert me when the fare is ${ruleText(rule)}.`;
}

/** "Departing 6 to 14 weeks from now." */
export function leadSentence(lead: [number, number]): string {
  return `For departures ${lead[0]} to ${lead[1]} weeks from now.`;
}

type CityLookup = Map<string, City>;

function cityName(id: string | undefined, cities: CityLookup): string | undefined {
  if (!id) return undefined;
  return cities.get(id)?.name;
}

/** "Places like Lisbon from Portugal 2024, in June or July, flying from Madrid." */
export function querySentence(q: ReplayQuery, cities: CityLookup, journeys: Journey[] | null): string {
  let like = "Places like a past trip";
  const t = q.template;
  if ("journeyId" in t) {
    const j = journeys?.find((x) => x.id === t.journeyId);
    if (j) {
      const stop = t.stopIndex !== undefined ? j.stops[t.stopIndex] : undefined;
      const stopName = stop ? cityName(stop.cityId, cities) : undefined;
      like = stopName ? `Places like ${stopName} on ${j.title}` : `Places like your trip ${j.title}`;
    }
  } else {
    like = "Places that match a saved profile";
  }
  const c = q.constraints ?? {};
  const parts = [like];
  if (c.cityIds?.length) {
    const names = c.cityIds.map((id) => cityName(id, cities) ?? id);
    parts[0] = `Fares to ${listText(names)}`;
  }
  if (c.months?.length) parts.push(`in ${listText(c.months.map(monthName)).replace(/ and ([^,]+)$/, " or $1")}`);
  else if (q.bend.monthShift === null) parts.push("in any month");
  const from = cityName(c.fromCityId, cities);
  if (from) parts.push(`flying from ${from}`);
  if (c.excludeVisited) parts.push("only places you haven't been");
  if (c.maxFlightHours) parts.push(`flights up to ${c.maxFlightHours} hours`);
  return `${parts.join(", ")}.`;
}

/** "Checked 3 hours ago", "Not checked yet". */
export function checkedText(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "Not checked yet";
  return `Checked ${agoText(iso, now)}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago". */
export function agoText(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "a while ago";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/** "Porto in June". */
export function alertTitle(a: Pick<Alert, "cityId" | "month">, cities: CityLookup): string {
  return `${cityName(a.cityId, cities) ?? "Somewhere new"} in ${monthName(a.month)}`;
}

/** How the price compares: "18% below what you usually pay (€420)" or "Under your €400 limit". */
export function alertCompareText(a: Pick<Alert, "priceEur" | "baselineEur">, watch?: Pick<Watch, "priceRule">): string | null {
  const rule = watch?.priceRule;
  if (rule && typeof rule === "object") return `Under your ${eur(rule.maxEur)} limit`;
  if (!(a.baselineEur > 0)) return null;
  const pct = Math.round(((a.priceEur - a.baselineEur) / a.baselineEur) * 100);
  const ref = rule === "deal_low" ? "the usual fare" : "what you usually pay";
  if (pct < 0) return `${Math.abs(pct)}% below ${ref} (${eur(a.baselineEur)})`;
  if (pct > 0) return `${pct}% above ${ref} (${eur(a.baselineEur)})`;
  return `About ${ref} (${eur(a.baselineEur)})`;
}

export function isMockSource(source: string): boolean {
  return /mock/i.test(source);
}

/** Newest first. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Watch-run report as a toast line. */
export function runReportText(r: { watches?: number; alerts?: unknown[]; errors?: unknown[] }): string {
  const n = r.watches ?? 0;
  const found = r.alerts?.length ?? 0;
  if (n === 0) return "No active watches to check.";
  const head = `Checked ${n} ${n === 1 ? "watch" : "watches"}.`;
  const tail = found === 0 ? " No new alerts." : ` ${found} new ${found === 1 ? "alert" : "alerts"}.`;
  const errs = r.errors?.length ? ` ${r.errors.length} couldn't be checked.` : "";
  return head + tail + errs;
}
