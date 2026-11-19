import { beforeEach, describe, expect, it } from "vitest";
import { parseEcbDaily, resetEurRatesCache, toEur } from "./fx.js";
import { searchLinkFor } from "./searchLinks.js";
import { normalizeFlights } from "./service.js";
import type { AtlasFlight } from "./schemas.js";

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope><Cube><Cube time='2026-11-18'>
<Cube currency='USD' rate='1.0968'/><Cube currency='GBP' rate='0.83290'/>
</Cube></Cube></gesmes:Envelope>`;

const fakeFetch = (body: string, status = 200) => {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
};

const flight = (extra: Partial<AtlasFlight> = {}): AtlasFlight => ({
  id: "e1",
  source: "expedia",
  origin: "LPA",
  destination: "AGA",
  destinationName: "Agadir",
  departDate: "2027-01-15",
  returnDate: "2027-01-27",
  priceEur: null,
  stops: 1,
  travelHours: 2.7,
  bookingUrl: null,
  ...extra,
});

beforeEach(() => resetEurRatesCache());

describe("ECB rates", () => {
  it("reads the reference date and rates", () => {
    expect(parseEcbDaily(ECB_XML)).toEqual({ date: "2026-11-18", perEur: { USD: 1.0968, GBP: 0.8329 } });
    expect(parseEcbDaily("<html>maintenance</html>")).toBeNull();
  });

  it("converts to EUR at the published rate, and refuses a currency the ECB does not publish", () => {
    const rates = parseEcbDaily(ECB_XML)!;
    expect(toEur(209.3, "USD", rates)).toEqual({ eur: 190.83, rate: 1.0968 });
    expect(toEur(50, "eur", rates)).toEqual({ eur: 50, rate: 1 });
    expect(toEur(900, "MAD", rates)).toBeNull();
  });
});

describe("normalizeFlights", () => {
  it("prices a USD fare in EUR and records the rate it used", async () => {
    const { fn, calls } = fakeFetch(ECB_XML);
    const flights = [flight({ originalPrice: { amount: 209.3, currency: "USD" } })];
    await normalizeFlights(flights, { fetch: fn });
    expect(flights[0].priceEur).toBe(190.83);
    expect(flights[0].fx).toEqual({ currency: "USD", amount: 209.3, rate: 1.0968, date: "2026-11-18", source: "ECB" });
    expect(calls).toHaveLength(1);
  });

  it("leaves the fare without a EUR price, with a reason, when there is no rate", async () => {
    const { fn } = fakeFetch(ECB_XML);
    const flights = [flight({ originalPrice: { amount: 900, currency: "MAD" } })];
    await normalizeFlights(flights, { fetch: fn });
    expect(flights[0].priceEur).toBeNull();
    expect(flights[0].fxError).toBe("no ECB rate for MAD, so no EUR price");

    resetEurRatesCache();
    const down = fakeFetch("", 503);
    const again = [flight({ originalPrice: { amount: 209.3, currency: "USD" } })];
    await normalizeFlights(again, { fetch: down.fn });
    expect(again[0].priceEur).toBeNull();
    expect(again[0].fxError).toMatch(/^ECB rates unavailable \(ECB rates answered 503\)/);
  });

  it("does not fetch rates for EUR fares and keeps a caller's EUR price", async () => {
    const { fn, calls } = fakeFetch(ECB_XML);
    const flights = [flight({ priceEur: 120, originalPrice: { amount: 130, currency: "USD" } }), flight({ id: "e2", originalPrice: { amount: 80, currency: "EUR" } })];
    await normalizeFlights(flights, { fetch: fn });
    expect(flights[0].priceEur).toBe(120);
    expect(flights[0].fx).toBeUndefined();
    expect(flights[1].priceEur).toBe(80);
    expect(calls).toHaveLength(0);
  });

  it("adds a search link when the connector gave none, and marks which link is which", async () => {
    const flights = [flight({ priceEur: 100 }), flight({ id: "k1", source: "kiwi", priceEur: 90, bookingUrl: "https://www.kiwi.com/deep/abc" })];
    await normalizeFlights(flights);
    expect(flights[0].bookingUrl).toBe(
      "https://www.expedia.com/Flights-Search?trip=roundtrip&leg1=from:LPA,to:AGA,departure:1/15/2027TANYT&leg2=from:AGA,to:LPA,departure:1/27/2027TANYT&passengers=adults:1&options=cabinclass:economy&mode=search"
    );
    expect(flights[0].bookingUrlKind).toBe("search");
    expect(flights[1].bookingUrl).toBe("https://www.kiwi.com/deep/abc");
    expect(flights[1].bookingUrlKind).toBe("connector");
  });

  it("ignores conversion fields a caller tries to set", async () => {
    const flights = [flight({ priceEur: 100, fx: { currency: "USD", amount: 1, rate: 9, date: "2000-01-01", source: "ECB" }, fxError: "x", bookingUrl: "https://a.example/x", bookingUrlKind: "search" })];
    await normalizeFlights(flights);
    expect(flights[0].fx).toBeUndefined();
    expect(flights[0].fxError).toBeUndefined();
    expect(flights[0].bookingUrlKind).toBe("connector");
  });
});

describe("searchLinkFor", () => {
  it("falls back to a Google Flights search for other sources", () => {
    expect(searchLinkFor({ source: "lastminute", origin: "lpa", destination: "fue", departDate: "2026-12-10", returnDate: "2026-12-16" })).toBe(
      "https://www.google.com/travel/flights?q=Flights%20from%20LPA%20to%20FUE%20on%202026-12-10%20through%202026-12-16"
    );
  });
});
