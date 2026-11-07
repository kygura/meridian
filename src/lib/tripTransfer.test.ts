import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { Trip } from "../types";
import { mergeTrips, parseTripFile, serializeTrips } from "./tripTransfer";

const node = { cityId: "lima-peru", name: "Lima", iata: "LIM", lat: -12.048, lng: -77.05 };
const trip = (id: string, extra: Partial<Trip> = {}): Trip => ({
  id,
  name: id,
  color: "#0f766e",
  status: "draft",
  nodes: [node],
  ...extra,
});

describe("tripTransfer", () => {
  it("round-trips user trips and drops agent candidates and estimates", () => {
    const text = serializeTrips([
      trip("a", { estimate: { priceEstimate: 1, currency: "USD", dateRange: { start: "", end: "" } } }),
      trip("b", { origin: "agent" }),
    ]);
    const parsed = parseTripFile(text);
    expect(parsed.map((t) => t.id)).toEqual(["a"]);
    expect(parsed[0].estimate).toBeUndefined();
    expect(parsed[0].origin).toBe("manual");
  });

  it("keeps seasons, years and stop months; drops invalid ones", () => {
    const seasonal = trip("s", { season: { start: 2, end: 7 }, year: 2027, nodes: [{ ...node, months: { start: 2, end: 3 } }] });
    const [back] = parseTripFile(serializeTrips([seasonal]));
    expect(back).toMatchObject({ season: { start: 2, end: 7 }, year: 2027, nodes: [{ months: { start: 2, end: 3 } }] });
    const [loose] = parseTripFile(JSON.stringify([{ id: "x", name: "X", nodes: [node], season: { start: 0, end: 4 }, year: "2027" }]));
    expect(loose.season).toBeUndefined();
    expect(loose.year).toBeUndefined();
    expect(() => parseTripFile(JSON.stringify([{ id: "x", name: "X", nodes: [{ ...node, months: { start: 13, end: 1 } }] }]))).toThrow(/malformed/);
  });

  it("accepts a bare array and defaults bad status/color", () => {
    const [t] = parseTripFile(JSON.stringify([{ id: "x", name: "X", status: "nope", nodes: [node] }]));
    expect(t.status).toBe("draft");
    expect(t.color).toMatch(/^#/);
  });

  it("rejects non-JSON, foreign files and malformed trips", () => {
    expect(() => parseTripFile("{")).toThrow(/valid JSON/);
    expect(() => parseTripFile(JSON.stringify({ hello: 1 }))).toThrow(/Meridian/);
    expect(() => parseTripFile(JSON.stringify([{ id: "x", name: "X", nodes: [{ name: "no id" }] }]))).toThrow(/malformed/);
  });

  it("replaces same-id trips in place and appends new ones", () => {
    const { trips, added, replaced } = mergeTrips([trip("a"), trip("b")], [trip("b", { name: "B2" }), trip("c")]);
    expect(trips.map((t) => `${t.id}:${t.name}`)).toEqual(["a:a", "b:B2", "c:c"]);
    expect({ added, replaced }).toEqual({ added: 1, replaced: 1 });
  });

  it("parses the committed trip plans file", () => {
    const text = readFileSync(join(process.cwd(), "plans/trips.json"), "utf-8");
    const trips = parseTripFile(text);
    expect(trips).toHaveLength(3);
    for (const t of trips) {
      expect(t.nodes.length).toBeGreaterThan(2);
      expect(t.nodes.every((n) => n.months)).toBe(true); // seasonal: every stop placed in the year
      expect(t.name).not.toMatch(/20\d\d/); // and not tied to one
    }
  });
});
