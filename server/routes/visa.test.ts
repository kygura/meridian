import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { loadCities, getCities } from "../lib/cities";
import { putStay } from "../lib/rotation";
import visa from "./visa";

const TOKEN = "test-token";
const app = new Hono();
app.route("/api/visa", visa);

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeAll(() => loadCities());

describe("visa routes", () => {
  let TMP: string;
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "meridian-visa-route-"));
    process.env.DATA_DIR = TMP;
    process.env.MERIDIAN_TOKEN = TOKEN;
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.MERIDIAN_TOKEN;
  });

  it("401s without the owner", async () => {
    expect((await req("GET", "/api/visa/settings", undefined, null)).status).toBe(401);
    expect((await req("PUT", "/api/visa/settings", { passports: [], residency: null, taxWatch: [] }, "wrong")).status).toBe(401);
    expect((await req("POST", "/api/visa/check", { stays: [] }, null)).status).toBe(401);
    expect((await req("GET", "/api/visa/days", undefined, null)).status).toBe(401);
  });

  it("saves passports, residency and watched countries, and refuses unknown codes", async () => {
    expect((await (await req("GET", "/api/visa/settings")).json()).settings).toEqual({ passports: [], residency: null, taxWatch: [] });
    const r = await req("PUT", "/api/visa/settings", { passports: [{ country: "US", expires: "2030-05-01" }, { country: "US" }], residency: "PT", taxWatch: ["ES", "PT", "ES"] });
    expect(r.status).toBe(200);
    const s = (await r.json()).settings;
    expect(s.passports).toEqual([{ country: "US", expires: "2030-05-01" }]);
    expect(s.taxWatch).toEqual(["ES"]);
    expect((await req("PUT", "/api/visa/settings", { passports: [{ country: "XX" }], residency: null, taxWatch: [] })).status).toBe(400);
    expect((await req("PUT", "/api/visa/settings", { passports: [{ country: "us" }], residency: null, taxWatch: [] })).status).toBe(400);
  });

  it("sends the browser only the owner's passport rows", async () => {
    await req("PUT", "/api/visa/settings", { passports: [{ country: "GB" }], residency: null, taxWatch: [] });
    const body = await (await req("GET", "/api/visa/data")).json();
    expect(Object.keys(body.data.matrix)).toEqual(["GB"]);
    expect(body.data.countries.TH.name).toBe("Thailand");
  });

  it("checks stays with the owner's passport, or one given", async () => {
    await req("PUT", "/api/visa/settings", { passports: [{ country: "US" }], residency: null, taxWatch: [] });
    const stays = [{ id: "a", country: "Portugal", start: "2027-01-01", end: "2027-04-15" }];
    const us = await (await req("POST", "/api/visa/check", { stays, today: "2026-11-10" })).json();
    expect(us.violations[0].key).toBe("schengen");
    const de = await (await req("POST", "/api/visa/check", { stays, passports: ["DE"], today: "2026-11-10" })).json();
    expect(de.violations).toEqual([]);
    expect((await req("POST", "/api/visa/check", { stays: [{ id: "a", country: "Portugal", start: "2027-01-01" }] })).status).toBe(400);
  });

  it("lists the rotation's committed stays as presence", async () => {
    const lisbon = getCities().find((c) => c.name === "Lisbon" && c.country === "Portugal")!;
    await putStay("s1", { place: { cityId: lisbon.id, name: "Lisbon", country: "Portugal", lat: lisbon.lat, lng: lisbon.lng }, kind: "base", status: "planned", start: "2027-01-01", end: "2027-02-01" } as never, undefined);
    const body = await (await req("GET", "/api/visa/days")).json();
    expect(body.stays).toEqual([expect.objectContaining({ id: "r:s1", country: "Portugal", source: "rotation", start: "2027-01-01", end: "2027-02-01" })]);
  });

  it("suggests buffers outside Schengen and border runs from a city", async () => {
    await req("PUT", "/api/visa/settings", { passports: [{ country: "US" }], residency: null, taxWatch: [] });
    const rome = getCities().find((c) => c.name === "Rome" && c.country === "Italy")!;
    const b = await (await req("POST", "/api/visa/buffers", { cityId: rome.id, start: "2027-04-01", nights: 60 })).json();
    expect(b.options.length).toBeGreaterThan(3);
    const countries = b.options.map((o: { place: { country: string } }) => o.place.country);
    expect(countries).not.toContain("France");
    expect(countries).not.toContain("Italy");
    const hanoi = getCities().find((c) => c.name === "Hanoi")!;
    const runs = await (await req("POST", "/api/visa/border-runs", { cityId: hanoi.id, date: "2027-01-10" })).json();
    expect(runs.options.length).toBeGreaterThan(0);
    expect(runs.options[0].place.country).not.toBe("Vietnam");
  });
});
