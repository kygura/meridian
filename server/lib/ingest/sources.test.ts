import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { loadCities } from "../cities";
import { nearestCityId } from "./geo";
import { parsePhotos } from "./photos";
import { parseTimeline } from "./timeline";

const FIX = join(__dirname, "..", "__fixtures__", "ingest");
const json = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf-8"));

const LIS = "lisbon-portugal";
const OPO = "porto-portugal";
const LON = "london-united-kingdom";

beforeAll(() => loadCities());

type Cand = { kind: string; payload: Record<string, unknown>; provenance: { source: string; sourceRef: string; confidence: string } };
const cands = (r: { candidates: unknown[] }) => r.candidates as Cand[];

describe("nearestCityId", () => {
  it("picks the nearest city within 50 km, else nothing", () => {
    expect(nearestCityId(38.72, -9.14)).toBe(LIS);
    expect(nearestCityId(41.15, -8.61)).toBe(OPO);
    expect(nearestCityId(64.7, -18.6)).toBeUndefined();
    expect(nearestCityId(0, -30)).toBeUndefined(); // mid-Atlantic
  });
});

describe("timeline: on-device shape", () => {
  it("keeps >= 1 night stays away from home, merging consecutive visits, inferring home", () => {
    const r = parseTimeline(json("timeline-ondevice.json"));
    expect(r.homeCityId).toBe(LON);
    expect(r.homeInferred).toBe(true);
    expect(r.visits).toBe(8); // path/activity segments are not visits
    const c = cands(r);
    expect(c.map((x) => x.payload)).toEqual([
      { cityId: LIS, arrive: "2024-05-02", depart: "2024-05-06" }, // 4 visits merged
      { cityId: OPO, arrive: "2024-05-06", depart: "2024-05-09" },
      expect.objectContaining({ arrive: "2024-07-10", depart: "2024-07-13", cityHint: expect.stringContaining("(64.700, -18.600)") }),
    ]);
    // the Madrid day trip is not a stay; London is home
    for (const x of c) {
      expect(x.kind).toBe("stop");
      expect(x.provenance).toMatchObject({ source: "timeline", confidence: "medium" });
      expect(x.provenance.sourceRef).toMatch(/^[0-9a-f]{20}$/);
    }
    expect(new Set(c.map((x) => x.provenance.sourceRef)).size).toBe(3);
  });

  it("sourceRef is stable across runs; an explicit home overrides inference", () => {
    const a = cands(parseTimeline(json("timeline-ondevice.json")));
    const b = cands(parseTimeline(json("timeline-ondevice.json"), LON));
    expect(b.map((x) => x.provenance.sourceRef)).toEqual(a.map((x) => x.provenance.sourceRef));
    const asHome = parseTimeline(json("timeline-ondevice.json"), LIS);
    expect(asHome.homeInferred).toBe(false);
    expect(cands(asHome).some((x) => x.payload.cityId === LIS)).toBe(false);
    expect(cands(asHome).some((x) => x.payload.cityId === LON)).toBe(true); // London is now a (long) trip
  });
});

describe("timeline: older Takeout shape", () => {
  it("parses placeVisit E7 coordinates and durations", () => {
    const r = parseTimeline(json("timeline-takeout.json"), LON);
    expect(r.visits).toBe(5);
    expect(cands(r).map((x) => x.payload)).toEqual([{ cityId: "paris-france", arrive: "2023-09-14", depart: "2023-09-17" }]);
  });

  it("accepts epoch-ms timestamps and rejects junk without throwing", () => {
    const ms = (iso: string) => String(Date.parse(iso));
    const r = parseTimeline({
      timelineObjects: [
        { placeVisit: { location: { latitudeE7: 488566000, longitudeE7: 23522000 }, duration: { startTimestampMs: ms("2023-09-14T12:00:00Z"), endTimestampMs: ms("2023-09-16T12:00:00Z") } } },
        { placeVisit: { location: { latitudeE7: 9999999999, longitudeE7: 0 }, duration: { startTimestamp: "2023-09-14T12:00:00Z", endTimestamp: "2023-09-18T12:00:00Z" } } },
        "garbage",
        null,
      ],
    }, LON);
    expect(cands(r).map((x) => x.payload)).toEqual([{ cityId: "paris-france", arrive: "2023-09-14", depart: "2023-09-16" }]);
    expect(parseTimeline({ nothing: true }).errors).toEqual(["no semanticSegments or timelineObjects found"]);
    expect(parseTimeline("x").candidates).toEqual([]);
  });
});

describe("photos", () => {
  const photo = (day: string, lat: number, lng: number, hash: string, time = "12:00:00") => ({ timestamp: `${day}T${time}Z`, lat, lng, hash });

  it("groups by nearest city and runs of consecutive days into stop candidates", () => {
    const r = parsePhotos(
      [
        photo("2024-05-02", 38.72, -9.14, "h2"),
        photo("2024-05-02", 38.71, -9.13, "h1", "08:00:00"),
        photo("2024-05-03", 38.72, -9.14, "h3"),
        photo("2024-05-03", 41.15, -8.61, "p1"), // Porto, one day only
        photo("2024-05-08", 38.72, -9.14, "h9"), // Lisbon again, not consecutive
        photo("2024-05-03", 64.7, -18.6, "x"), // nowhere
      ],
    );
    expect(r.errors).toEqual(["1 photos had no city within 50 km and were skipped"]);
    const c = cands(r);
    expect(c.map((x) => x.payload)).toEqual([
      { cityId: LIS, arrive: "2024-05-02", depart: "2024-05-03" },
      { cityId: LIS, arrive: "2024-05-08", depart: "2024-05-08" },
      { cityId: OPO, arrive: "2024-05-03", depart: "2024-05-03" },
    ]);
    expect(c.map((x) => x.provenance.confidence)).toEqual(["medium", "low", "low"]);
    expect(c.every((x) => x.kind === "stop" && x.provenance.source === "photo" && /^[0-9a-f]{24}$/.test(x.provenance.sourceRef))).toBe(true);
    // re-running gives the same refs (first photo of the run = earliest, h1)
    expect(cands(parsePhotos([photo("2024-05-02", 38.71, -9.13, "h1", "08:00:00"), photo("2024-05-03", 38.72, -9.14, "h3")]))[0].provenance.sourceRef).toBe(c[0].provenance.sourceRef);
  });

  it("ignores home-city photos, accepts epoch timestamps, validates input", () => {
    const r = parsePhotos([photo("2024-05-02", 51.5, -0.12, "a"), { timestamp: Date.UTC(2024, 4, 2, 12) / 1000, lat: 41.15, lng: -8.61, hash: "b" }], LON);
    expect(r.excludedHome).toBe(1);
    expect(cands(r).map((x) => x.payload)).toEqual([{ cityId: OPO, arrive: "2024-05-02", depart: "2024-05-02" }]);

    expect(() => parsePhotos([{ timestamp: "2024-05-02T00:00:00Z", lat: 91, lng: 0, hash: "a" }])).toThrow();
    expect(() => parsePhotos([{ timestamp: "2024-05-02T00:00:00Z", lat: 0, lng: 181, hash: "a" }])).toThrow();
    expect(() => parsePhotos([{ timestamp: "2024-05-02T00:00:00Z", lat: 0, lng: 0, hash: "" }])).toThrow();
    expect(() => parsePhotos(new Array(5001).fill(photo("2024-05-02", 0, 0, "a")))).toThrow();
    expect(parsePhotos([photo("not-a-date", 38.7, -9.1, "a")]).errors).toEqual(["1 photos had an unreadable timestamp and were skipped"]);
  });
});

describe("timeline: unmatched places", () => {
  const visit = (lat: number, lng: number, from: string, to: string) => ({
    startTime: from,
    endTime: to,
    visit: { topCandidate: { placeLocation: { latLng: `${lat}°, ${lng}°` } } },
  });

  it("keeps an unlocated stay as a flagged-for-review candidate when no city resolves at all", () => {
    const r = parseTimeline({ semanticSegments: [visit(0.5, -30.5, "2024-05-02T10:00:00Z", "2024-05-06T10:00:00Z")] });
    expect(r.homeCityId).toBeUndefined();
    expect(r.homeInferred).toBe(false);
    // the only place is the most-nights place, i.e. home: nothing to propose
    expect(cands(r)).toHaveLength(0);
    const away = parseTimeline({ semanticSegments: [visit(0.5, -30.5, "2024-05-02T10:00:00Z", "2024-05-06T10:00:00Z")] }, LIS);
    expect(cands(away)).toHaveLength(1);
    expect(away.candidates[0]).toMatchObject({ payload: { cityHint: expect.stringContaining("(0.500, -30.500)") } });
  });

  it("an unmatched home (> 50 km from any city) is inferred by cell and excluded; other stays remain", () => {
    const r = parseTimeline({
      semanticSegments: [
        visit(0.5, -30.5, "2024-01-01T00:00:00Z", "2024-04-30T00:00:00Z"),
        visit(38.72, -9.14, "2024-05-02T10:00:00Z", "2024-05-06T10:00:00Z"),
        visit(0.5, -30.5, "2024-05-06T12:00:00Z", "2024-06-30T00:00:00Z"),
      ],
    });
    expect(r.homeCityId).toBeUndefined();
    expect(cands(r).map((c) => c.payload)).toEqual([{ cityId: LIS, arrive: "2024-05-02", depart: "2024-05-06" }]);
  });
});
