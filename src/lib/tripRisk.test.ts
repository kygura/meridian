import { describe, expect, it } from "vitest";
import { assessTrip, clusterIncidents, proximity, riskLevel, type RiskIncident } from "./tripRisk";
import { DEFAULT_DEPARTURE, tripRoute } from "./tripPlan";
import type { TripNode } from "../types";

const inc = (id: string, over: Partial<RiskIncident>): RiskIncident => ({
  id,
  kind: "advisory",
  label: id,
  lat: 0,
  lng: 0,
  severity: 1,
  ...over,
});

const node = (cityId: string, lat: number, lng: number, iata?: string): TripNode => ({ cityId, name: cityId, lat, lng, iata });

describe("clusterIncidents", () => {
  it("joins incidents in the same country, and neighbours across a border", () => {
    const list = [
      inc("a", { country: "Ukraine", lat: 48.5, lng: 36.5, kind: "conflict", severity: 3 }),
      inc("b", { country: "Ukraine", lat: 50.45, lng: 30.5 }),
      // ~ 450 km from Kyiv: linked by proximity though in another country.
      inc("c", { country: "Belarus", lat: 53.9, lng: 27.56 }),
      inc("far", { country: "Peru", lat: -12, lng: -77 }),
    ];
    const clusters = clusterIncidents(list);
    expect(clusters).toHaveLength(2);
    const ua = clusters[0];
    expect(ua.incidents.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
    expect(ua.countryNames).toEqual(["Ukraine", "Belarus"]);
    expect(ua.peak).toBe(3);
    expect(ua.weight).toBe(3.5);
    expect(ua.conflict).toBe(true);
  });

  it("caps the density bump at one level above the worst incident", () => {
    const many = Array.from({ length: 12 }, (_, i) => inc(`x${i}`, { country: "Chad", lat: 12 + i * 0.1, lng: 15 }));
    expect(clusterIncidents(many)[0].weight).toBe(2);
  });
});

describe("proximity and levels", () => {
  it("is full nearby, fades, and stops", () => {
    expect(proximity(100)).toBe(1);
    expect(proximity(500)).toBeGreaterThan(0.3);
    expect(proximity(500)).toBeLessThan(0.4);
    expect(proximity(2000)).toBe(0);
  });
  it("maps scores to levels", () => {
    expect(riskLevel(0.2)).toBe("low");
    expect(riskLevel(1)).toBe("watch");
    expect(riskLevel(2)).toBe("caution");
    expect(riskLevel(3)).toBe("avoid");
  });
});

describe("tripRoute", () => {
  const lisbon = node("lisbon-portugal", 38.72, -9.14, "LIS");
  const madrid = node("madrid-spain", 40.42, -3.7, "MAD");

  it("starts at LPA by default and flies home", () => {
    const r = tripRoute({ nodes: [lisbon, madrid] });
    expect(r.departure).toEqual(DEFAULT_DEPARTURE);
    expect(r.all.map((l) => l.index)).toEqual([-1, 0, -2]);
    expect(r.outbound!.from.iata).toBe("LPA");
    expect(r.inbound!.to.iata).toBe("LPA");
  });

  it("prices from the chosen departure", () => {
    const fromLpa = tripRoute({ nodes: [lisbon] });
    const fromMad = tripRoute({ nodes: [lisbon], departure: madrid });
    expect(fromMad.outbound!.km).toBeLessThan(fromLpa.outbound!.km);
    expect(fromMad.outbound!.cost).toBeLessThan(fromLpa.outbound!.cost);
  });

  it("skips the return when one-way, and legs that start or end at home", () => {
    expect(tripRoute({ nodes: [lisbon, madrid], returnHome: false }).inbound).toBeUndefined();
    const r = tripRoute({ nodes: [madrid, lisbon, madrid], departure: madrid });
    expect(r.outbound).toBeUndefined();
    expect(r.inbound).toBeUndefined();
    expect(tripRoute({ nodes: [] }).all).toEqual([]);
  });

  it("uses the user's home departure when the trip has none", () => {
    expect(tripRoute({ nodes: [lisbon] }, madrid).departure).toBe(madrid);
  });
});

describe("assessTrip", () => {
  const countries: Record<string, string> = {
    "las-palmas-spain": "Spain",
    "kyiv-ukraine": "Ukraine",
    "lviv-ukraine": "Ukraine",
    "lisbon-portugal": "Portugal",
    "bangkok-thailand": "Thailand",
  };
  const countryOf = (id: string) => countries[id];
  const war = inc("war", { kind: "conflict", country: "Ukraine", lat: 48.5, lng: 36.5, severity: 3 });

  it("flags a stop in an affected country even far from the incident", () => {
    const lviv = node("lviv-ukraine", 49.84, 24.03, "LWO");
    const trip = { nodes: [lviv] };
    const r = tripRoute(trip);
    const risk = assessTrip(trip, r.departure, r.all, [war], countryOf);
    const stop = risk.places.find((p) => p.role === 0)!;
    expect(stop.hits[0].inCountry).toBe(true);
    expect(stop.level).toBe("caution");
    expect(risk.level).toBe("caution");
    expect(risk.places[0].level).toBe("low");
  });

  it("is low for a trip far from every cluster", () => {
    const lisbon = node("lisbon-portugal", 38.72, -9.14, "LIS");
    const trip = { nodes: [lisbon] };
    const r = tripRoute(trip);
    const risk = assessTrip(trip, r.departure, r.all, [war], countryOf);
    expect(risk.level).toBe("low");
    expect(risk.clusters).toEqual([]);
  });

  it("drops seasonal hazards outside the trip's months", () => {
    const monsoon = inc("monsoon", { kind: "hazard", country: "Thailand", lat: 13.75, lng: 100.5, severity: 2, months: [8, 9] });
    const bkk = node("bangkok-thailand", 13.75, 100.5, "BKK");
    const winter = { nodes: [{ ...bkk, months: { start: 1, end: 2 } }] };
    const summer = { nodes: [{ ...bkk, months: { start: 8, end: 8 } }] };
    const at = (t: typeof winter) => {
      const r = tripRoute(t);
      return assessTrip(t, r.departure, r.all, [monsoon], countryOf);
    };
    expect(at(winter).level).toBe("low");
    expect(at(summer).level).toBe("caution");
  });

  it("flags a flight that passes over a conflict, not one that just lands there", () => {
    const warsaw = node("warsaw-poland", 52.23, 21.01, "WAW");
    const baku = node("baku-azerbaijan", 40.41, 49.87, "GYD");
    const kharkiv = node("kharkiv-ukraine", 49.99, 36.23, "HRK");
    const over = { nodes: [warsaw, baku] };
    const r = tripRoute(over, null);
    const risk = assessTrip(over, r.departure, r.all, [war], countryOf);
    const leg = risk.legs.find((l) => l.leg.index === 0)!;
    expect(leg.near).toHaveLength(1);
    expect(leg.level).toBe("caution");

    const into = { nodes: [warsaw, kharkiv] };
    const r2 = tripRoute(into, null);
    const risk2 = assessTrip(into, r2.departure, r2.all, [war], countryOf);
    expect(risk2.legs.every((l) => l.near.length === 0)).toBe(true);
    expect(risk2.level).toBe("avoid");
  });
});

describe("tripEntryChecks", async () => {
  const { tripEntryChecks } = await import("./tripRisk");
  const DEST = ["US", "FR", "ES", "TH", "BR"];
  const data = {
    version: 1,
    builtAt: "2026-11-10",
    sources: { requirements: { name: "Test data", url: "https://example.org", fetchedAt: "2026-11-10", licence: "test" } },
    countries: { US: { name: "United States" }, FR: { name: "France" }, ES: { name: "Spain" }, TH: { name: "Thailand" }, BR: { name: "Brazil" } },
    destinations: DEST,
    matrix: { US: "- vf90 vf90 vf60 vf90" },
    validity: {},
  };
  const country: Record<string, string> = { paris: "France", madrid: "Spain", bkk: "Thailand", rio: "Brazil" };
  const node = (cityId: string, arrive?: string, depart?: string, months?: { start: number; end: number }) => ({ cityId, name: cityId, lat: 0, lng: 0, arrive, depart, months });

  it("checks dated stops together and gives undated stops their entry rule", () => {
    const trip = { year: 2027, nodes: [node("paris", "2027-01-01", "2027-02-15"), node("madrid", "2027-02-15", "2027-04-05"), node("bkk", undefined, undefined, { start: 11, end: 12 })] };
    const r = tripEntryChecks(trip, data, ["US"], (id) => country[id]);
    expect(r.stops[0].verdict?.level).toBe("ok");
    // Paris and Madrid share the Schengen 90: Madrid goes over.
    expect(r.stops[1].verdict?.level).toBe("over");
    expect(r.check?.violations[0].key).toBe("schengen");
    expect(r.stops[2].verdict).toBeNull();
    // November 2027 is after Thailand's 15 September 2026 change: 30 days.
    expect(r.stops[2].rule?.limit).toEqual({ kind: "per-entry", days: 30 });
  });

  it("flags yellow fever on a stop after one in a risk country", () => {
    const trip = { year: 2027, nodes: [node("rio", "2027-01-01", "2027-01-20"), node("bkk", "2027-01-20", "2027-02-10")] };
    const r = tripEntryChecks(trip, data, ["US"], (id) => country[id]);
    expect(r.stops[1].verdict?.yellowFever?.triggeredBy).toBe("Brazil");
  });

  it("says nothing it cannot know without a passport", () => {
    const r = tripEntryChecks({ nodes: [node("bkk", undefined, undefined, { start: 1, end: 2 })] }, data, [], (id) => country[id]);
    expect(r.stops[0].rule).toBeNull();
  });
});
