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
// the alert's price then refers to a date the watch actually asked about.
//
// Idempotency: alert id = hash(watchId, cityId, month, UTC day of the run), so a second
// run the same day adds nothing and the next day alerts again while the window still holds.

import { createHash, randomUUID } from "crypto";
import { z } from "zod";
import type { Alert, ReplayQuery, ReplayResponse, Watch } from "../../src/types.js";
import { createJsonStore } from "./jsonStore.js";
import { replayQuerySchema } from "./replaySchema.js";
import { representativeDate } from "./replay.js";

export const MAX_WATCHES = 50;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const WEBHOOK_CONCURRENCY = 5;
const WEBHOOK_BUDGET_MS = 15_000;
const WEBHOOK_TIMEOUT_MS = 5000;

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

export function alertId(watchId: string, cityId: string, month: number, utcDay: string): string {
  return "al_" + createHash("sha256").update(`${watchId}|${cityId}|${month}|${utcDay}`).digest("hex").slice(0, 16);
}

// ── webhook ─────────────────────────────────────────────────────────

/** POST {text, alert, watch} to ALERT_WEBHOOK_URL (5s timeout). Never throws. */
export async function postAlertWebhook(alert: Alert, watch: Watch, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const text = `Meridian watch "${watch.label}": ${alert.cityId} in month ${alert.month} at ${Math.round(alert.priceEur)} EUR (${alert.source})`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, alert, watch }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`[watches] webhook responded ${res.status}`);
  } catch (err) {
    console.error("[watches] webhook failed:", err instanceof Error ? err.message : String(err));
  }
}

// ── run ─────────────────────────────────────────────────────────────

export interface WatchRunDeps {
  now: () => Date;
  replay: (q: ReplayQuery) => Promise<ReplayResponse>;
  /** Called once per newly created alert; errors are swallowed. Defaults to postAlertWebhook. */
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
  const sendWebhook = deps.webhook ?? ((a: Alert, w: Watch) => postAlertWebhook(a, w));
  const toNotify: Array<[Alert, Watch]> = [];

  for (const watch of (await listWatches()).filter((w) => w.active)) {
    report.watches++;
    const window = monthsInLeadWindow(now, watch.leadWeeks);
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
      if (!window.includes(r.month)) continue;
      const priceEur = r.price?.priceEur;
      if (!r.price || typeof priceEur !== "number") {
        report.skipped++;
        continue;
      }
      report.evaluated++;
      const rule = checkPriceRule(watch.priceRule, r.price, priceEur);
      if (!rule.pass) continue;
      fresh.push({
        id: alertId(watch.id, r.cityId, r.month, day),
        watchId: watch.id,
        cityId: r.cityId,
        month: r.month,
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
