import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import type { MapAnomaly } from "../../src/types.js";

let app: Hono;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "meridian-news-place-"));
  const { loadCities } = await import("../lib/cities.js");
  loadCities();
  app = (await import("./news.js")).default;
});

afterEach(async () => {
  vi.restoreAllMocks();
  (await import("../lib/placeNews.js")).resetPlaceNewsCache();
});

describe("GET /api/news/place", () => {
  it("404s an unknown city", async () => {
    expect((await app.request("/place?cityId=nowhere-nowhere")).status).toBe(404);
  });

  it("returns curated conflicts for the country even when news search is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const res = await app.request("/place?cityId=kiev-ukraine");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; advisories: MapAnomaly[]; issues: unknown[]; country: string };
    expect(body.available).toBe(false);
    expect(body.country).toBe("Ukraine");
    expect(body.issues).toEqual([]);
    expect(body.advisories.map((a) => a.id)).toContain("conflict-ukraine");
  });

  it("detects a systemic issue from the headlines alone", async () => {
    const rss = (items: [string, string][]) =>
      `<rss><channel>${items.map(([t, d]) => `<item><title>${t}</title><link>https://n/${encodeURIComponent(t)}</link><pubDate>${d}</pubDate></item>`).join("")}</channel></rss>`;
    const xml = rss([
      ["High-speed train collision in Spain kills at least 41 - Reuters", "Sun, 18 Jan 2026 20:00:00 GMT"],
      ["Spain train crash kills at least 68 on Madrid-Seville line - CNN", "Wed, 28 Oct 2026 12:00:00 GMT"],
      ["EU investigates fraud in Spain rail funds after fatal crash - Politico", "Thu, 05 Nov 2026 09:00:00 GMT"],
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(xml));
    const body = (await (await app.request("/place?cityId=madrid-spain")).json()) as {
      issues: { subject: string; level: string; incidents: number; deaths: number; linked: string[] }[];
    };
    const rail = body.issues.find((i) => i.subject === "rail")!;
    expect(rail).toMatchObject({ level: "systemic", incidents: 2, deaths: 109 });
    expect(rail.linked).toContain("governance");
  });

  it("returns no advisories for a country without any", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const body = (await (await app.request("/place?cityId=tokyo-japan")).json()) as { advisories: MapAnomaly[] };
    expect(body.advisories).toEqual([]);
  });
});
