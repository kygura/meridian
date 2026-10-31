// Shared fixtures for the journal engine tests (fingerprint, replay, crowd,
// observed weather). No network: fakeFetch serves canned Open-Meteo and
// Nager.Date responses.

import { comfortScore, type MonthSeasonality } from "../seasonality.js";
import type { City, Journey, Money, Provenance } from "../../../src/types.js";

const city = (id: string, name: string, country: string, lat: number, lng: number, iata?: string): City => ({
  id,
  name,
  country,
  lat,
  lng,
  population: 1_000_000,
  iata,
});

export const CITIES: City[] = [
  city("lisbon-portugal", "Lisbon", "Portugal", 38.7223, -9.1393, "LIS"),
  city("porto-portugal", "Porto", "Portugal", 41.1579, -8.6291, "OPO"),
  city("seville-spain", "Seville", "Spain", 37.3891, -5.9845, "SVQ"),
  city("madrid-spain", "Madrid", "Spain", 40.4168, -3.7038, "MAD"),
  city("athens-greece", "Athens", "Greece", 37.9838, 23.7275, "ATH"),
  city("oslo-norway", "Oslo", "Norway", 59.9139, 10.7522, "OSL"),
  city("bangkok-thailand", "Bangkok", "Thailand", 13.7563, 100.5018, "BKK"),
  city("berlin-germany", "Berlin", "Germany", 52.52, 13.405, "BER"),
  city("nowhere-land", "Nowhere", "Atlantis", 0, 0), // no IATA, no seasonality
];

export const getCity = (id: string) => CITIES.find((c) => c.id === id);

const months = (temps: number[], precips: number[]): MonthSeasonality[] =>
  temps.map((t, i) => ({ tempC: t, precipMm: precips[i]!, score: comfortScore(t, precips[i]!) }));

/** Hand-made normals (Jan..Dec). Porto May is cooler than Lisbon; Seville May warmer. */
export const SEASONALITY: Record<string, MonthSeasonality[]> = {
  "lisbon-portugal": months([11.5, 12.5, 14.5, 15.5, 18.5, 21.5, 23.5, 24, 22.5, 19, 15, 12.5], [95, 80, 55, 65, 45, 15, 5, 5, 30, 90, 110, 120]),
  "porto-portugal": months([10, 11, 13, 14, 18, 19.5, 21, 21.5, 20, 17, 13, 11], [150, 120, 100, 110, 50, 30, 15, 20, 60, 140, 160, 180]),
  "seville-spain": months([11, 13, 16, 18, 22.5, 26.5, 29, 29, 25.5, 20.5, 15, 12], [60, 50, 45, 50, 20, 5, 0, 5, 25, 60, 80, 90]),
  "madrid-spain": months([6, 8, 11, 13, 17, 23, 26, 26, 21, 15, 10, 7], [35, 35, 30, 45, 45, 20, 10, 10, 25, 60, 55, 50]),
  "athens-greece": months([10, 11, 13, 17, 21.5, 26, 29, 29, 25, 20, 15.5, 12], [55, 45, 40, 25, 15, 5, 5, 5, 15, 45, 60, 70]),
  "oslo-norway": months([-3, -3, 0, 5, 11, 15, 17, 16, 11, 6, 1, -2], [55, 45, 45, 45, 55, 70, 80, 90, 85, 95, 85, 60]),
  "bangkok-thailand": months([26.6, 27.7, 29.6, 30.5, 30.2, 29.4, 28.6, 28.5, 28, 27.6, 27.5, 26.6], [24, 30, 46, 83, 158, 146, 195, 188, 292, 240, 71, 19]),
  "berlin-germany": months([1, 2, 5, 10, 14.5, 18, 20, 19.5, 15, 10, 5, 2], [45, 35, 40, 35, 55, 60, 70, 60, 45, 40, 45, 45]),
};

/** Fixture archive response for Lisbon 2024-05-10..2024-05-17 (8 days inclusive). */
export const LISBON_MAY_2024 = {
  latitude: 38.72,
  longitude: -9.14,
  daily: {
    time: ["2024-05-10", "2024-05-11", "2024-05-12", "2024-05-13", "2024-05-14", "2024-05-15", "2024-05-16", "2024-05-17"],
    temperature_2m_mean: [18.2, 18.9, 19.4, 20.1, 19.7, 18.8, 19.0, 19.3],
    precipitation_sum: [0, 0, 2.1, 0, 0, 0.4, 0, 0],
  },
};

/** Nager.Date fixture for 2024 (national holidays only matter; one regional entry to test filtering). */
export const HOLIDAYS_2024: Record<string, string[]> = {
  CN: ["2024-01-01", "2024-05-01", "2024-05-02", "2024-05-03", "2024-10-01", "2024-10-02", "2024-10-03"],
  US: ["2024-01-01", "2024-05-27", "2024-07-04", "2024-12-25"],
  DE: ["2024-01-01", "2024-05-01", "2024-05-09", "2024-05-20", "2024-12-25", "2024-12-26"],
  GB: ["2024-01-01", "2024-05-06", "2024-05-27", "2024-12-25", "2024-12-26"],
  FR: ["2024-01-01", "2024-05-01", "2024-05-08", "2024-05-09", "2024-05-20", "2024-12-25"],
  IT: ["2024-01-01", "2024-04-25", "2024-05-01", "2024-12-25", "2024-12-26"],
  CA: ["2024-01-01", "2024-05-20", "2024-07-01", "2024-12-25"],
  KR: ["2024-01-01", "2024-05-15", "2024-10-03", "2024-12-25"],
};

export function nagerBody(cc: string, year = 2024): unknown {
  const dates = year === 2024 ? (HOLIDAYS_2024[cc] ?? []) : [];
  return [
    ...dates.map((date) => ({ date, localName: "x", name: "x", countryCode: cc, global: true, types: ["Public"] })),
    { date: `${year}-06-15`, localName: "regional", name: "regional", countryCode: cc, global: false, counties: [`${cc}-XX`], types: ["Public"] },
  ];
}

export interface FakeFetchOptions {
  weather?: "ok" | "quota" | "network" | "timeout";
  nager?: "ok" | "fail";
}

/** Fake fetch routing by URL; records every URL it was asked for. */
export function fakeFetch(opts: FakeFetchOptions = {}) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("archive-api.open-meteo.com")) {
      const mode = opts.weather ?? "ok";
      if (mode === "network") throw new TypeError("fetch failed");
      if (mode === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (mode === "quota") return new Response(JSON.stringify({ error: true, reason: "Daily API request limit exceeded" }), { status: 429 });
      return new Response(JSON.stringify(LISBON_MAY_2024), { status: 200 });
    }
    const m = /PublicHolidays\/(\d{4})\/([A-Z]{2})/.exec(url);
    if (m) {
      if (opts.nager === "fail") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(nagerBody(m[2]!, Number(m[1]))), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

const prov: Provenance = { source: "manual", confidence: "high" };
const eur = (v: number, date = "2024-05-10"): Money => ({ amount: v, currency: "EUR", eur: v, rateDate: date });

/** A known Lisbon May-2024 journey: 7 nights, 2 people, full money. */
export function lisbonJourney(over: Partial<Journey> = {}): Journey {
  return {
    id: "j-lisbon-2024",
    title: "Lisbon, May 2024",
    status: "confirmed",
    startDate: "2024-05-10",
    endDate: "2024-05-17",
    stops: [
      {
        cityId: "lisbon-portugal",
        arrive: "2024-05-10",
        depart: "2024-05-17",
        rating: 5,
        lodging: { name: "Alfama flat", kind: "apartment", cost: eur(700), provenance: prov },
      },
    ],
    segments: [
      { mode: "flight", fromCityId: "berlin-germany", toCityId: "lisbon-portugal", departAt: "2024-05-10", cost: eur(180), provenance: prov },
      { mode: "flight", fromCityId: "lisbon-portugal", toCityId: "berlin-germany", departAt: "2024-05-17", cost: eur(160), provenance: prov },
    ],
    experiences: [
      { cityId: "lisbon-portugal", date: "2024-05-11", title: "Tasca dinner", kind: "food", cost: eur(60), provenance: prov },
      { cityId: "lisbon-portugal", date: "2024-05-13", title: "Sintra tour", kind: "tour", cost: eur(40), provenance: prov },
    ],
    rating: 5,
    tags: ["city", "food"],
    companions: 2,
    bookingIds: [],
    provenance: prov,
    createdAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
    ...over,
  };
}

export const NOW = new Date("2026-10-30T12:00:00.000Z");

// ── deps wired to the fixtures (in-memory caches, fake fetch) ──────────

import { fetchObservedWeather, type ObservedCache } from "../observedWeather.js";
import { computeCrowdProxy, type HolidayDeps } from "../crowd.js";
import type { FingerprintDeps } from "../fingerprint.js";
import type { ObservedConditions } from "../../../src/types.js";

export function memObservedCache(): ObservedCache & { data: Map<string, ObservedConditions> } {
  const data = new Map<string, ObservedConditions>();
  return { data, get: (k) => data.get(k), set: (k, v) => void data.set(k, v) };
}

export function memHolidayCache(): NonNullable<HolidayDeps["cache"]> {
  const data = new Map<string, string[]>();
  return { get: (y, cc) => data.get(`${y}-${cc}`), set: (y, cc, d) => void data.set(`${y}-${cc}`, d) };
}

export function fixtureFingerprintDeps(opts: FakeFetchOptions & { now?: Date } = {}) {
  const fetch = fakeFetch(opts);
  const now = () => opts.now ?? NOW;
  const seasonality = (id: string) => SEASONALITY[id];
  const holidayCache = memHolidayCache();
  const deps: FingerprintDeps = {
    observedWeather: (cityId, arrive, depart) =>
      fetchObservedWeather(cityId, arrive, depart, { fetch: fetch.fn, getCity, seasonality, now, cache: memObservedCache() }),
    crowd: (cityId, month, dateRange) =>
      computeCrowdProxy({ cityId, month, year: Number(dateRange.from.slice(0, 4)), dateRange }, { fetch: fetch.fn, cache: holidayCache, seasonality }),
    getCity,
    now,
  };
  return { deps, calls: fetch.calls };
}
