// Watches & alerts (spec-journal §10). A Watch is a saved ReplayQuery; runWatches()
// reruns each active one, keeps results whose month falls inside the lead window,
// and writes an Alert when the price rule passes.
//
// Price rules (on result.price.priceEur, which replay only fills for its top 20):
//   below_my_median → priceEur < price.baselineEur   (baseline = user's own median; required)
//   deal_low        → price.dealRating === "low"     (only real providers ever set it)
//   {maxEur}        → priceEur <= maxEur
// Mock prices CAN pass below_my_median and {maxEur}; the alert's `source` records "mock"
// so the UI can badge it. Alert.baselineEur is the reference price: the user's baseline,
// else maxEur for a {maxEur} rule, else 0 (= no personal baseline).
//
// Month window: replay prices the 15th of a month's next occurrence (representativeDate), so a
// month qualifies only when that date lies inside [now + leadWeeks[0] w, now + leadWeeks[1] w];
// the alert's price then refers to a date the watch actually asked about. At week resolution
// a result is a week, priced on its middle day (representativeDateOfWeek); that date must lie in
// the window, and the week is part of the alert's identity (two weeks can share a month).
//
// Delivery: each new alert becomes a Notice (notifier.ts): logged for the in-app list,
// then sent to every configured channel (push, email, Telegram, ntfy, webhook).
//
// Idempotency: alert id = hash(watchId, cityId, month[, week], UTC day of the run), so a second
// run the same day adds nothing and the next day alerts again while the window still holds.

import { createHash, randomUUID } from "crypto";
import { z } from "zod";
import type { Alert, ReplayQuery, ReplayResponse, Watch } from "../../src/types.js";
import { createJsonStore } from "./jsonStore.js";
import { replayQuerySchema } from "./replaySchema.js";
import { representativeDate, representativeDateOfWeek } from "./replay.js";
import { getCityById } from "./cities.js";
import { notify, type NotifyInput } from "./notifier.js";

export const MAX_WATCHES = 50;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const WEBHOOK_CONCURRENCY = 5;
const WEBHOOK_BUDGET_MS = 15_000;

export const priceRuleSchema = z.union([
  z.enum(["below_my_median", "deal_low"]),
  z.object({ maxEur: z.number().finite().positive() }),
]);

export const watchInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  query: replayQuerySchema,
  leadWeeks: z
    .tuple([z.number().int(), z.number().int()])
    .refine(([a, b]) => a >= 0 && a < b && b <= 52, "leadWeeks must satisfy 0 <= a < b <= 52")
    .default([6, 14]),
  priceRule: priceRuleSchema.default("below_my_median"),
  active: z.boolean().default(true),
});
export type WatchInput = z.input<typeof watchInputSchema>;

interface WatchesFile {
  version: 1;
  watches: Watch[];
}
interface AlertsFile {
  version: 1;
  alerts: Alert[];
}
const watchStore = createJsonStore<WatchesFile>("watches.json", () => ({ version: 1, watches: [] }));
const alertStore = createJsonStore<AlertsFile>("alerts.json", () => ({ version: 1, alerts: [] }));

export class WatchLimitError extends Error {}

// ── CRUD ────────────────────────────────────────────────────────────

/** Throws ZodError on invalid input and WatchLimitError past MAX_WATCHES. */
export async function createWatch(raw: unknown): Promise<Watch> {
  const input = watchInputSchema.parse(raw);
  const watch: Watch = {
    id: randomUUID(),
    label: input.label,
    query: input.query as ReplayQuery,
    leadWeeks: input.leadWeeks as [number, number],
    priceRule: input.priceRule,
    active: input.active,
  };
  await watchStore.update((f) => {
    if (f.watches.length >= MAX_WATCHES) throw new WatchLimitError(`at most ${MAX_WATCHES} watches`);
    f.watches.push(watch);
  });
  return watch;
}

export async function listWatches(): Promise<Watch[]> {
  return (await watchStore.read()).watches;
}

/** Also drops the watch's alerts: without the watch their baselineEur (e.g. a maxEur cap) can't be worded correctly. */
export async function deleteWatch(id: string): Promise<boolean> {
  const removed = await watchStore.update((f) => {
    const n = f.watches.length;
    f.watches = f.watches.filter((w) => w.id !== id);
    return f.watches.length < n;
  });
  if (removed) {
    await alertStore.update((f) => {
      f.alerts = f.alerts.filter((a) => a.watchId !== id);
    });
  }
  return removed;
}

export async function listAlerts(opts: { unseen?: boolean; sinceDays?: number; now?: Date } = {}): Promise<Alert[]> {
  let alerts = (await alertStore.read()).alerts;
  if (opts.unseen) alerts = alerts.filter((a) => !a.seen);
  if (opts.sinceDays !== undefined) {
    const cutoff = (opts.now ?? new Date()).getTime() - opts.sinceDays * 24 * 3600 * 1000;
    alerts = alerts.filter((a) => Date.parse(a.createdAt) >= cutoff);
  }
  return [...alerts].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export async function markAlertSeen(id: string): Promise<Alert | undefined> {
  return alertStore.update((f) => {
    const a = f.alerts.find((x) => x.id === id);
    if (a) a.seen = true;
    return a;
  });
}

// ── window + rules ──────────────────────────────────────────────────

/** The months (1-12) whose priced date (the 15th of the next occurrence) is within [now+lead0 w, now+lead1 w]. */
export function monthsInLeadWindow(now: Date, leadWeeks: [number, number]): number[] {
  const start = now.getTime() + leadWeeks[0] * WEEK_MS;
  const end = now.getTime() + leadWeeks[1] * WEEK_MS;
  const out: number[] = [];
  for (let m = 1; m <= 12; m++) {
    const priced = Date.parse(`${representativeDate(m, now)}T00:00:00Z`);
    if (priced >= start && priced <= end) out.push(m);
  }
  return out;
}

/** Is `dateIso` (a priced departure day) inside [now+lead0 w, now+lead1 w]? */
export function inLeadWindow(dateIso: string, now: Date, leadWeeks: [number, number]): boolean {
  const t = Date.parse(`${dateIso}T00:00:00Z`);
  return t >= now.getTime() + leadWeeks[0] * WEEK_MS && t <= now.getTime() + leadWeeks[1] * WEEK_MS;
}

/** Months (1-12) any day of the lead window falls in: what to ask replay for at week resolution. */
export function monthsTouchedByLeadWindow(now: Date, leadWeeks: [number, number]): number[] {
  const out = new Set<number>();
  const end = now.getTime() + leadWeeks[1] * WEEK_MS;
  for (let t = now.getTime() + leadWeeks[0] * WEEK_MS; t <= end; t += 86_400_000) out.add(new Date(t).getUTCMonth() + 1);
  out.add(new Date(end).getUTCMonth() + 1);
  return [...out].sort((a, b) => a - b);
}

type Priced = NonNullable<ReplayResponse["results"][number]["price"]>;

/** Whether the rule passes, and the reference price for the alert. */
export function checkPriceRule(rule: Watch["priceRule"], price: Priced, priceEur: number): { pass: boolean; baselineEur: number } {
  if (rule === "below_my_median") {
    const b = price.baselineEur;
    return { pass: typeof b === "number" && priceEur < b, baselineEur: b ?? 0 };
  }
  if (rule === "deal_low") return { pass: price.dealRating === "low", baselineEur: price.baselineEur ?? 0 };
  return { pass: priceEur <= rule.maxEur, baselineEur: rule.maxEur };
}

export function alertId(watchId: string, cityId: string, month: number, utcDay: string, week?: number): string {
  const when = week === undefined ? `${month}` : `${month}|w${week}`;
  return "al_" + createHash("sha256").update(`${watchId}|${cityId}|${when}|${utcDay}`).digest("hex").slice(0, 16);
}

// ── notify ──────────────────────────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The Notice for one alert. dedupeKey is the alert id, so an alert is sent once however often the run repeats. */
export function alertNotice(alert: Alert, watch: Watch): NotifyInput {
  const city = getCityById(alert.cityId)?.name ?? alert.cityId;
  const price = `${Math.round(alert.priceEur)} EUR`;
  const mock = alert.source === "mock";
  const when =
    alert.week !== undefined
      ? `the week of ${new Date(`${representativeDateOfWeek(alert.week, new Date(alert.createdAt))}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`
      : (MONTHS[alert.month - 1] ?? `month ${alert.month}`);
  const versus =
    typeof watch.priceRule === "object"
      ? `at or under your ${Math.round(watch.priceRule.maxEur)} EUR limit`
      : watch.priceRule === "deal_low"
        ? "rated a low price for the route"
        : alert.baselineEur > 0
          ? `below your usual ${Math.round(alert.baselineEur)} EUR`
          : "";
  return {
    kind: "watch-alert",
    // A mock price is said up front: the title is all a lock screen or a chat preview shows.
    title: `${mock ? "Mock price, not a fare: " : ""}${city} in ${when} at ${price}`,
    body: mock
      ? `This is a mock price, not a real fare (no flight provider is set up). Watch "${watch.label}": ${price}${versus ? `, ${versus}` : ""}.`
      : [`Watch "${watch.label}": flights are ${price}${versus ? `, ${versus}` : ""}.`, `Price source: ${alert.source}.`].join(" "),
    url: "/#/plan/watches",
    dedupeKey: `watch-alert:${alert.id}`,
    // The webhook payload keeps the fields it always had.
    data: { alert, watch },
  };
}

/** Log the alert as a Notice and send it through every configured channel. Never throws for a channel. */
export async function notifyAlert(alert: Alert, watch: Watch): Promise<void> {
  await notify(alertNotice(alert, watch));
}

// ── run ─────────────────────────────────────────────────────────────

export interface WatchRunDeps {
  now: () => Date;
  replay: (q: ReplayQuery) => Promise<ReplayResponse>;
  /** Called once per newly created alert; errors are swallowed. Defaults to notifyAlert (the notifier, all channels). */
  webhook?: (alert: Alert, watch: Watch) => Promise<void>;
}

export interface WatchRunReport {
  /** Active watches processed. */
  watches: number;
  /** Replay results inside the lead window that had a usable price. */
  evaluated: number;
  /** Newly created alerts only. */
  alerts: Alert[];
  /** In-window results without a EUR price (replay prices only its top 20). */
  skipped: number;
  /** Watches whose replay failed (e.g. template journey deleted). */
  errors: string[];
}

export async function runWatches(deps: WatchRunDeps): Promise<WatchRunReport> {
  const now = deps.now();
  const day = now.toISOString().slice(0, 10);
  const report: WatchRunReport = { watches: 0, evaluated: 0, alerts: [], skipped: 0, errors: [] };
  const sendWebhook = deps.webhook ?? notifyAlert;
  const toNotify: Array<[Alert, Watch]> = [];

  for (const watch of (await listWatches()).filter((w) => w.active)) {
    report.watches++;
    const weekly = watch.query.resolution === "week";
    const window = weekly ? monthsTouchedByLeadWindow(now, watch.leadWeeks) : monthsInLeadWindow(now, watch.leadWeeks);
    // Only ask replay about in-window months so its top-N pricing isn't spent on months we'd discard.
    const wanted = watch.query.constraints?.months?.length ? window.filter((m) => watch.query.constraints!.months!.includes(m)) : window;
    const markRun = () =>
      watchStore.update((f) => {
        const w = f.watches.find((x) => x.id === watch.id);
        if (w) w.lastRunAt = now.toISOString();
      });
    // No queried month inside today's lead window: a normal outcome (seasonal watch), not a failure.
    if (wanted.length === 0) {
      await markRun();
      continue;
    }
    let response: ReplayResponse;
    try {
      response = await deps.replay({ ...watch.query, constraints: { ...watch.query.constraints, months: wanted } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`${watch.id}: ${msg}`);
      continue;
    }

    const fresh: Alert[] = [];
    for (const r of response.results) {
      // A week is judged by its own priced day; a month by the 15th (monthsInLeadWindow).
      if (r.week !== undefined ? !inLeadWindow(representativeDateOfWeek(r.week, now), now, watch.leadWeeks) : !window.includes(r.month) || (weekly && !inLeadWindow(representativeDate(r.month, now), now, watch.leadWeeks))) continue;
      const priceEur = r.price?.priceEur;
      if (!r.price || typeof priceEur !== "number") {
        report.skipped++;
        continue;
      }
      report.evaluated++;
      const rule = checkPriceRule(watch.priceRule, r.price, priceEur);
      if (!rule.pass) continue;
      fresh.push({
        id: alertId(watch.id, r.cityId, r.month, day, r.week),
        watchId: watch.id,
        cityId: r.cityId,
        month: r.month,
        ...(r.week !== undefined ? { week: r.week } : {}),
        priceEur,
        baselineEur: rule.baselineEur,
        source: r.price.source,
        createdAt: now.toISOString(),
        seen: false,
      });
    }

    // Insert-if-absent inside the serialized store update: concurrent runs can't double-create.
    const created = await alertStore.update((f) => {
      const have = new Set(f.alerts.map((a) => a.id));
      const added: Alert[] = [];
      for (const a of fresh) {
        if (have.has(a.id)) continue;
        have.add(a.id);
        f.alerts.push(a);
        added.push(a);
      }
      return added;
    });
    report.alerts.push(...created);
    await markRun();
    for (const a of created) toNotify.push([a, watch]);
  }

  // Bounded fan-out so a dead webhook host can't hold the request open: 5 at a time, ~15s budget per run.
  const deadline = Date.now() + WEBHOOK_BUDGET_MS;
  for (let i = 0; i < toNotify.length; i += WEBHOOK_CONCURRENCY) {
    if (Date.now() > deadline) {
      console.error(`[watches] webhook budget exhausted; ${toNotify.length - i} alert webhook(s) not sent`);
      break;
    }
    const results = await Promise.allSettled(toNotify.slice(i, i + WEBHOOK_CONCURRENCY).map(async ([a, w]) => sendWebhook(a, w)));
    for (const r of results) {
      if (r.status === "rejected") console.error("[watches] webhook failed:", r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }
  return report;
}
