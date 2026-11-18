import { expect, test } from "vitest";
import { clientFromEnv, createMeridianClient, MeridianError, retryDelayMs, type FetchLike } from "./client";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<Response | (() => Response)>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)] as Response | (() => Response);
    return typeof r === "function" ? r() : r;
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("sends the bearer token and builds query strings", async () => {
  const { fetch, calls } = fakeFetch([json({ months: [1, 2], vibes: [], cities: [] })]);
  const client = createMeridianClient({ baseUrl: "https://m.example/", token: "secret", fetch });
  await client.seasonal({ months: [1, 2], vibe: ["coast", "tropical-coast"], profile: "surf", limit: 25 });
  const call = calls[0] as Call;
  expect(call.url).toBe("https://m.example/api/atlas/seasonal?months=1%2C2&vibe=coast%2Ctropical-coast&profile=surf&limit=25");
  expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  expect(call.init.method).toBe("GET");
  expect(call.init.body).toBeUndefined();
});

test("posts JSON bodies and omits empty query params", async () => {
  const { fetch, calls } = fakeFetch([json({ entries: [], unresolved: [] }), json({ today: "2026-11-18" })]);
  const client = createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch });
  await client.upsertWishlist([{ place: { iata: "LIS" } }]);
  await client.context();
  const first = calls[0] as Call;
  expect(first.url).toBe("https://m.example/api/atlas/wishlist");
  expect(first.init.method).toBe("POST");
  expect((first.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  expect(JSON.parse(first.init.body as string)).toEqual({ entries: [{ place: { iata: "LIS" } }] });
  expect((calls[1] as Call).url).toBe("https://m.example/api/atlas/context");
});

test("uses the documented paths and methods for each endpoint", async () => {
  const { fetch, calls } = fakeFetch([() => json({})]);
  const client = createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch });
  await client.health();
  await client.getConfig();
  await client.patchConfig({ hardFilters: { maxStops: 1 } });
  await client.removeWishlist("lisbon-portugal");
  await client.runs(5);
  await client.fares("MAD-LIS");
  await client.importLegacy({});
  expect(calls.map((c) => `${c.init.method} ${c.url.replace("https://m.example", "")}`)).toEqual([
    "GET /api/health",
    "GET /api/atlas/config",
    "PATCH /api/atlas/config",
    "DELETE /api/atlas/wishlist/lisbon-portugal",
    "GET /api/atlas/runs?limit=5",
    "GET /api/atlas/fares?route=MAD-LIS",
    "POST /api/atlas/import"
  ]);
});

test("maps non-2xx answers to MeridianError with status and body", async () => {
  const { fetch } = fakeFetch([json({ error: "bad input", issues: ["origin"] }, 400)]);
  const client = createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch });
  let caught: unknown;
  try {
    await client.scan({ mode: "scheduled", origin: "MAD", flights: [], annotations: [] });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MeridianError);
  const err = caught as MeridianError;
  expect(err.status).toBe(400);
  expect(err.body).toEqual({ error: "bad input", issues: ["origin"] });
  expect(err.message).toContain("400 bad input");
});

test("keeps a non-JSON error body as text", async () => {
  const { fetch } = fakeFetch([new Response("Bad gateway", { status: 502 })]);
  const client = createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch });
  const err = (await client.runs().catch((e) => e)) as MeridianError;
  expect(err.status).toBe(502);
  expect(err.body).toBe("Bad gateway");
});

test("retries once on 429 after the server's retry-after", async () => {
  const waits: number[] = [];
  const { fetch, calls } = fakeFetch([json({ error: "slow down" }, 429, { "retry-after": "3" }), json({ runs: [] })]);
  const client = createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch, sleep: async (ms) => void waits.push(ms) });
  expect(await client.runs()).toEqual({ runs: [] });
  expect(calls.length).toBe(2);
  expect(waits).toEqual([3000]);
});

test("retries once on 503 with a 2 s default and caps long waits at 10 s", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const a = fakeFetch([json({ error: "down" }, 503), json({ runs: [] })]);
  await createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch: a.fetch, sleep }).runs();
  const b = fakeFetch([json({ error: "slow" }, 429, { "retry-after": "120" }), json({ runs: [] })]);
  await createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch: b.fetch, sleep }).runs();
  expect(waits).toEqual([2000, 10000]);
});

test("gives up after one retry and throws the second error", async () => {
  const { fetch, calls } = fakeFetch([json({ error: "slow" }, 429), json({ error: "still slow" }, 429)]);
  const client = createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch, sleep: async () => {} });
  const err = (await client.runs().catch((e) => e)) as MeridianError;
  expect(err.status).toBe(429);
  expect(err.message).toContain("still slow");
  expect(calls.length).toBe(2);
});

test("does not retry other errors", async () => {
  const { fetch, calls } = fakeFetch([json({ error: "nope" }, 500)]);
  const client = createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch, sleep: async () => {} });
  await client.runs().catch(() => undefined);
  expect(calls.length).toBe(1);
});

test("retryDelayMs reads the header, an HTTP date, the body, then the default", () => {
  expect(retryDelayMs(new Response(null, { headers: { "retry-after": "4" } }), null)).toBe(4000);
  const now = Date.parse("2026-11-18T10:00:00Z");
  expect(retryDelayMs(new Response(null, { headers: { "retry-after": "Wed, 18 Nov 2026 10:00:05 GMT" } }), null, now)).toBe(5000);
  expect(retryDelayMs(new Response(null), { retryAfter: 7 })).toBe(7000);
  expect(retryDelayMs(new Response(null), {})).toBe(2000);
});

test("clientFromEnv names the missing variables", () => {
  expect(() => clientFromEnv({}, {})).toThrow(/MERIDIAN_URL.*MERIDIAN_TOKEN/);
  expect(() => clientFromEnv({}, { MERIDIAN_URL: "https://m.example" })).toThrow(/MERIDIAN_TOKEN/);
  const client = clientFromEnv({}, { MERIDIAN_URL: "https://m.example/", MERIDIAN_TOKEN: "t" });
  expect(client.baseUrl).toBe("https://m.example");
  expect(clientFromEnv({ url: "https://o.example", token: "x" }, {}).baseUrl).toBe("https://o.example");
});

test("new endpoints use the right methods, paths and bodies", async () => {
  const { fetch, calls } = fakeFetch([json({ signals: [] }), json({ stored: 1, unresolved: [] }, 201), json({ run: {} }, 201), json({ entry: {} })]);
  const client = createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch });
  await client.signals("sal-cape-verde");
  await client.addSignals([{ place: { iata: "SAL" }, month: 12 }]);
  await client.fire({ mode: "research", text: "x" });
  await client.patchWishlist("sal-cape-verde", { watch: null, priority: 2 });
  expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
    "GET https://m.example/api/atlas/signals?cityId=sal-cape-verde",
    "POST https://m.example/api/atlas/signals",
    "POST https://m.example/api/atlas/run",
    "PATCH https://m.example/api/atlas/wishlist/sal-cape-verde"
  ]);
  expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ signals: [{ place: { iata: "SAL" }, month: 12 }] });
  expect(JSON.parse(calls[2]?.init.body as string)).toEqual({ mode: "research", text: "x" });
  expect(JSON.parse(calls[3]?.init.body as string)).toEqual({ watch: null, priority: 2 });
});

test("signals without a city sends no query string", async () => {
  const { fetch, calls } = fakeFetch([json({ signals: [] })]);
  await createMeridianClient({ baseUrl: "https://m.example", token: "t", fetch }).signals();
  expect(calls[0]?.url).toBe("https://m.example/api/atlas/signals");
});
