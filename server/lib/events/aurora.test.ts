import { describe, it, expect, beforeAll } from "vitest";
import type { City } from "../../../src/types";
import { getCities, loadCities } from "../cities";
import { auroraAlertEvent, auroraSeasonEvents, geomagneticLatitude, NORTH_MONTHS, parseKpForecast, peakKp, SOUTH_MONTHS } from "./aurora";
import { fixtureJson } from "../__fixtures__/liveEvents";

const NOW = new Date("2026-11-18T20:00:00Z");
const real = () => parseKpForecast(fixtureJson("events/swpc-kp-forecast.json"));
let cities: City[];
beforeAll(() => {
  loadCities();
  cities = getCities();
});

/** The recorded forecast with one predicted value raised, to test an alert; the real forecast peaked at Kp 4.67. */
function withStorm(kp: number, at = "2026-11-20T06:00:00") {
  const rows = (fixtureJson("events/swpc-kp-forecast.json") as { time_tag: string; kp: number; observed: string }[]).map((r) => (r.time_tag === at ? { ...r, kp, observed: "predicted" } : r));
  return parseKpForecast(rows);
}

describe("geomagnetic latitude (dipole, pole at 80.7 N 72.7 W)", () => {
  it("is 90 at the pole and near zero on the geomagnetic equator", () => {
    expect(geomagneticLatitude(80.7, -72.7)).toBeCloseTo(90, 5);
    expect(Math.abs(geomagneticLatitude(9.3, 107.3))).toBeLessThan(0.01);
  });

  it("puts northern Scandinavia, Iceland, Alaska and Canada above 62 and southern cities below", () => {
    expect(geomagneticLatitude(69.65, 18.96)).toBeGreaterThan(62); // Tromso
    expect(geomagneticLatitude(64.15, -21.9)).toBeGreaterThan(62); // Reykjavik
    expect(geomagneticLatitude(64.84, -147.72)).toBeGreaterThan(62); // Fairbanks
    expect(geomagneticLatitude(62.45, -114.37)).toBeGreaterThan(62); // Yellowknife
    expect(geomagneticLatitude(55.75, 37.62)).toBeLessThan(55); // Moscow
    expect(geomagneticLatitude(-33.87, 151.2)).toBeLessThan(-35); // Sydney
    expect(geomagneticLatitude(1.35, 103.8)).toBeLessThan(0);
  });

  it("is symmetric under a change of sign for a point opposite the pole", () => {
    expect(geomagneticLatitude(-80.7, 107.3)).toBeCloseTo(-90, 5);
  });
});

describe("aurora seasons", () => {
  it("makes one northern lights season over September to March for cities at 62 degrees or more", () => {
    const events = auroraSeasonEvents(cities);
    const north = events.find((e) => e.id === "aurora-season-north")!;
    expect(north).toMatchObject({ title: "Northern lights season", kind: "sky", month: 9, months: [9, 10, 11, 12, 1, 2, 3], recurring: true, source: "meridian", feed: "aurora" });
    expect(NORTH_MONTHS).toEqual([9, 10, 11, 12, 1, 2, 3]);
    expect(north.tags).toEqual(["aurora", "northern-lights", "sky"]);
    expect(north.cityIds.length).toBeGreaterThan(100);
    expect(north.cityIds).toContain("troms-norway");
    expect(north.cityIds).toContain("reykjav-k-iceland");
    expect(north.cityIds).not.toContain("london-united-kingdom");
    for (const id of north.cityIds) {
      const c = cities.find((x) => x.id === id)!;
      expect(geomagneticLatitude(c.lat, c.lng)).toBeGreaterThanOrEqual(62);
    }
  });

  it("makes a southern lights season over March to September only when a city qualifies", () => {
    const south: City = { id: "base-antarctica", name: "Base", country: "Antarctica", lat: -78, lng: 107, population: 1 };
    const events = auroraSeasonEvents([south]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "aurora-season-south", title: "Southern lights season", months: SOUTH_MONTHS });
    expect(SOUTH_MONTHS).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(auroraSeasonEvents(cities).some((e) => e.id === "aurora-season-south")).toBe(false);
  });

  it("makes nothing for cities that are all below 62 degrees", () => {
    expect(auroraSeasonEvents(cities.filter((c) => Math.abs(geomagneticLatitude(c.lat, c.lng)) < 62).slice(0, 50))).toEqual([]);
  });
});

describe("the Kp forecast (recorded NOAA SWPC response)", () => {
  it("reads time, Kp and observed status, taking times as UTC", () => {
    const pts = real();
    expect(pts).toHaveLength(81);
    expect(pts[0]).toMatchObject({ kp: 1.67, observed: "observed" });
    expect(pts[0]!.time.toISOString()).toBe("2026-11-11T00:00:00.000Z");
  });

  it("rejects a body that is not an array and skips rows that do not parse", () => {
    expect(() => parseKpForecast({})).toThrow(/unexpected SWPC response/);
    expect(parseKpForecast([{ time_tag: "nope", kp: 3 }, { time_tag: "2026-11-19T00:00:00", kp: "x" }, { time_tag: "2026-11-19T00:00:00", kp: 4, observed: "predicted" }])).toHaveLength(1);
  });

  it("finds the highest predicted or estimated Kp in the next 72 hours, not an observed one in the past", () => {
    const peak = peakKp(real(), NOW)!;
    expect(peak.kp).toBeCloseTo(4.67, 2);
    expect(peak.observed).toBe("estimated");
  });
});

describe("aurora alerts", () => {
  it("makes no alert while the predicted Kp stays under 5 (the recorded forecast)", () => {
    expect(auroraAlertEvent(real(), cities, NOW)).toBeUndefined();
  });

  it("makes a dated alert at Kp 5 or more on cities at 55 degrees geomagnetic latitude or more", () => {
    const alert = auroraAlertEvent(withStorm(6.33), cities, NOW)!;
    expect(alert).toMatchObject({ id: "aurora-alert-2026-11-20", title: "Aurora alert (Kp 6.3)", kind: "sky", date: "2026-11-20", month: 11, recurring: false, source: "noaa-swpc", feed: "aurora" });
    expect(alert.tags).toEqual(["aurora", "aurora-alert", "sky"]);
    expect(alert.cityIds).toContain("edinburgh-united-kingdom");
    expect(alert.cityIds).toContain("troms-norway");
    expect(alert.cityIds).not.toContain("madrid-spain");
    expect(alert.cityIds.length).toBeGreaterThan(cities.filter((c) => geomagneticLatitude(c.lat, c.lng) >= 62).length);
  });

  it("alerts at exactly Kp 5 and not at 4.99", () => {
    expect(auroraAlertEvent(withStorm(5), cities, NOW)).toBeDefined();
    expect(auroraAlertEvent(withStorm(4.99), cities, NOW)).toBeUndefined();
  });

  it("ignores a storm more than three days away or already observed", () => {
    const late = parseKpForecast([{ time_tag: "2026-11-22T00:00:00", kp: 7, observed: "predicted" }]);
    expect(auroraAlertEvent(late, cities, NOW)).toBeUndefined();
    const observed = parseKpForecast([{ time_tag: "2026-11-18T21:00:00", kp: 7, observed: "observed" }]);
    expect(auroraAlertEvent(observed, cities, NOW)).toBeUndefined();
  });
});
