import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CACHE_LIMITS, isPrivateApiPath, isStorable, overLimit, routeFor } from "./strategy";
import { precacheManifest } from "../../scripts/vite-plugin-sw";

const ctx = { origin: "https://m.example", precached: new Set(["/index.html", "/assets/app-1.js", "/fonts/meridian-serif/0-255.pbf"]) };
const get = (url: string, mode?: string) => routeFor({ method: "GET", url, mode }, ctx);

describe("routeFor", () => {
  it("answers page loads and built files from the shell", () => {
    expect(get("https://m.example/", "navigate")).toBe("navigate");
    expect(get("https://m.example/?source=pwa", "navigate")).toBe("navigate");
    expect(get("https://m.example/assets/app-1.js")).toBe("shell");
    expect(get("https://m.example/fonts/meridian-serif/0-255.pbf")).toBe("shell");
    expect(get("https://m.example/vendor/late.js")).toBe("static");
  });

  it("keeps the owner's data apart from public data", () => {
    for (const p of ["/api/journal", "/api/journal/j1", "/api/bookings", "/api/watches/alerts", "/api/import/queue", "/api/notifications", "/api/shortlist", "/api/rotation", "/api/rotation/reminders", "/api/solver/proposals", "/api/notion/pool", "/api/gmail/status"]) {
      expect(get(`https://m.example${p}`), p).toBe("private");
    }
    for (const p of ["/api/cities?limit=10000", "/api/seasonality/cities", "/api/livability", "/api/news", "/api/metrics/city/x", "/api/overlays/events?cityIds=a"]) {
      expect(get(`https://m.example${p}`), p).toBe("data");
    }
    expect(isPrivateApiPath("/api/journalists")).toBe(false);
  });

  it("never caches trips (they sync), streams, jobs or anything that does work", () => {
    for (const p of ["/api/trips", "/api/trips/t1", "/api/agent/models", "/api/health", "/api/jobs/daily", "/api/watches/run", "/api/notifications/test", "/api/auth/session", "/api/shared/abc123", "/api/gmail/callback"]) {
      expect(get(`https://m.example${p}`), p).toBe("pass");
    }
  });

  it("passes every write through, whatever the path", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(routeFor({ method, url: "https://m.example/api/journal" }, ctx)).toBe("pass");
      expect(routeFor({ method, url: "https://m.example/api/cities" }, ctx)).toBe("pass");
    }
  });

  it("an API navigation (a download link) is still treated as API, not as the app shell", () => {
    expect(get("https://m.example/api/journal/export", "navigate")).toBe("private");
  });

  it("recognises the API on another origin only when configured", () => {
    expect(get("https://api.example/api/journal")).toBe("pass");
    expect(routeFor({ method: "GET", url: "https://api.example/api/journal" }, { ...ctx, apiOrigin: "https://api.example" })).toBe("private");
    expect(routeFor({ method: "GET", url: "https://api.example/api/cities" }, { ...ctx, apiOrigin: "https://api.example" })).toBe("data");
  });

  it("caches map resources from other hosts and leaves the rest alone", () => {
    expect(get("https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_admin_0_countries.geojson")).toBe("map");
    expect(get("https://tiles.example/osm/7/63/42.png")).toBe("map");
    expect(get("https://tiles.example/v3/4/8/5.pbf")).toBe("map");
    expect(get("https://upload.wikimedia.org/wikipedia/commons/a/ab/Photo.jpg")).toBe("pass");
    expect(get("https://api.resend.com/emails")).toBe("pass");
    expect(get("chrome-extension://abc/x.js")).toBe("pass");
    expect(get("not a url")).toBe("pass");
  });
});

describe("cache bounds", () => {
  it("drops the oldest entries past the limit", () => {
    expect(overLimit([1, 2, 3], 5)).toEqual([]);
    expect(overLimit([1, 2, 3, 4, 5], 3)).toEqual([1, 2]);
    expect(CACHE_LIMITS.map).toBeGreaterThan(0);
  });

  it("stores only complete successful answers (and opaque map tiles)", () => {
    expect(isStorable({ status: 200 }, "private")).toBe(true);
    for (const status of [206, 301, 401, 404, 500]) expect(isStorable({ status }, "private"), String(status)).toBe(false);
    expect(isStorable({ status: 0, type: "opaque" }, "map")).toBe(true);
    expect(isStorable({ status: 0, type: "opaque" }, "data")).toBe(false);
  });
});

describe("precacheManifest", () => {
  it("lists built files without maps, licences or the worker, and versions them by content", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-sw-"));
    try {
      mkdirSync(join(dir, "assets"));
      mkdirSync(join(dir, "fonts"));
      writeFileSync(join(dir, "index.html"), "<html>");
      writeFileSync(join(dir, "assets/app-1.js"), "a");
      writeFileSync(join(dir, "assets/app-1.js.map"), "{}");
      writeFileSync(join(dir, "fonts/LICENSE.md"), "ofl");
      writeFileSync(join(dir, "sw.js"), "old");
      const first = precacheManifest(dir);
      expect(first.files).toEqual(["/assets/app-1.js", "/index.html"]);
      writeFileSync(join(dir, "sw.js"), "new");
      expect(precacheManifest(dir).version).toBe(first.version);
      writeFileSync(join(dir, "index.html"), "<html lang>");
      expect(precacheManifest(dir).version).not.toBe(first.version);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
