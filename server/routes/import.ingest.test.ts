// Ingestion routes end to end: uploads (email, timeline, photos), PATCH city resolution,
// cluster merge, and the P3 definition of done (fixture mbox → one cluster → provenance everywhere).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import type { Journey } from "../../src/types";
import { loadCities } from "../lib/cities";
import { setFxFetch } from "../lib/fx";
import { createJourney, saveSettings } from "../lib/journal";
import { gateRoutes } from "../middleware/auth";
import importRoutes from "./import";

const TOKEN = "test-token";
const FIX = join(__dirname, "..", "lib", "__fixtures__", "ingest");
const fixture = (n: string) => readFileSync(join(FIX, n));
let TMP: string;

const app = new Hono();
gateRoutes(app);
app.route("/api/import", importRoutes);

const auth = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${TOKEN}`, ...extra });
function json(method: string, path: string, body?: unknown) {
  return app.request(path, { method, headers: auth({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
}
const upload = (path: string, body: BodyInit, type: string) => app.request(path, { method: "POST", headers: auth({ "Content-Type": type }), body });
const queue = async () => (await json("GET", "/api/import/queue")).json();

beforeAll(() => loadCities());

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-ingest-route-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
  setFxFetch(async () => ({ ok: true, status: 200, json: async () => ({ date: "2024-05-02", rates: { EUR: 0.9 } }) }));
});

afterEach(() => {
  setFxFetch();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.MERIDIAN_TOKEN;
});

describe("auth", () => {
  it("401 without token on the new routes", async () => {
    for (const [m, p] of [["POST", "/api/import/upload/email"], ["POST", "/api/import/upload/timeline"], ["POST", "/api/import/photos"], ["POST", "/api/import/cluster/x/merge"], ["PATCH", "/api/import/x"]]) {
      expect((await app.request(p, { method: m })).status, `${m} ${p}`).toBe(401);
    }
  });
});

describe("POST /upload/email, end to end (P3 definition of done)", () => {
  it("fixture mbox → one cluster 'Lisbon & Porto, May 2024' with 6 candidates; re-upload adds nothing; accept → provenance everywhere", async () => {
    const res = await upload("/api/import/upload/email", fixture("trip-lisbon-porto-2024-05.mbox"), "application/mbox");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 6, added: 6, duplicates: 0, unstructured: 1 });

    const q = await queue();
    expect(q.candidates).toHaveLength(6);
    expect(q.candidates.every((c: { flags?: string[] }) => !c.flags)).toBe(true);
    expect(q.clusters).toHaveLength(1);
    expect(q.clusters[0]).toMatchObject({ title: "Lisbon & Porto, May 2024", startDate: "2024-05-02", endDate: "2024-05-09", lowConfidence: false });
    expect(q.clusters[0].candidateIds).toHaveLength(6);

    const again = await upload("/api/import/upload/email", fixture("trip-lisbon-porto-2024-05.mbox"), "application/mbox");
    expect(await again.json()).toEqual({ received: 6, added: 0, duplicates: 6, unstructured: 1 });
    expect((await queue()).candidates).toHaveLength(6);

    const accepted = await json("POST", `/api/import/cluster/${q.clusters[0].id}/accept`);
    expect(accepted.status).toBe(201);
    const { journey } = (await accepted.json()) as { journey: Journey };
    expect(journey).toMatchObject({ status: "confirmed", title: "Lisbon & Porto, May 2024", startDate: "2024-05-02", endDate: "2024-05-09" });

    expect(journey.stops.map((s) => s.cityId)).toEqual(["lisbon-portugal", "porto-portugal"]);
    expect(journey.segments).toHaveLength(3);
    expect(journey.experiences).toHaveLength(1);
    const items = [
      ...journey.stops.map((s) => s.provenance),
      ...journey.stops.map((s) => s.lodging?.provenance),
      ...journey.segments.map((s) => s.provenance),
      ...journey.experiences.map((e) => e.provenance),
    ];
    expect(items).toHaveLength(2 + 2 + 3 + 1);
    for (const p of items) expect(p).toMatchObject({ source: "jsonld", sourceRef: expect.stringMatching(/^trip-.+@.+#0$/) });
    expect(journey.stops[0].lodging).toMatchObject({ name: "Hotel Avenida Palace", cost: { amount: 640, currency: "EUR", eur: 640 } });
    expect(journey.segments.map((s) => s.mode)).toEqual(["flight", "train", "flight"]);
    expect((await queue()).candidates).toEqual([]);
  });

  it("accepts a raw .eml (message/rfc822) and multipart/form-data field 'file'", async () => {
    const raw = await upload("/api/import/upload/email", fixture("flight.eml"), "message/rfc822");
    expect(await raw.json()).toMatchObject({ received: 1, added: 1, unstructured: 0 });

    const form = new FormData();
    form.set("file", new Blob([fixture("lodging.eml")], { type: "message/rfc822" }), "lodging.eml");
    const multi = await app.request("/api/import/upload/email", { method: "POST", headers: auth(), body: form });
    expect(multi.status).toBe(200);
    expect(await multi.json()).toMatchObject({ received: 1, added: 1 });

    const noFile = new FormData();
    noFile.set("other", "x");
    expect((await app.request("/api/import/upload/email", { method: "POST", headers: auth(), body: noFile })).status).toBe(400);
    expect((await upload("/api/import/upload/email", "", "text/plain")).status).toBe(400);
  });

  it("reports unstructured mail and unresolved cities (flagged, low), not guesses", async () => {
    const res = await upload("/api/import/upload/email", fixture("unstructured.eml"), "text/plain");
    expect(await res.json()).toEqual({ received: 0, added: 0, duplicates: 0, unstructured: 1 });
    expect((await queue()).candidates).toEqual([]);
  });

  it("413 above 25 MB by Content-Length", async () => {
    const res = await app.request("/api/import/upload/email", { method: "POST", headers: auth({ "Content-Type": "application/mbox", "Content-Length": String(26 * 1024 * 1024) }), body: "x" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_large", maxBytes: 25 * 1024 * 1024 });
  });

  it("other routes keep the 2 MB limit", async () => {
    const res = await app.request("/api/import", { method: "POST", headers: auth({ "Content-Type": "application/json", "Content-Length": String(3 * 1024 * 1024) }), body: "[]" });
    expect(res.status).toBe(413);
  });
});

describe("several sources / several e-mails for one trip", () => {
  const mbox = () => fixture("trip-lisbon-porto-2024-05.mbox").toString("latin1");
  const photos = (days: string[]) => days.map((d, i) => ({ timestamp: `${d}T12:00:00Z`, lat: 38.72, lng: -9.14, hash: `p${i}` }));

  it("a reminder e-mail (new Message-ID, same hotel and event) adds nothing and the cluster still accepts", async () => {
    await upload("/api/import/upload/email", Buffer.from(mbox(), "latin1"), "application/mbox");
    const again = mbox().replace("trip-hotel-lisbon@", "trip-hotel-lisbon-reminder@").replace("trip-event@", "trip-event-reminder@");
    expect(await (await upload("/api/import/upload/email", Buffer.from(again, "latin1"), "application/mbox")).json()).toMatchObject({ added: 0, duplicates: 6 });
    const q = await queue();
    expect(q.candidates).toHaveLength(6);
    expect((await json("POST", `/api/import/cluster/${q.clusters[0].id}/accept`)).status).toBe(201);
  });

  it("photo stop + hotel for the same days combine into one stop (cluster accept does not fail)", async () => {
    await saveSettings({ homeCityId: "london-united-kingdom" });
    await upload("/api/import/upload/email", fixture("trip-lisbon-porto-2024-05.mbox"), "application/mbox");
    expect((await json("POST", "/api/import/photos", photos(["2024-05-03", "2024-05-04", "2024-05-05"]))).status).toBe(200);
    const q = await queue();
    expect(q.clusters).toHaveLength(1);
    expect(q.clusters[0].candidateIds).toHaveLength(7);
    const res = await json("POST", `/api/import/cluster/${q.clusters[0].id}/accept`);
    expect(res.status).toBe(201);
    const { journey } = (await res.json()) as { journey: Journey };
    expect(journey.stops.map((s) => s.cityId)).toEqual(["lisbon-portugal", "porto-portugal"]);
    expect(journey.stops[0]).toMatchObject({ arrive: "2024-05-02", depart: "2024-05-06", lodging: { name: "Hotel Avenida Palace" } });
  });

  it("a stand-alone rental car (pick-up and drop-off in one city) accepts as a stay in that city", async () => {
    await upload("/api/import/upload/email", fixture("rentalcar.eml"), "message/rfc822");
    const q = await queue();
    const res = await json("POST", `/api/import/cluster/${q.clusters[0].id}/accept`);
    expect(res.status).toBe(201);
    const { journey } = (await res.json()) as { journey: Journey };
    expect(journey.stops).toHaveLength(1);
    expect(journey.stops[0]).toMatchObject({ cityId: "porto-portugal", arrive: "2024-05-07" });
    expect(journey.stops[0].depart > "2024-05-07").toBe(true);
  });

  it("a country given as ISO alpha-3 or native name does not leave the city unresolved", async () => {
    const ld = (c: string) => JSON.stringify({ "@type": "LodgingReservation", reservationFor: { "@type": "Hotel", name: "Hotel " + c, address: { addressLocality: "Madrid", addressCountry: c } }, checkinDate: "2024-05-02", checkoutDate: "2024-05-04" });
    const email = (c: string) => `Message-ID: <m-${c}@x>\nContent-Type: text/html; charset=utf-8\n\n<script type="application/ld+json">${ld(c)}</script>\n`;
    for (const c of ["ESP", "España"]) await upload("/api/import/upload/email", Buffer.from(email(c)), "message/rfc822");
    const cs = (await queue()).candidates;
    expect(cs).toHaveLength(2);
    for (const c of cs) expect(c).toMatchObject({ payload: { cityId: "madrid-spain" } });
  });
});

describe("POST /upload/timeline", () => {
  it("imports stays from both shapes, never stores the raw file", async () => {
    const a = await json("POST", "/api/import/upload/timeline", JSON.parse(fixture("timeline-ondevice.json").toString()));
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ received: 3, added: 3, duplicates: 0, visits: 8, homeCityId: "london-united-kingdom", homeInferred: true });
    // Re-upload is idempotent.
    expect(await (await json("POST", "/api/import/upload/timeline", JSON.parse(fixture("timeline-ondevice.json").toString()))).json()).toMatchObject({ added: 0, duplicates: 3 });

    const q = await queue();
    const unresolved = q.candidates.filter((c: { flags?: string[] }) => c.flags?.includes("unresolved-city"));
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].provenance).toMatchObject({ source: "timeline", confidence: "low" });

    await saveSettings({ homeCityId: "london-united-kingdom" });
    const b = await json("POST", "/api/import/upload/timeline", JSON.parse(fixture("timeline-takeout.json").toString()));
    expect(await b.json()).toMatchObject({ added: 1, homeInferred: false });

    expect((await json("POST", "/api/import/upload/timeline", "nope")).status).toBe(400);
    expect((await app.request("/api/import/upload/timeline", { method: "POST", headers: auth({ "Content-Type": "application/json" }), body: "{" })).status).toBe(400);
  });
});

describe("POST /photos", () => {
  const p = (day: string, lat: number, lng: number, hash: string) => ({ timestamp: `${day}T12:00:00Z`, lat, lng, hash });

  it("groups photos into stop candidates and dedupes on re-send", async () => {
    const body = [p("2024-05-02", 38.72, -9.14, "a"), p("2024-05-03", 38.72, -9.14, "b"), p("2024-05-03", 41.15, -8.61, "c")];
    const res = await json("POST", "/api/import/photos", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 2, added: 2, duplicates: 0, photos: 3, excludedHome: 0 });
    expect(await (await json("POST", "/api/import/photos", body)).json()).toMatchObject({ added: 0, duplicates: 2 });
    const q = await queue();
    expect(q.candidates.map((c: { payload: object; provenance: { source: string } }) => [c.payload, c.provenance.source])).toEqual(
      expect.arrayContaining([[{ cityId: "lisbon-portugal", arrive: "2024-05-02", depart: "2024-05-03" }, "photo"]]),
    );
  });

  it("validates ranges (400), array shape (400) and max 5000 (413)", async () => {
    expect((await json("POST", "/api/import/photos", [p("2024-05-02", 91, 0, "a")])).status).toBe(400);
    expect((await json("POST", "/api/import/photos", [{ lat: 1, lng: 1 }])).status).toBe(400);
    expect((await json("POST", "/api/import/photos", { a: 1 })).status).toBe(400);
    const big = await json("POST", "/api/import/photos", new Array(5001).fill(p("2024-05-02", 1, 1, "a")));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "too_many", max: 5000 });
  });
});

describe("PATCH /:id", () => {
  const unresolvedLodging = {
    kind: "lodging",
    provenance: { source: "gmail", sourceRef: "u1", confidence: "high" },
    payload: { name: "Mystery Inn", cityHint: "Nowhereville", arrive: "2024-05-02", depart: "2024-05-04" },
  };
  const unresolvedSeg = {
    kind: "segment",
    provenance: { source: "gmail", sourceRef: "u2", confidence: "medium" },
    payload: { mode: "train", cityHint: "Lisbon", toCityHint: "Nowhereville", departAt: "2024-05-04T10:00" },
  };

  it("sets the city, clears the unresolved flag and restores the declared confidence", async () => {
    await json("POST", "/api/import", [unresolvedLodging]);
    let c = (await queue()).candidates[0];
    expect(c).toMatchObject({ flags: ["unresolved-city"], provenance: { confidence: "low" } });
    expect(c.baseConfidence).toBeUndefined();

    expect((await json("POST", "/api/import/gmail:u1/accept")).status).toBe(409);
    const res = await json("PATCH", "/api/import/gmail:u1", { cityId: "porto-portugal" });
    expect(res.status).toBe(200);
    c = (await res.json()).candidate;
    expect(c.flags).toBeUndefined();
    expect(c.baseConfidence).toBeUndefined();
    expect(c).toMatchObject({ payload: { cityId: "porto-portugal", name: "Mystery Inn" }, provenance: { confidence: "high" } });
    expect((await json("POST", "/api/import/gmail:u1/accept")).status).toBe(201);
  });

  it("segments: from/to; stays flagged until every city is set", async () => {
    await json("POST", "/api/import", [unresolvedSeg]);
    const half = (await (await json("PATCH", "/api/import/gmail:u2", { fromCityId: "lisbon-portugal" })).json()).candidate;
    expect(half.flags).toEqual(["unresolved-city"]);
    expect(half.provenance.confidence).toBe("low");
    const done = (await (await json("PATCH", "/api/import/gmail:u2", { toCityId: "porto-portugal" })).json()).candidate;
    expect(done.flags).toBeUndefined();
    expect(done.provenance.confidence).toBe("medium");
  });

  it("validates: unknown city 400, wrong field 400, unknown key 400, empty 400, 404, 409", async () => {
    await json("POST", "/api/import", [unresolvedLodging, unresolvedSeg]);
    expect(await (await json("PATCH", "/api/import/gmail:u1", { cityId: "atlantis" })).json()).toMatchObject({ error: "unknown_city", field: "cityId" });
    expect((await json("PATCH", "/api/import/gmail:u1", { fromCityId: "porto-portugal" })).status).toBe(400);
    expect((await json("PATCH", "/api/import/gmail:u2", { cityId: "porto-portugal" })).status).toBe(400);
    expect((await json("PATCH", "/api/import/gmail:u1", { title: "x" })).status).toBe(400);
    expect((await json("PATCH", "/api/import/gmail:u1", {})).status).toBe(400);
    expect((await json("PATCH", "/api/import/nope", { cityId: "porto-portugal" })).status).toBe(404);
    await json("POST", "/api/import/gmail:u1/discard");
    expect((await json("PATCH", "/api/import/gmail:u1", { cityId: "porto-portugal" })).status).toBe(409);
  });
});

describe("POST /cluster/:clusterId/merge", () => {
  const trip = () => upload("/api/import/upload/email", fixture("trip-lisbon-porto-2024-05.mbox"), "application/mbox");

  it("merges every member into an existing journey", async () => {
    const j = await createJourney({ title: "Base", startDate: "2024-05-02", endDate: "2024-05-06", stops: [{ cityId: "lisbon-portugal", arrive: "2024-05-02", depart: "2024-05-06" }] });
    await trip();
    const [cluster] = (await queue()).clusters;
    const res = await json("POST", `/api/import/cluster/${cluster.id}/merge`, { journeyId: j.id });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { journey: Journey; merged: string[] };
    expect(out.merged).toHaveLength(6);
    expect(out.journey.id).toBe(j.id);
    expect(out.journey.segments).toHaveLength(3);
    expect(out.journey.experiences).toHaveLength(1);
    expect(out.journey).toMatchObject({ startDate: "2024-05-02", endDate: "2024-05-09" });
    expect(out.journey.stops.map((s) => s.lodging?.provenance.source)).toEqual(["jsonld", "jsonld"]);
    expect((await queue()).candidates).toEqual([]);
  });

  it("400 without journeyId, 404 for unknown journey or cluster", async () => {
    await trip();
    const [cluster] = (await queue()).clusters;
    expect((await json("POST", `/api/import/cluster/${cluster.id}/merge`, {})).status).toBe(400);
    expect((await json("POST", `/api/import/cluster/${cluster.id}/merge`, { journeyId: "nope" })).status).toBe(404);
    expect((await json("POST", "/api/import/cluster/cl_nope/merge", { journeyId: "x" })).status).toBe(404);
  });

  it("refuses a cluster with unresolved members before merging anything", async () => {
    const j = await createJourney({ title: "Base", startDate: "2024-05-01", endDate: "2024-05-10", stops: [{ cityId: "lisbon-portugal", arrive: "2024-05-01", depart: "2024-05-10" }] });
    await json("POST", "/api/import", [
      { kind: "experience", provenance: { source: "calendar", sourceRef: "a", confidence: "high" }, payload: { title: "A", cityHint: "Lisbon", date: "2024-05-03" } },
      { kind: "experience", provenance: { source: "calendar", sourceRef: "b", confidence: "high" }, payload: { title: "B", cityHint: "Nowhereville", date: "2024-05-04" } },
    ]);
    const [cluster] = (await queue()).clusters;
    const res = await json("POST", `/api/import/cluster/${cluster.id}/merge`, { journeyId: j.id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "unresolved", candidateIds: ["calendar:b"] });
    expect((await queue()).candidates).toHaveLength(2);
  });

  it("stops at the first error and reports what was merged and what remains", async () => {
    const j = await createJourney({ title: "Base", startDate: "2024-05-01", endDate: "2024-05-10", stops: [{ cityId: "lisbon-portugal", arrive: "2024-05-01", depart: "2024-05-10" }] });
    const exp = (ref: string, date: string, cost?: object) => ({
      kind: "experience",
      provenance: { source: "calendar", sourceRef: ref, confidence: "high" },
      payload: { title: ref, cityHint: "Lisbon", date, ...(cost ? { cost } : {}) },
    });
    await json("POST", "/api/import", [exp("a", "2024-05-03"), exp("b", "2024-05-04", { amount: 10, currency: "USD" }), exp("c", "2024-05-05")]);
    // USD has no rate: the second merge fails after the first succeeded.
    setFxFetch(async (url) => {
      if (url.includes("USD")) throw new Error("offline");
      return { ok: true, status: 200, json: async () => ({ date: "2024-05-02", rates: { EUR: 0.9 } }) };
    });
    const [cluster] = (await queue()).clusters;
    const res = await json("POST", `/api/import/cluster/${cluster.id}/merge`, { journeyId: j.id });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "fx_unavailable", merged: ["calendar:a"], remaining: ["calendar:b", "calendar:c"] });
    const q = await queue();
    expect(q.candidates.map((c: { id: string }) => c.id).sort()).toEqual(["calendar:b", "calendar:c"]);
  });
});

describe("cancelled reservations", () => {
  const ld = (status?: string) =>
    JSON.stringify({ "@type": "EventReservation", ...(status ? { reservationStatus: status } : {}), reservationFor: { "@type": "Event", name: "Gig", startDate: "2024-05-04", location: { "@type": "Place", name: "Coliseu", address: { addressLocality: "Lisbon", addressCountry: "PT" } } } });
  const email = (id: string, status?: string) => Buffer.from(`Message-ID: <${id}@x>\nContent-Type: text/html; charset=utf-8\n\n<script type="application/ld+json">${ld(status)}</script>\n`);

  it("a later cancellation flags the pending confirmation cancelled and low", async () => {
    await upload("/api/import/upload/email", email("conf"), "message/rfc822");
    const res = await (await upload("/api/import/upload/email", email("cxl", "http://schema.org/ReservationCancelled"), "message/rfc822")).json();
    expect(res).toMatchObject({ added: 0, cancelled: 1 });
    const q = await queue();
    expect(q.candidates).toHaveLength(1);
    expect(q.candidates[0]).toMatchObject({ flags: ["cancelled"], provenance: { confidence: "low" } });
  });
});
