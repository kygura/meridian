import { describe, expect, it } from "vitest";
import { buildSharedTrip, publicTrip } from "./tripShare";
import { estimateLodging, median, pastNights } from "./lodgingEstimate";
import type { Journey, Trip, TripNode } from "../types";

const HOME: TripNode = { cityId: "lpa", name: "Las Palmas", iata: "LPA", lat: 28.1, lng: -15.43 };
const LIS: TripNode = { cityId: "lis", name: "Lisbon", iata: "LIS", lat: 38.72, lng: -9.14 };
const OPO: TripNode = { cityId: "opo", name: "Porto", iata: "OPO", lat: 41.15, lng: -8.61 };

const SECRETS = ["PNR-ABC123", "HOTEL-REF-77", "door code 1234", "meet Ana", "https://private.example/booking?token=s3cret", "RETURN-REF-9", "trip-secret-id"];

const trip: Trip = {
  id: "trip-secret-id",
  name: "Portugal",
  color: "#0f766e",
  status: "confirmed",
  year: 2027,
  travellers: 3,
  nodes: [
    {
      ...LIS,
      months: { start: 3, end: 3 },
      arrive: "2027-03-01",
      depart: "2027-03-05",
      lodging: {
        name: "Casa do Bairro",
        address: "Rua A 1",
        bookingRef: "HOTEL-REF-77",
        cost: { amount: 431, currency: "EUR" },
        link: "https://private.example/booking?token=s3cret",
      },
      activities: [{ id: "a1", title: "Tram 28", date: "2027-03-02", time: "10:30", note: "meet Ana", cost: { amount: 96, currency: "EUR" }, link: "https://private.example/booking?token=s3cret" }],
      notes: "door code 1234",
      travel: { fromCityId: "lpa", booked: { carrier: "TAP", number: "TP1117", reference: "PNR-ABC123", cost: { amount: 268, currency: "EUR" }, departAt: "2027-03-01T07:10", arriveAt: "2027-03-01T10:25" } },
    },
    { ...OPO, arrive: "2027-03-05", depart: "2027-03-08" },
  ],
  homeLeg: { fromCityId: "opo", booked: { reference: "RETURN-REF-9" } },
};

describe("shared trip", () => {
  it("shows the plan: stops, dates, the stay, how you get around, day by day", () => {
    const s = buildSharedTrip(trip, HOME);
    expect(s).toMatchObject({ name: "Portugal", when: "Mar 2027", from: "Las Palmas" });
    expect(s.stops[0]).toEqual({ name: "Lisbon", arrive: "2027-03-01", depart: "2027-03-05", nights: 4, months: "Mar", stay: { name: "Casa do Bairro", address: "Rua A 1" }, activities: 1 });
    expect(s.legs.map((l) => `${l.from}>${l.to}:${l.mode}:${l.booked}`)).toEqual(["Las Palmas>Lisbon:flight:true", "Lisbon>Porto:train:false", "Porto>Las Palmas:flight:true"]);
    expect(s.legs[0]).toMatchObject({ carrier: "TAP", number: "TP1117", departAt: "2027-03-01T07:10", date: "2027-03-01" });
    expect(s.days[0].items.map((i) => i.title)).toContain("Check in: Casa do Bairro");
    expect(s.days.flatMap((d) => d.items).some((i) => i.title === "Tram 28")).toBe(true);
  });

  it("never carries booking references, prices, links, notes, the traveller count or the trip id", () => {
    const text = JSON.stringify(buildSharedTrip(trip, HOME));
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    for (const price of ["431", "268", "96"]) expect(text).not.toContain(price);
    expect(text).not.toMatch(/travellers|bookingRef|reference|cost|link|note/);
    const copy = JSON.stringify(publicTrip(trip));
    for (const secret of SECRETS) expect(copy).not.toContain(secret);
    expect(copy).not.toContain("travellers");
  });

  it("works for a seasonal trip with no itinerary", () => {
    const seasonal: Trip = { id: "x", name: "Winter sun", color: "#000", status: "draft", nodes: [{ ...LIS, months: { start: 11, end: 2 } }] };
    const s = buildSharedTrip(seasonal, null);
    expect(s.when).toBe("Nov–Feb · any year");
    expect(s.stops[0]).toEqual({ name: "Lisbon", months: "Nov–Feb", activities: 0 });
    expect(s.days).toEqual([]);
  });
});

describe("lodging estimate", () => {
  const stay = (cityId: string, arrive: string, depart: string, eur: number) => ({
    cityId,
    arrive,
    depart,
    lodging: { name: "x", cost: { amount: eur, currency: "EUR", eur, rateDate: arrive }, provenance: { source: "manual" as const, confidence: "high" as const } },
  });
  const journeys = [
    { stops: [stay("lis", "2025-03-01", "2025-03-05", 400), stay("opo", "2025-03-05", "2025-03-07", 120)] },
    { stops: [stay("lis", "2026-01-01", "2026-01-03", 300), { cityId: "fao", arrive: "2026-01-03", depart: "2026-01-04" }] },
  ] as unknown as Journey[];
  const country: Record<string, string> = { lis: "Portugal", opo: "Portugal", fao: "Portugal", mad: "Spain" };
  const countryOf = (id: string) => country[id];
  const past = pastNights(journeys);

  it("reads nightly prices from the journal only where a cost and nights exist", () => {
    expect(past).toEqual([
      { cityId: "lis", eurPerNight: 100 },
      { cityId: "opo", eurPerNight: 60 },
      { cityId: "lis", eurPerNight: 150 },
    ]);
    expect(median([100, 150])).toBe(125);
  });

  it("uses the same city's past stays first, and says so", () => {
    const e = estimateLodging({ cityId: "lis", name: "Lisbon" }, 4, past, countryOf)!;
    expect(e).toMatchObject({ eur: 500, scope: "city", stays: 2 });
    expect(e.method).toBe("Estimate: the median of what your 2 past stays in Lisbon cost per night (from your journal), times 4 nights.");
  });

  it("falls back to the country only with enough stays there", () => {
    const e = estimateLodging({ cityId: "fao", name: "Faro" }, 2, past, countryOf)!;
    expect(e).toMatchObject({ eur: 200, scope: "country", stays: 3 });
    expect(e.method).toMatch(/3 past stays in Portugal/);
  });

  it("gives no number without a real basis", () => {
    expect(estimateLodging({ cityId: "mad", name: "Madrid" }, 3, past, countryOf)).toBeNull();
    expect(estimateLodging({ cityId: "lis", name: "Lisbon" }, 0, past, countryOf)).toBeNull();
    expect(estimateLodging({ cityId: "lis", name: "Lisbon" }, 3, [], countryOf)).toBeNull();
    expect(estimateLodging({ cityId: "nowhere", name: "Nowhere" }, 3, past, countryOf)).toBeNull();
  });
});
