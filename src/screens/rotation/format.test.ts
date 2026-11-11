import { describe, expect, it } from "vitest";
import { parseHash, routePath } from "../../lib/router";
import { stayDatesText, costText } from "./format";
import { fromDraft } from "./StaySheet";
import { routeGeoJson, stopsGeoJson } from "./RotationMap";
import { rotationLegs, type RotationStay } from "../../lib/rotation";

const lisbon = { cityId: "lisbon-portugal", name: "Lisbon", country: "Portugal", iata: "LIS", lat: 38.72, lng: -9.14 };
const bangkok = { cityId: "bangkok-thailand", name: "Bangkok", country: "Thailand", iata: "BKK", lat: 13.75, lng: 100.5 };

describe("rotation route", () => {
  it("parses and prints #/rotation", () => {
    expect(parseHash("#/rotation")).toEqual({ view: "rotation" });
    expect(routePath({ view: "rotation" })).toBe("/rotation");
  });
});

describe("rotation copy", () => {
  it("writes dates and windows plainly", () => {
    expect(stayDatesText({ start: "2027-01-05", end: "2027-03-01" })).toBe("5 Jan – 1 Mar 2027 · 55 nights");
    expect(stayDatesText({ start: "2026-12-20", end: "2027-01-03" }, true)).toBe("20 Dec 2026 – 3 Jan 2027");
    expect(stayDatesText({ window: { from: "2027-03", to: "2027-04" } })).toBe("Mar–Apr 2027 (dates not fixed)");
    expect(stayDatesText({ window: { from: "2027-11", to: "2028-01" } }, true)).toBe("Nov 2027 – Jan 2028");
    expect(stayDatesText({})).toBe("No dates yet");
    expect(costText({ currency: "EUR", perMonth: 1200, months: 3, basis: "budget" })).toMatch(/1,200 a month over 3 months \(budget\)/);
  });
});

describe("stay form", () => {
  const draft = {
    place: lisbon,
    kind: "base" as const,
    status: "planned" as const,
    when: "dates" as const,
    start: "2027-01-01",
    end: "2027-03-01",
    from: "",
    to: "",
    minNights: "30",
    maxNights: "",
    budget: { amount: "1500", currency: "EUR" },
    rent: { amount: "", currency: "EUR" },
    lodgingName: "",
    lodgingAddress: "",
    lodgingLink: "",
    bookingRef: "",
    leadMin: "",
    leadMax: "10",
    locked: true,
    notes: "",
  };

  it("builds a stay and catches contradictions", () => {
    const s = fromDraft(draft, null) as RotationStay;
    expect(s).toMatchObject({ start: "2027-01-01", end: "2027-03-01", minNights: 30, locked: true, budgetMonthly: { amount: 1500, currency: "EUR" }, leadTime: { min: 10, max: 10 } });
    expect(fromDraft({ ...draft, end: "2026-12-01" }, null)).toBe("Move-out must be after move-in.");
    expect(fromDraft({ ...draft, place: null }, null)).toBe("Pick a city.");
    expect(fromDraft({ ...draft, lodgingLink: "javascript:alert(1)", lodgingName: "x" }, null)).toMatch(/http/);
    expect(fromDraft({ ...draft, when: "months", from: "2027-05", to: "2027-03" }, null)).toMatch(/before the first/);
  });
});

describe("rotation map data", () => {
  it("draws one line per move and one point per place", () => {
    const stays: RotationStay[] = [
      { id: "a", place: lisbon, kind: "base", status: "planned", start: "2027-01-01", end: "2027-03-01" },
      { id: "b", place: bangkok, kind: "base", status: "planned", start: "2027-03-01", end: "2027-05-01" },
      { id: "c", place: lisbon, kind: "base", status: "idea", start: "2027-06-01", end: "2027-07-01" },
    ];
    const route = routeGeoJson(rotationLegs(stays), []);
    expect(route.features).toHaveLength(1);
    const stops = stopsGeoJson(stays, "b");
    expect(stops.features.map((f) => f.properties!.name)).toEqual(["Lisbon", "Bangkok"]);
    expect(stops.features[1].properties!.current).toBe(true);
  });
});
