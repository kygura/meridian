import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The dataLayer order is what Consent Mode depends on, so it is checked call by call.
// A minimal window/document/localStorage stands in for the browser.

type Entry = unknown[];

function fakeBrowser({ framed = false }: { framed?: boolean } = {}) {
  const store = new Map<string, string>();
  const appended: Array<{ src: string; async: boolean }> = [];
  const win: Record<string, unknown> = { location: { origin: "https://meridian.example", hash: "" } };
  win.self = win;
  win.top = framed ? {} : win;
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("document", {
    createElement: () => ({ src: "", async: false }),
    head: { appendChild: (el: { src: string; async: boolean }) => appended.push(el) },
  });
  return { win, store, appended, layer: () => ((win.dataLayer as IArguments[]) ?? []).map((a) => Array.from(a) as Entry) };
}

async function load(id: string | undefined) {
  vi.resetModules();
  vi.stubEnv("VITE_GA_ID", id ?? "");
  return import("./analytics");
}

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-20T12:00:00Z") }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("analytics", () => {
  it("puts consent defaults in before gtag.js loads and configures without an automatic page view", async () => {
    const b = fakeBrowser();
    const a = await load("G-TEST123");
    a.initAnalytics();
    const layer = b.layer();
    expect(layer[0]).toEqual([
      "consent",
      "default",
      { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", wait_for_update: 500 },
    ]);
    expect(layer[1]).toEqual(["set", "ads_data_redaction", true]);
    expect(layer.map((e) => e[0])).toEqual(["consent", "set", "js", "config"]);
    expect(layer[3]).toEqual(["config", "G-TEST123", { send_page_view: false }]);
    expect(b.appended).toEqual([{ src: "https://www.googletagmanager.com/gtag/js?id=G-TEST123", async: true }]);
  });

  it("replays a saved choice as an update before the tag loads, and never grants ad signals", async () => {
    const b = fakeBrowser();
    b.store.set("meridian.consent", JSON.stringify({ choice: "granted", at: Date.now() - 1000 }));
    const a = await load("G-TEST123");
    a.initAnalytics();
    expect(b.layer()[2]).toEqual([
      "consent",
      "update",
      { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" },
    ]);
  });

  it("forgets a choice after a year", async () => {
    const b = fakeBrowser();
    b.store.set("meridian.consent", JSON.stringify({ choice: "granted", at: Date.now() - 366 * 86400_000 }));
    const a = await load("G-TEST123");
    expect(a.readConsent()).toBeNull();
  });

  it("saves the banner's answer and sends it as an update", async () => {
    const b = fakeBrowser();
    const a = await load("G-TEST123");
    a.initAnalytics();
    const seen = vi.fn();
    a.onConsentChange(seen);
    a.setConsent("denied");
    expect(JSON.parse(b.store.get("meridian.consent")!)).toEqual({ choice: "denied", at: Date.now() });
    expect(b.layer().at(-1)).toEqual(["consent", "update", expect.objectContaining({ analytics_storage: "denied" })]);
    expect(seen).toHaveBeenCalledOnce();
  });

  it("sends hash routes as virtual paths", async () => {
    const b = fakeBrowser();
    const a = await load("G-TEST123");
    a.initAnalytics();
    a.trackPageView("/plan/when", "Plan · when · Meridian");
    expect(b.layer().at(-1)).toEqual([
      "event",
      "page_view",
      { page_location: "https://meridian.example/plan/when", page_path: "/plan/when", page_title: "Plan · when · Meridian" },
    ]);
  });

  it("does nothing without an ID, with a non-GA4 ID, or inside a frame", async () => {
    for (const [id, framed] of [[undefined, false], ["UA-1234-1", false], ["G-TEST123", true]] as const) {
      const b = fakeBrowser({ framed });
      const a = await load(id);
      a.initAnalytics();
      a.trackEvent("city_view", { city_id: "x" });
      expect(a.analyticsEnabled()).toBe(false);
      expect(b.layer()).toEqual([]);
      expect(b.appended).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});
