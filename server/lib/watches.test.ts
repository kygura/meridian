import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createWatch,
  listWatches,
  deleteWatch,
  listAlerts,
  markAlertSeen,
  runWatches,
  monthsInLeadWindow,
  alertNotice,
  MAX_WATCHES,
  WatchLimitError,
  type WatchRunDeps,
} from "./watches";
import { loadEvents } from "./replayService";
import { listNotices } from "./notifier";
import type { ReplayQuery, ReplayResponse, ReplayResult, Watch } from "../../src/types";

let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-watches-"));
  process.env.DATA_DIR = TMP;
  delete process.env.ALERT_WEBHOOK_URL;
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.ALERT_WEBHOOK_URL;
  vi.restoreAllMocks();
});

const QUERY: ReplayQuery = { template: { journeyId: "j1" }, bend: {}, weights: { climate: 1, spend: 0.5, crowd: 0.5, flight: 0.5 } };
const NOW1 = new Date("2026-10-30T12:00:00Z"); // default lead window = 6..14 weeks → Dec 11 .. Feb 5
const NOW2 = new Date("2026-10-31T09:00:00Z");

type Price = NonNullable<ReplayResult["price"]>;
const res = (cityId: string, month: number, price?: Partial<Price>): ReplayResult => ({
  cityId,
  month,
  match: 90,
  dims: [],
  scoredOn: [],
  visitedBefore: false,
  ...(price ? { price: { priceAmount: price.priceEur ?? 0, currency: "EUR", source: "serpapi", ...price } as Price } : {}),
});
const response = (...results: ReplayResult[]): ReplayResponse => ({ results, universeSize: 10, template: {} });

function deps(results: ReplayResult[], over: Partial<WatchRunDeps> = {}, now = NOW1) {
  const queries: ReplayQuery[] = [];
  const d: WatchRunDeps & { queries: ReplayQuery[] } = {
    now: () => now,
    replay: async (q) => (queries.push(q), response(...results)),
    queries,
    ...over,
  };
  return d;
}

describe("watch CRUD + validation", () => {
  it("creates with defaults, lists, deletes", async () => {
    const w = await createWatch({ label: "Lisbon-like", query: QUERY });
    expect(w).toMatchObject({ label: "Lisbon-like", leadWeeks: [6, 14], priceRule: "below_my_median", active: true });
    expect(w.id).toBeTruthy();
    expect(await listWatches()).toHaveLength(1);
    expect(await deleteWatch(w.id)).toBe(true);
    expect(await deleteWatch(w.id)).toBe(false);
    expect(await listWatches()).toHaveLength(0);
  });

  it.each([
    ["empty label", { label: "  ", query: QUERY }],
    ["bad query", { label: "x", query: { template: { journeyId: "j" }, weights: { climate: 2, spend: 0, crowd: 0, flight: 0 } } }],
    ["leadWeeks a>=b", { label: "x", query: QUERY, leadWeeks: [10, 10] }],
    ["leadWeeks > 52", { label: "x", query: QUERY, leadWeeks: [6, 60] }],
    ["leadWeeks negative", { label: "x", query: QUERY, leadWeeks: [-1, 5] }],
    ["maxEur 0", { label: "x", query: QUERY, priceRule: { maxEur: 0 } }],
    ["unknown rule", { label: "x", query: QUERY, priceRule: "cheap" }],
  ])("rejects %s", async (_n, body) => {
    await expect(createWatch(body)).rejects.toThrow();
    expect(await listWatches()).toHaveLength(0);
  });

  it("caps the number of watches", async () => {
    for (let i = 0; i < MAX_WATCHES; i++) await createWatch({ label: `w${i}`, query: QUERY });
    await expect(createWatch({ label: "one too many", query: QUERY })).rejects.toBeInstanceOf(WatchLimitError);
  });
});

describe("events seed data", () => {
  it("loadEvents reads the committed data/events.json when DATA_DIR has no copy (prod DATA_DIR is a runtime disk)", async () => {
    const list = await loadEvents(NOW1); // DATA_DIR = empty temp dir here
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((e) => e.recurring)).toBe(true);
  });
});

describe("lead window", () => {
  it("covers the months whose priced date (the 15th) is within [now+6w, now+14w]", () => {
    // Window Dec 11 .. Feb 5: Dec 15 and Jan 15 qualify; Feb is only touched on Feb 1-5, but priced Feb 15.
    expect(monthsInLeadWindow(NOW1, [6, 14])).toEqual([1, 12]);
  });
  it("never includes the current month once its 15th has passed (it would be priced a year out)", () => {
    expect(monthsInLeadWindow(NOW1, [0, 4])).toEqual([11]);
    expect(monthsInLeadWindow(new Date("2026-12-20T00:00:00Z"), [0, 4])).toEqual([1]);
  });
});

describe("runWatches", () => {
  const cheap = { priceEur: 80, baselineEur: 150 };

  it("writes exactly one alert per qualifying window, zero on a second run the same day, new ones next day", async () => {
    const w = await createWatch({ label: "w", query: QUERY });
    const results = [res("lisbon-portugal", 12, cheap), res("porto-portugal", 1, cheap), res("athens-greece", 12, { priceEur: 200, baselineEur: 150 })];
    const r1 = await runWatches(deps(results));
    expect(r1).toMatchObject({ watches: 1, evaluated: 3, skipped: 0 });
    expect(r1.alerts.map((a) => `${a.cityId}/${a.month}`).sort()).toEqual(["lisbon-portugal/12", "porto-portugal/1"]);
    expect(r1.alerts[0]).toMatchObject({ watchId: w.id, priceEur: 80, baselineEur: 150, source: "serpapi", seen: false });

    const r2 = await runWatches(deps(results, {}, new Date("2026-10-30T23:59:00Z")));
    expect(r2.alerts).toHaveLength(0);
    expect(await listAlerts()).toHaveLength(2);

    const r3 = await runWatches(deps(results, {}, NOW2));
    expect(r3.alerts).toHaveLength(2);
    expect(await listAlerts()).toHaveLength(4);
    expect((await listWatches())[0]!.lastRunAt).toBe(NOW2.toISOString());
  });

  it("filters results to the lead window and narrows the replay query to those months", async () => {
    await createWatch({ label: "w", query: { ...QUERY, constraints: { months: [3, 12, 1], regions: ["europe"] } } });
    const d = deps([res("a", 12, cheap), res("b", 3, cheap), res("c", 7, cheap)]);
    const r = await runWatches(d);
    expect(d.queries[0]!.constraints).toMatchObject({ months: [1, 12], regions: ["europe"] });
    expect(r.alerts.map((a) => a.cityId)).toEqual(["a"]);
    expect(r.evaluated).toBe(1);
  });

  it("honours custom leadWeeks", async () => {
    await createWatch({ label: "w", query: QUERY, leadWeeks: [20, 30] }); // Mar 19 .. May 21
    const r = await runWatches(deps([res("a", 12, cheap), res("b", 4, cheap)]));
    expect(r.alerts.map((a) => a.cityId)).toEqual(["b"]);
  });

  it("skips and counts in-window results without a EUR price", async () => {
    await createWatch({ label: "w", query: QUERY });
    const r = await runWatches(deps([res("a", 12), res("b", 12, { priceEur: undefined }), res("c", 12, cheap)]));
    expect(r).toMatchObject({ evaluated: 1, skipped: 2 });
    expect(r.alerts).toHaveLength(1);
  });

  it("skips inactive watches", async () => {
    await createWatch({ label: "w", query: QUERY, active: false });
    const d = deps([res("a", 12, cheap)]);
    expect(await runWatches(d)).toMatchObject({ watches: 0, alerts: [] });
    expect(d.queries).toHaveLength(0);
  });

  it("below_my_median needs a baseline and a lower price", async () => {
    await createWatch({ label: "w", query: QUERY, priceRule: "below_my_median" });
    const r = await runWatches(deps([res("a", 12, { priceEur: 99, baselineEur: 100 }), res("b", 12, { priceEur: 100, baselineEur: 100 }), res("c", 12, { priceEur: 10 })]));
    expect(r.alerts.map((a) => a.cityId)).toEqual(["a"]);
  });

  it("deal_low needs dealRating low; mock prices never carry one", async () => {
    await createWatch({ label: "w", query: QUERY, priceRule: "deal_low" });
    const r = await runWatches(deps([res("a", 12, { priceEur: 90, dealRating: "low" }), res("b", 12, { priceEur: 90, dealRating: "typical" }), res("c", 12, { priceEur: 5, source: "mock" })]));
    expect(r.alerts.map((a) => a.cityId)).toEqual(["a"]);
    expect(r.alerts[0]!.baselineEur).toBe(0); // no personal baseline
  });

  it("maxEur is inclusive; mock prices pass but are recorded as mock", async () => {
    await createWatch({ label: "w", query: QUERY, priceRule: { maxEur: 100 } });
    const r = await runWatches(deps([res("a", 12, { priceEur: 100, source: "mock" }), res("b", 12, { priceEur: 100.5 })]));
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ cityId: "a", source: "mock", baselineEur: 100 });
  });

  it("a watch with no queried month inside the lead window is not an error and still records lastRunAt", async () => {
    const w = await createWatch({ label: "july", query: { ...QUERY, constraints: { months: [7] } } }); // NOW1 window: Dec/Jan
    const d = deps([res("a", 7, cheap)]);
    const r = await runWatches(d);
    expect(r).toMatchObject({ watches: 1, errors: [], alerts: [] });
    expect(d.queries).toHaveLength(0); // replay not spent on discarded months
    expect((await listWatches()).find((x) => x.id === w.id)!.lastRunAt).toBe(NOW1.toISOString());
  });

  it("deleting a watch drops its alerts (their baselineEur can't be worded without the watch)", async () => {
    const capped = await createWatch({ label: "cap", query: QUERY, priceRule: { maxEur: 300 } });
    const other = await createWatch({ label: "other", query: QUERY, priceRule: { maxEur: 300 } });
    await runWatches(deps([res("a", 12, { priceEur: 250 })]));
    expect(await listAlerts()).toHaveLength(2);
    await deleteWatch(capped.id);
    expect((await listAlerts()).map((a) => a.watchId)).toEqual([other.id]);
  });

  it("a failing replay is reported and does not stop other watches or touch lastRunAt", async () => {
    const bad = await createWatch({ label: "bad", query: { ...QUERY, template: { journeyId: "gone" } } });
    await createWatch({ label: "good", query: QUERY });
    const r = await runWatches(
      deps([res("a", 12, cheap)], {
        replay: async (q) => {
          if ("journeyId" in q.template && q.template.journeyId === "gone") throw new Error("template_not_found");
          return response(res("a", 12, cheap));
        },
      })
    );
    expect(r.errors).toHaveLength(1);
    expect(r.alerts).toHaveLength(1);
    expect((await listWatches()).find((x) => x.id === bad.id)!.lastRunAt).toBeUndefined();
  });

  it("calls the webhook once per NEW alert; failures are swallowed", async () => {
    const w = await createWatch({ label: "w", query: QUERY });
    const results = [res("a", 12, cheap), res("b", 1, cheap)];
    const seen: Array<[string, Watch]> = [];
    const webhook = vi.fn(async (a, wt) => {
      seen.push([a.cityId, wt]);
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r1 = await runWatches(deps(results, { webhook }));
    expect(r1.alerts).toHaveLength(2);
    expect(webhook).toHaveBeenCalledTimes(2);
    expect(seen[0]![1].id).toBe(w.id);
    await runWatches(deps(results, { webhook })); // same day → nothing new
    expect(webhook).toHaveBeenCalledTimes(2);
  });

  it("sends webhooks concurrently (max 5 at a time) so a dead host can't serialize the run", async () => {
    await createWatch({ label: "w", query: QUERY });
    const results = Array.from({ length: 12 }, (_, i) => res(`c${i}`, 12, cheap));
    let inFlight = 0;
    let peak = 0;
    const webhook = vi.fn(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    const r = await runWatches(deps(results, { webhook }));
    expect(r.alerts).toHaveLength(12);
    expect(webhook).toHaveBeenCalledTimes(12);
    expect(peak).toBe(5);
  });
});

describe("alertNotice / notifyAlert", () => {
  const alert = { id: "al_1", watchId: "w", cityId: "nowhere-x", month: 12, priceEur: 80, baselineEur: 150, source: "serpapi", createdAt: NOW1.toISOString(), seen: false };
  const watch: Watch = { id: "w", label: "L", query: QUERY, leadWeeks: [6, 14], priceRule: "below_my_median", active: true };

  it("words the alert, links to Watches and dedupes on the alert id", () => {
    const n = alertNotice(alert, watch);
    expect(n).toMatchObject({ kind: "watch-alert", url: "/#/plan/watches", dedupeKey: "watch-alert:al_1", data: { alert, watch } });
    expect(n.title).toBe("nowhere-x in December at 80 EUR");
    expect(n.body).toContain("below your usual 150 EUR");
    expect(n.body).toContain("Price source: serpapi.");
  });

  it("says so when the price is a mock, and words a max-price rule", () => {
    const n = alertNotice({ ...alert, source: "mock", baselineEur: 300 }, { ...watch, priceRule: { maxEur: 300 } });
    expect(n.body).toContain("at or under your 300 EUR limit");
    expect(n.body).toContain("mock price");
  });

  const cheap = { priceEur: 80, baselineEur: 150 };
  it("a new alert from a run lands in the notice log once, and the webhook still gets {text, alert, watch}", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/x";
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    await createWatch({ label: "w", query: QUERY });
    await runWatches(deps([res("a", 12, cheap)]));
    await runWatches(deps([res("a", 12, cheap)])); // same day: no new alert, no second send
    const notices = await listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "watch-alert", seen: false, deliveries: [{ channel: "webhook", ok: true }] });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/x");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ alert: { cityId: "a" }, watch: { label: "w" }, kind: "watch-alert" });
    expect(typeof body.text).toBe("string");
  });
});

describe("alerts", () => {
  it("lists newest first, filters unseen, marks seen", async () => {
    await createWatch({ label: "w", query: QUERY });
    await runWatches(deps([res("a", 12, { priceEur: 80, baselineEur: 150 })]));
    await runWatches(deps([res("a", 12, { priceEur: 80, baselineEur: 150 })], {}, NOW2));
    const all = await listAlerts();
    expect(all.map((a) => a.createdAt)).toEqual([NOW2.toISOString(), NOW1.toISOString()]);
    expect((await markAlertSeen(all[0]!.id))!.seen).toBe(true);
    expect(await markAlertSeen("nope")).toBeUndefined();
    expect((await listAlerts({ unseen: true })).map((a) => a.id)).toEqual([all[1]!.id]);
    expect(await listAlerts({ sinceDays: 1, now: new Date("2026-11-20T00:00:00Z") })).toHaveLength(0);
  });
});
