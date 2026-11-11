import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { gateRoutes } from "../middleware/auth";
import { escapeHtml } from "../lib/sharePage";
import trips from "./trips";
import shared from "./shared";

const TOKEN = "test-token";

const app = new Hono();
gateRoutes(app);
app.route("/api/trips", trips);
app.route("/api/shared", shared);

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const pub = (path: string) => app.request(path);

const home = { cityId: "las-palmas-spain", name: "Las Palmas", iata: "LPA", lat: 28.1, lng: -15.43 };
const lisbon = { cityId: "lisbon-portugal", name: "Lisbon", iata: "LIS", lat: 38.72, lng: -9.14 };
const porto = { cityId: "porto-portugal", name: "Porto", iata: "OPO", lat: 41.15, lng: -8.61 };

const SECRETS = ["PNR-ABC123", "HOTEL-REF-77", "door code 1234", "meet Ana", "s3cret-token", "431"];

const itinerary = {
  name: "Portugal <script>alert(1)</script>",
  color: "#6d28d9",
  status: "confirmed",
  year: 2027,
  travellers: 2,
  nodes: [
    {
      ...lisbon,
      months: { start: 3, end: 3 },
      arrive: "2027-03-01",
      depart: "2027-03-05",
      lodging: { name: "Casa do Bairro", address: "Rua A 1", bookingRef: "HOTEL-REF-77", cost: { amount: 431, currency: "EUR" }, link: "https://example.com/b?t=s3cret-token" },
      activities: [{ id: "a1", title: "Tram 28", date: "2027-03-02", time: "10:30", note: "meet Ana" }],
      notes: "door code 1234",
      travel: { fromCityId: "las-palmas-spain", booked: { carrier: "TAP", number: "TP1117", reference: "PNR-ABC123", departAt: "2027-03-01T07:10", arriveAt: "2027-03-01T10:25" } },
    },
    { ...porto, arrive: "2027-03-05", depart: "2027-03-08", travel: { fromCityId: "lisbon-portugal", mode: "train" } },
  ],
};

describe("trip itinerary, share links and calendar feed", () => {
  let TMP: string;
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "meridian-shared-"));
    process.env.DATA_DIR = TMP;
    process.env.MERIDIAN_TOKEN = TOKEN;
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.MERIDIAN_TOKEN;
  });

  async function link(kind: "page" | "calendar", tripId = "pt"): Promise<string> {
    const res = await req("POST", `/api/trips/${tripId}/links`, { kind, home });
    expect(res.status).toBe(200);
    return (await res.json()).link.token;
  }

  it("stores the itinerary fields and rejects malformed ones", async () => {
    const res = await req("PUT", "/api/trips/pt", itinerary);
    expect(res.status).toBe(200);
    const { trip } = await res.json();
    expect(trip.travellers).toBe(2);
    expect(trip.nodes[0]).toMatchObject({ arrive: "2027-03-01", lodging: { bookingRef: "HOTEL-REF-77" }, notes: "door code 1234" });
    expect(trip.nodes[0].travel.booked.reference).toBe("PNR-ABC123");
    expect(trip.nodes[1].travel).toEqual({ fromCityId: "lisbon-portugal", mode: "train" });

    const bad = (patch: object) => req("PUT", "/api/trips/bad", { ...itinerary, nodes: [{ ...lisbon, ...patch }] });
    expect((await bad({ arrive: "2027-02-30" })).status).toBe(400);
    expect((await bad({ lodging: { name: "x", link: "javascript:alert(1)" } })).status).toBe(400);
    expect((await bad({ travel: { fromCityId: "x", mode: "rocket" } })).status).toBe(400);
    expect((await bad({ travel: { fromCityId: "x", booked: { departAt: "tomorrow" } } })).status).toBe(400);
    expect((await bad({ activities: [{ id: "a", title: "x", time: "25:00" }] })).status).toBe(400);
    expect((await req("PUT", "/api/trips/bad", { ...itinerary, travellers: 0 })).status).toBe(400);
  });

  it("still accepts a trip saved before itineraries existed", async () => {
    const old = { name: "Old", color: "#000", status: "draft", nodes: [{ ...lisbon, months: { start: 2, end: 3 } }] };
    const { trip } = await (await req("PUT", "/api/trips/old", old)).json();
    expect(trip.nodes[0]).toEqual({ ...lisbon, months: { start: 2, end: 3 } });
    const token = await link("page", "old");
    const data = await (await pub(`/api/shared/trip/${token}/data`)).json();
    expect(data.trip).toMatchObject({ name: "Old", when: "Feb–Mar · any year", days: [] });
  });

  it("only the owner can make, list or revoke links", async () => {
    await req("PUT", "/api/trips/pt", itinerary);
    expect((await req("POST", "/api/trips/pt/links", { kind: "page" }, null)).status).toBe(401);
    expect((await req("GET", "/api/trips/pt/links", undefined, "wrong")).status).toBe(401);
    expect((await req("DELETE", "/api/trips/pt/links/page", undefined, null)).status).toBe(401);
    expect((await req("POST", "/api/trips/pt/links", { kind: "everything" })).status).toBe(400);
    // A trip the server doesn't hold can't be linked.
    expect((await req("POST", "/api/trips/nope/links", { kind: "page" })).status).toBe(404);
  });

  it("serves a shared page without the journal token, and nothing private on it", async () => {
    await req("PUT", "/api/trips/pt", itinerary);
    const token = await link("page");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await (await req("GET", "/api/trips/pt/links")).json()).toMatchObject({ page: { token }, calendar: null });

    const page = await pub(`/api/shared/trip/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const html = await page.text();
    expect(html).toContain("Lisbon");
    expect(html).toContain("Casa do Bairro");
    expect(html).toContain("TAP TP1117");
    expect(html).toContain("Tram 28");
    expect(html).toContain("Train");
    // The trip's name is escaped, not executed.
    expect(html).toContain("Portugal &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    for (const s of SECRETS) expect(html).not.toContain(s);

    const json = await (await pub(`/api/shared/trip/${token}/data`)).text();
    for (const s of SECRETS) expect(json).not.toContain(s);
    expect(json).not.toMatch(/travellers|bookingRef|"reference"|"cost"|"notes"/);
  });

  it("serves the calendar feed by its own token, with zones applied and no references", async () => {
    await req("PUT", "/api/trips/pt", itinerary);
    const token = await link("calendar");
    const res = await pub(`/api/shared/calendar/${token}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    const ics = (await res.text()).replace(/\r\n /g, "");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:Flight LPA → LIS · TAP TP1117");
    expect(ics).toContain("SUMMARY:Train Lisbon → Porto (not booked)".replace("Lisbon → Porto", "LIS → OPO"));
    expect(ics).toContain("DTSTART;VALUE=DATE:20270301");
    for (const s of SECRETS) expect(ics).not.toContain(s);
  });

  it("keeps the two kinds of token apart", async () => {
    await req("PUT", "/api/trips/pt", itinerary);
    const page = await link("page");
    const cal = await link("calendar");
    expect((await pub(`/api/shared/calendar/${page}.ics`)).status).toBe(404);
    expect((await pub(`/api/shared/trip/${cal}`)).status).toBe(404);
    expect((await pub(`/api/shared/trip/${cal}/data`)).status).toBe(404);
  });

  it("404s for unknown, malformed, replaced and revoked tokens", async () => {
    await req("PUT", "/api/trips/pt", itinerary);
    expect((await pub("/api/shared/trip/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await pub("/api/shared/trip/short")).status).toBe(404);
    expect((await pub("/api/shared/trip/..%2F..%2Ftrips")).status).toBe(404);

    const first = await link("page");
    const second = await link("page"); // replaces the first
    expect(second).not.toBe(first);
    expect((await pub(`/api/shared/trip/${first}`)).status).toBe(404);
    expect((await pub(`/api/shared/trip/${second}`)).status).toBe(200);

    expect(await (await req("DELETE", "/api/trips/pt/links/page")).json()).toEqual({ revoked: true });
    const gone = await pub(`/api/shared/trip/${second}`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain("This link isn't available");
    expect(await (await req("DELETE", "/api/trips/pt/links/page")).json()).toEqual({ revoked: false });
  });

  it("drops a trip's links when the trip is deleted, and never exposes other trips", async () => {
    await req("PUT", "/api/trips/pt", itinerary);
    await req("PUT", "/api/trips/other", { name: "Secret plan", color: "#000", status: "draft", nodes: [porto] });
    const page = await link("page");
    const cal = await link("calendar");
    expect(await (await pub(`/api/shared/trip/${page}`)).text()).not.toContain("Secret plan");

    await req("DELETE", "/api/trips/pt");
    expect((await pub(`/api/shared/trip/${page}`)).status).toBe(404);
    expect((await pub(`/api/shared/calendar/${cal}.ics`)).status).toBe(404);
    // Re-creating the trip under the same id doesn't bring the old links back.
    await req("PUT", "/api/trips/pt", itinerary);
    expect((await pub(`/api/shared/trip/${page}`)).status).toBe(404);
  });

  it("escapes html", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});
