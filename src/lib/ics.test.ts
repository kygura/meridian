import { describe, expect, it } from "vitest";
import { icsEscape, icsFileName, icsFold, tripToIcs } from "./ics";
import { tripRoute } from "./legs";
import { isLocalDateTime, offsetLabel, zonedToUtc } from "./zoned";
import type { Trip, TripNode } from "../types";

const HOME: TripNode = { cityId: "lpa", name: "Las Palmas", iata: "LPA", lat: 28.1, lng: -15.43 };
const LIS: TripNode = { cityId: "lis", name: "Lisbon", iata: "LIS", lat: 38.72, lng: -9.14 };
const NYC: TripNode = { cityId: "nyc", name: "New York", iata: "JFK", lat: 40.7, lng: -74 };
const ZONES: Record<string, string> = { lpa: "Atlantic/Canary", lis: "Europe/Lisbon", nyc: "America/New_York" };
const zoneOf = (id: string) => ZONES[id];
const NOW = new Date("2026-11-10T12:00:00Z");

const trip: Trip = {
  id: "t1",
  name: "Lisbon; then New York",
  color: "#0f766e",
  status: "confirmed",
  year: 2027,
  nodes: [
    {
      ...LIS,
      arrive: "2027-07-01",
      depart: "2027-07-05",
      lodging: { name: "Casa do Bairro", address: "Rua A 1, Lisboa", bookingRef: "HOTEL-REF-77", cost: { amount: 400, currency: "EUR" } },
      activities: [
        { id: "a1", title: "Tram 28", date: "2027-07-02", time: "10:30", note: "meet Ana, code 4411" },
        { id: "a2", title: "Beach day", date: "2027-07-03" },
      ],
      notes: "door code 1234",
      travel: { fromCityId: "lpa", booked: { carrier: "TAP", number: "TP1117", reference: "PNR-ABC123", departAt: "2027-07-01T07:10", arriveAt: "2027-07-01T10:25" } },
    },
    { ...NYC, arrive: "2027-07-05", depart: "2027-07-09", travel: { fromCityId: "lis", booked: { departAt: "2027-07-05T17:00", arriveAt: "2027-07-05T20:00" } } },
  ],
};
const route = tripRoute(trip, HOME);
const ics = (opts = {}) => tripToIcs(trip, route, { zoneOf, now: NOW, ...opts });
const unfold = (s: string) => s.replace(/\r\n /g, "");
const event = (text: string, uid: string) => {
  const blocks = unfold(text).split("BEGIN:VEVENT").slice(1);
  const b = blocks.find((x) => x.includes(`UID:${uid}@meridian`));
  if (!b) throw new Error(`no event ${uid}`);
  return b;
};

describe("zoned times", () => {
  it("turns a local time into the right instant, summer and winter", () => {
    expect(zonedToUtc("2027-07-01T10:25", "Europe/Lisbon")?.toISOString()).toBe("2027-07-01T09:25:00.000Z");
    expect(zonedToUtc("2027-01-15T10:25", "Europe/Lisbon")?.toISOString()).toBe("2027-01-15T10:25:00.000Z");
    expect(zonedToUtc("2027-07-05T20:00", "America/New_York")?.toISOString()).toBe("2027-07-06T00:00:00.000Z");
    expect(zonedToUtc("2027-03-01T09:00", "Asia/Kolkata")?.toISOString()).toBe("2027-03-01T03:30:00.000Z");
  });

  it("refuses what it can't place", () => {
    expect(zonedToUtc("2027-07-01T10:25", undefined)).toBeNull();
    expect(zonedToUtc("2027-07-01T10:25", "Mars/Olympus")).toBeNull();
    expect(zonedToUtc("2027-07-01 10:25", "Europe/Lisbon")).toBeNull();
    expect(isLocalDateTime("2027-02-30T10:00")).toBe(false);
  });

  it("labels offsets", () => {
    expect(offsetLabel(new Date("2027-07-01T00:00:00Z"), "Europe/Lisbon")).toBe("UTC+1");
    expect(offsetLabel(new Date("2027-01-01T00:00:00Z"), "Europe/Lisbon")).toBe("UTC");
    expect(offsetLabel(new Date("2027-01-01T00:00:00Z"), "Asia/Kolkata")).toBe("UTC+5:30");
    expect(offsetLabel(new Date("2027-01-01T00:00:00Z"), "America/New_York")).toBe("UTC−5");
  });
});

describe("tripToIcs", () => {
  it("is a well-formed calendar with CRLF lines no longer than 75 octets", () => {
    const text = ics({ includePrivate: true });
    expect(text.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of text.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(text.match(/BEGIN:VEVENT/g)?.length).toBe(text.match(/END:VEVENT/g)?.length);
    expect(unfold(text)).toContain("X-WR-CALNAME:Lisbon\\; then New York");
    expect(unfold(text)).toContain("DTSTAMP:20261110T120000Z");
  });

  it("writes stays as all-day spans covering the nights", () => {
    const stay = event(ics(), "t1-stay-0");
    expect(stay).toContain("DTSTART;VALUE=DATE:20270701");
    expect(stay).toContain("DTEND;VALUE=DATE:20270705");
    expect(stay).toContain("SUMMARY:Lisbon · Casa do Bairro");
    expect(stay).toContain("LOCATION:Rua A 1\\, Lisboa");
  });

  it("writes a booked leg as an instant, using each end's time zone", () => {
    const out = event(ics(), "t1-leg--1");
    // 07:10 in the Canaries (UTC+1 in July) and 10:25 in Lisbon (UTC+1).
    expect(out).toContain("DTSTART:20270701T061000Z");
    expect(out).toContain("DTEND:20270701T092500Z");
    expect(out).toContain("SUMMARY:Flight LPA → LIS · TAP TP1117");
    expect(out).toContain("Departs 07:10 Las Palmas time (UTC+1)");
    const atlantic = event(ics(), "t1-leg-0");
    expect(atlantic).toContain("DTSTART:20270705T160000Z");
    expect(atlantic).toContain("DTEND:20270706T000000Z");
    expect(atlantic).toContain("Arrives 20:00 New York time (UTC−4)");
  });

  it("writes an unbooked leg as an all-day event on the travel day, and says so", () => {
    const home = event(ics(), "t1-leg--2");
    expect(home).toContain("DTSTART;VALUE=DATE:20270709");
    expect(home).toContain("SUMMARY:Flight JFK → LPA (not booked)");
  });

  it("writes timed activities in the stop's zone and untimed ones all day", () => {
    expect(event(ics(), "t1-act-a1")).toContain("DTSTART:20270702T093000Z");
    const beach = event(ics(), "t1-act-a2");
    expect(beach).toContain("DTSTART;VALUE=DATE:20270703");
    expect(beach).toContain("DTEND;VALUE=DATE:20270704");
  });

  it("falls back to a floating local time when a city's zone isn't known", () => {
    const text = tripToIcs(trip, route, { now: NOW });
    const out = event(text, "t1-leg--1");
    expect(out).toContain("DTSTART:20270701T071000\r\n");
    expect(out).toContain("The time zone isn't known");
  });

  it("keeps booking references, prices and notes out of the feed", () => {
    const feed = unfold(ics({ includePrivate: false }));
    for (const secret of ["PNR-ABC123", "HOTEL-REF-77", "400 EUR", "door code 1234", "code 4411"]) expect(feed).not.toContain(secret);
    const own = unfold(ics({ includePrivate: true }));
    expect(own).toContain("Booking reference: PNR-ABC123");
    expect(own).toContain("Booking reference: HOTEL-REF-77");
    expect(own).toContain("Price: 400 EUR");
  });

  it("puts a month-only stop in as a span marked 'dates not set', and skips a trip with no year", () => {
    const seasonal: Trip = { ...trip, nodes: [{ ...LIS, months: { start: 11, end: 2 } }] };
    const text = tripToIcs(seasonal, tripRoute(seasonal, HOME), { now: NOW });
    const stay = event(text, "t1-stay-0");
    expect(stay).toContain("SUMMARY:Lisbon (dates not set)");
    expect(stay).toContain("DTSTART;VALUE=DATE:20271101");
    expect(stay).toContain("DTEND;VALUE=DATE:20280301");
    const anyYear: Trip = { ...seasonal, year: undefined };
    expect(tripToIcs(anyYear, tripRoute(anyYear, HOME), { now: NOW })).not.toContain("BEGIN:VEVENT");
  });
});

describe("ics text helpers", () => {
  it("escapes and folds", () => {
    expect(icsEscape("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const folded = icsFold(`SUMMARY:${"é".repeat(80)}`);
    expect(folded.split("\r\n ").join("")).toBe(`SUMMARY:${"é".repeat(80)}`);
    for (const l of folded.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });

  it("names the file after the trip", () => {
    expect(icsFileName("São Paulo → Río!")).toBe("sao-paulo-rio.ics");
    expect(icsFileName("  ")).toBe("trip.ics");
  });
});
