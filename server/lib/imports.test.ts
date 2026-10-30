import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Confidence, ImportCandidate } from "../../src/types";
import { loadCities } from "./cities";
import { setFxFetch } from "./fx";
import { JournalConflictError, createJourney, getJourney, saveSettings, updateJourney } from "./journal";
import {
  MAX_BATCH,
  accept,
  acceptCluster,
  addCandidates,
  clusterCandidates,
  discard,
  getQueue,
  merge,
} from "./imports";

const LON = "london-united-kingdom";
const LIS = "lisbon-portugal";
const OPO = "porto-portugal";
const NOW = new Date("2024-06-01T00:00:00Z");

let TMP: string;

beforeAll(() => loadCities());

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-imports-"));
  process.env.DATA_DIR = TMP;
  setFxFetch(async () => ({ ok: true, status: 200, json: async () => ({ date: "2024-05-02", rates: { EUR: 0.9 } }) }));
});

afterEach(() => {
  setFxFetch();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const prov = (source: string, sourceRef: string, confidence: Confidence = "high") => ({ source, sourceRef, confidence });

function seg(ref: string, from: string, to: string, departAt: string, extra: object = {}, source = "gmail") {
  return {
    kind: "segment",
    provenance: prov(source, ref),
    payload: { mode: "flight", iataHint: from, toIataHint: to, departAt, ...extra },
  };
}
function lodging(ref: string, cityHint: string, arrive: string, depart: string, name = "Hotel " + ref) {
  return { kind: "lodging", provenance: prov("gmail", ref), payload: { name, cityHint, arrive, depart, cost: { amount: 400, currency: "EUR" } } };
}
function experience(ref: string, cityHint: string, date: string, title = "Tour " + ref) {
  return { kind: "experience", provenance: prov("calendar", ref), payload: { title, cityHint, date } };
}

/** Lisbon & Porto, May 2024, flights from/to London. */
const TRIP = () => [
  seg("m1", "LHR", "LIS", "2024-05-02T09:00", { arriveAt: "2024-05-02T11:30", carrier: "TAP", number: "TP1023", cost: { amount: 120, currency: "EUR" } }),
  lodging("m2", "Lisbon", "2024-05-02", "2024-05-06"),
  lodging("m3", "Porto", "2024-05-06", "2024-05-09"),
  experience("c1", "Lisbon", "2024-05-03"),
  seg("m4", "OPO", "LHR", "2024-05-09T18:00", { carrier: "TAP", number: "TP1370" }),
];

describe("addCandidates validation", () => {
  it("reports invalid items by index without failing the batch", async () => {
    const bad = { kind: "segment", provenance: { source: "gmail", confidence: "high" }, payload: { departAt: "2024-05-02" } }; // no sourceRef
    const report = await addCandidates([TRIP()[0], bad, "nope", { ...TRIP()[1], payload: { name: "x" } }, TRIP()[1]], NOW);
    expect(report).toMatchObject({ received: 5, added: 2, duplicates: 0 });
    expect(report.errors).toHaveLength(3);
    expect(report.errors![0]).toMatch(/^#1: provenance\.sourceRef/);
    expect(report.errors![1]).toMatch(/^#2:/);
    expect(report.errors![2]).toMatch(/^#3: payload\.arrive/);
  });

  it("rejects bad enums, dates and money", async () => {
    const report = await addCandidates([
      { ...TRIP()[0], kind: "teleport" },
      seg("a", "LHR", "LIS", "02/05/2024"),
      seg("b", "LHR", "LIS", "2024-05-02", { cost: { amount: -1, currency: "EUR" } }),
      lodging("c", "Lisbon", "2024-05-06", "2024-05-02"),
    ]);
    expect(report.added).toBe(0);
    expect(report.errors).toHaveLength(4);
  });

  it("caps a call at 500", async () => {
    await expect(addCandidates(new Array(MAX_BATCH + 1).fill(TRIP()[0]))).rejects.toMatchObject({ status: 413 });
    const ok = await addCandidates(Array.from({ length: MAX_BATCH }, (_, i) => experience(`e${i}`, "Lisbon", "2024-05-03")));
    expect(ok).toMatchObject({ received: 500, added: 500 });
  });

  it("forces state/createdAt, defaults the id, strips server-owned fields", async () => {
    await addCandidates([{ ...TRIP()[1], state: "accepted", createdAt: "1999", clusterId: "x", flags: ["y"] }], NOW);
    const [c] = (await getQueue(NOW)).candidates;
    expect(c).toMatchObject({ id: "gmail:m2", state: "pending", createdAt: NOW.toISOString() });
    expect(c.flags).toBeUndefined();
  });
});

describe("dedupe", () => {
  it("dedupes on (source, sourceRef), within and across calls", async () => {
    expect(await addCandidates([TRIP()[1], TRIP()[1]])).toMatchObject({ added: 1, duplicates: 1 });
    expect(await addCandidates([TRIP()[1]])).toMatchObject({ added: 0, duplicates: 1 });
    // same ref, different source is a different record
    expect(await addCandidates([{ ...TRIP()[1], provenance: prov("jsonld", "m2") }])).toMatchObject({ added: 1 });
  });

  it("dedupes segments on carrier+number (uppercased) + departure date", async () => {
    await addCandidates([TRIP()[0]]);
    const again = seg("other-mail", "LHR", "LIS", "2024-05-02T09:05", { carrier: "tap", number: "tp1023" });
    expect(await addCandidates([again])).toMatchObject({ added: 0, duplicates: 1 });
    // another date is a different flight
    expect(await addCandidates([seg("m9", "LHR", "LIS", "2024-05-03", { carrier: "TAP", number: "TP1023" })])).toMatchObject({ added: 1 });
  });

  it("a discarded item does not reappear on re-upload", async () => {
    await addCandidates([TRIP()[1]]);
    await discard("gmail:m2");
    expect(await addCandidates([TRIP()[1]])).toMatchObject({ added: 0, duplicates: 1 });
    expect((await getQueue(NOW)).candidates).toHaveLength(0);
  });
});

describe("city resolution", () => {
  it("resolves via IATA, then city name, preferring exact names", async () => {
    await addCandidates([TRIP()[0], lodging("m3", "Porto, Portugal", "2024-05-06", "2024-05-09"), experience("c1", "Lisbon", "2024-05-03")]);
    const byId = Object.fromEntries((await getQueue(NOW)).candidates.map((c) => [c.id, c]));
    expect(byId["gmail:m1"].payload).toMatchObject({ fromCityId: LON, toCityId: LIS });
    expect(byId["gmail:m3"].payload.cityId).toBe(OPO);
    expect(byId["calendar:c1"].payload.cityId).toBe(LIS);
    expect(byId["gmail:m1"].flags).toBeUndefined();
  });

  it("a valid cityId wins over hints", async () => {
    await addCandidates([{ ...experience("c2", "Porto", "2024-05-03"), payload: { ...experience("c2", "Porto", "2024-05-03").payload, cityId: LIS } }]);
    expect((await getQueue(NOW)).candidates[0].payload.cityId).toBe(LIS);
  });

  it("unresolved city → confidence low + unresolved-city flag", async () => {
    await addCandidates([lodging("z", "Xyzzyville", "2024-05-02", "2024-05-03"), seg("y", "LHR", "ZZZ", "2024-05-02"), experience("n", "", "2024-05-03")]);
    const { candidates } = await getQueue(NOW);
    expect(candidates).toHaveLength(2); // the empty-hint experience failed validation instead
    for (const c of candidates) expect(c).toMatchObject({ flags: ["unresolved-city"], provenance: { confidence: "low" } });
  });
});

// ── clustering (pure) ───────────────────────────────────────────────

let n = 0;
function cand(kind: ImportCandidate["kind"], payload: ImportCandidate["payload"], confidence: Confidence = "high"): ImportCandidate {
  return { id: `c${++n}`, kind, payload, provenance: { source: "gmail", sourceRef: `r${n}`, confidence }, state: "pending", createdAt: NOW.toISOString() };
}
const exp = (date: string, cityId = LIS) => cand("experience", { cityId, date, title: "t" });
const flight = (from: string, to: string, departAt: string) => cand("segment", { fromCityId: from, toCityId: to, departAt });

describe("clusterCandidates", () => {
  it("splits on gaps greater than 2 days", () => {
    const clusters = clusterCandidates([exp("2024-05-01"), exp("2024-05-03"), exp("2024-05-06"), exp("2024-08-01")]);
    expect(clusters.map((c) => c.candidateIds.length)).toEqual([2, 1, 1]);
    expect(clusters[0]).toMatchObject({ startDate: "2024-05-01", endDate: "2024-05-03" });
  });

  it("measures the gap from the end of long items", () => {
    const stay = cand("lodging", { name: "H", cityId: LIS, arrive: "2024-05-01", depart: "2024-05-10" });
    expect(clusterCandidates([stay, exp("2024-05-03"), exp("2024-05-12")])).toHaveLength(1);
  });

  it("treats home segments as boundaries", () => {
    const items = [
      flight(LON, LIS, "2024-05-02"), exp("2024-05-03"), flight(LIS, LON, "2024-05-04"),
      flight(LON, OPO, "2024-05-05"), exp("2024-05-06", OPO), flight(OPO, LON, "2024-05-07"),
    ];
    expect(clusterCandidates(items, LON).map((c) => c.candidateIds.length)).toEqual([3, 3]);
    // without a home they are one trip (all gaps ≤ 2 days)
    expect(clusterCandidates(items)).toHaveLength(1);
  });

  it("orders a same-day departure from home before other items", () => {
    const e = exp("2024-05-02");
    const out = flight(LON, LIS, "2024-05-02");
    const clusters = clusterCandidates([e, out], LON);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].candidateIds).toEqual([out.id, e.id]);
  });

  it("titles from resolved cities (home excluded), flags low confidence, ids are stable", () => {
    const items = [flight(LON, LIS, "2024-05-02"), cand("lodging", { name: "H", cityId: OPO, arrive: "2024-05-04", depart: "2024-05-06" }, "low"), flight(OPO, LON, "2024-05-06")];
    const [c] = clusterCandidates(items, LON);
    expect(c).toMatchObject({ title: "Lisbon & Porto, May 2024", cityIds: [LIS, OPO], lowConfidence: true });
    expect(clusterCandidates([...items].reverse(), LON)[0].id).toBe(c.id);
    expect(clusterCandidates(items.slice(0, 2), LON)[0].id).not.toBe(c.id);
  });

  it("infers home from a round trip when none is configured", () => {
    const [c] = clusterCandidates([flight(LON, LIS, "2024-05-02"), flight(LIS, LON, "2024-05-04")]);
    expect(c.cityIds).toEqual([LIS]);
  });
});

// ── booking promotion (R4) ──────────────────────────────────────────

function booking(id: string, over: object = {}) {
  return {
    id, createdAt: "2024-01-01T00:00:00Z", status: "booked", source: "duffel-test", bookingReference: "ABC123", passengers: [],
    leg: { originIata: "LHR", destinationIata: "LIS", departureDate: "2024-05-02", returnDate: "2024-05-09" },
    totalAmount: 250, totalCurrency: "USD",
    offerSnapshot: { carrier: "TAP", segments: [
      { originIata: "LHR", destinationIata: "LIS", departingAt: "2024-05-02T08:00:00Z", carrier: "TAP" },
      { originIata: "LIS", destinationIata: "LHR", departingAt: "2024-05-09T18:00:00Z", carrier: "TAP" },
    ] },
    ...over,
  };
}

describe("booking promotion", () => {
  it("promotes past booked bookings once: one high-confidence candidate per leg", async () => {
    writeFileSync(join(TMP, "bookings.json"), JSON.stringify([
      booking("bkg_1"),
      booking("bkg_future", { leg: { originIata: "LHR", destinationIata: "LIS", departureDate: "2024-07-01" }, offerSnapshot: { carrier: "TAP", segments: [{ originIata: "LHR", destinationIata: "LIS", departingAt: "2024-07-01T08:00:00Z", carrier: "TAP" }] } }),
      booking("bkg_cancelled", { status: "cancelled" }),
    ]));
    const q1 = await getQueue(NOW);
    expect(q1.candidates).toHaveLength(2);
    const [out, back] = q1.candidates;
    expect(out).toMatchObject({
      id: "booking:bkg_1",
      kind: "segment",
      provenance: { source: "booking", sourceRef: "bkg_1", confidence: "high" },
      payload: { fromCityId: LON, toCityId: LIS, carrier: "TAP", bookingId: "bkg_1", cost: { amount: 250, currency: "USD" } },
    });
    expect(back.payload).toMatchObject({ fromCityId: LIS, toCityId: LON });
    expect(back.payload.cost).toBeUndefined();

    expect((await getQueue(NOW)).candidates).toHaveLength(2); // idempotent
    await discard(out.id);
    await discard(back.id);
    expect((await getQueue(NOW)).candidates).toHaveLength(0); // not resurrected
  });

  it("falls back to the booking leg when the snapshot has no airports", async () => {
    writeFileSync(join(TMP, "bookings.json"), JSON.stringify([booking("bkg_2", { offerSnapshot: { carrier: "TAP", segments: [] } })]));
    const { candidates } = await getQueue(NOW);
    expect(candidates.map((c) => c.payload.departAt)).toEqual(["2024-05-02", "2024-05-09"]);
  });

  it("is idle with no bookings file", async () => {
    expect(await getQueue(NOW)).toEqual({ candidates: [], clusters: [] });
  });
});

// ── review actions ──────────────────────────────────────────────────

describe("queue", () => {
  it("assigns clusterId to candidates", async () => {
    await addCandidates([...TRIP(), experience("far", "Lisbon", "2024-12-01")]);
    const q = await getQueue(NOW);
    expect(q.clusters).toHaveLength(2);
    for (const c of q.candidates) expect(q.clusters.find((cl) => cl.id === c.clusterId)?.candidateIds).toContain(c.id);
  });
});

describe("discard / accept / merge on one candidate", () => {
  it("discard removes from the queue; a second review is 409", async () => {
    await addCandidates([TRIP()[3]]);
    expect((await discard("calendar:c1")).state).toBe("discarded");
    expect((await getQueue(NOW)).candidates).toHaveLength(0);
    await expect(discard("calendar:c1")).rejects.toMatchObject({ status: 409 });
    await expect(accept("calendar:c1")).rejects.toMatchObject({ status: 409, body: { error: "not_pending" } });
    await expect(discard("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("accept creates a confirmed journey from the one candidate", async () => {
    await addCandidates([TRIP()[1]]);
    const j = await accept("gmail:m2", undefined, NOW);
    expect(j).toMatchObject({ status: "confirmed", startDate: "2024-05-02", endDate: "2024-05-06", title: "Lisbon, May 2024" });
    expect(j.stops).toHaveLength(1);
    expect(j.stops[0].lodging).toMatchObject({ name: "Hotel m2", cost: { amount: 400, currency: "EUR", eur: 400 } });
    expect(await getJourney(j.id)).toBeTruthy();
    expect((await getQueue(NOW)).candidates).toHaveLength(0);
  });

  it("accepting a lone segment derives a stop from its arrival city", async () => {
    await saveSettings({ homeCityId: LON });
    await addCandidates([TRIP()[0]]);
    const j = await accept("gmail:m1", undefined, NOW);
    expect(j.stops.map((s) => s.cityId)).toEqual([LIS]);
    expect(j.segments[0].cost).toMatchObject({ currency: "EUR", eur: 120 });
  });

  it("409 unresolved instead of guessing; the candidate stays pending", async () => {
    await addCandidates([lodging("z", "Xyzzyville", "2024-05-02", "2024-05-03")]);
    await expect(accept("gmail:z")).rejects.toMatchObject({ status: 409, body: { error: "unresolved", candidateIds: ["gmail:z"] } });
    expect((await getQueue(NOW)).candidates).toHaveLength(1);
  });

  it("releases the claim when the journey cannot be written", async () => {
    setFxFetch(async () => { throw new Error("offline"); });
    await addCandidates([seg("u", "LHR", "LIS", "2024-05-02", { cost: { amount: 10, currency: "USD" } })]);
    await expect(accept("gmail:u")).rejects.toThrow();
    expect((await getQueue(NOW)).candidates).toHaveLength(1);
  });

  async function base() {
    return createJourney({
      title: "Lisbon",
      startDate: "2024-05-02",
      endDate: "2024-05-06",
      stops: [{ cityId: LIS, arrive: "2024-05-02", depart: "2024-05-06" }],
    });
  }

  it("merge: experience → experiences, lodging → covering stop, segment extends dates", async () => {
    const j = await base();
    await addCandidates([experience("c1", "Lisbon", "2024-05-03"), lodging("m2", "Lisbon", "2024-05-02", "2024-05-06"), seg("m9", "LIS", "OPO", "2024-05-08")]);
    await merge("calendar:c1", j.id);
    await merge("gmail:m2", j.id);
    const merged = await merge("gmail:m9", j.id);
    expect(merged.experiences).toHaveLength(1);
    expect(merged.experiences[0].provenance).toMatchObject({ source: "calendar", sourceRef: "c1" });
    expect(merged.stops).toHaveLength(1);
    expect(merged.stops[0].lodging?.provenance.sourceRef).toBe("m2");
    expect(merged.segments).toHaveLength(1);
    expect(merged.endDate).toBe("2024-05-08");
    expect(merged.id).toBe(j.id);
    expect((await getQueue(NOW)).candidates).toHaveLength(0);
  });

  it("merge: a stop candidate is inserted in arrival order; a lodging elsewhere becomes a new stop", async () => {
    const j = await base();
    await addCandidates([lodging("m3", "Porto", "2024-05-06", "2024-05-09"), { kind: "stop", provenance: prov("timeline", "t1", "medium"), payload: { cityHint: "Faro", arrive: "2024-04-28", depart: "2024-05-02" } }]);
    await merge("gmail:m3", j.id);
    const merged = await merge("timeline:t1", j.id);
    expect(merged.stops.map((s) => s.cityId)).toEqual(["faro-portugal", LIS, OPO]);
    expect(merged.stops[2].lodging?.name).toBe("Hotel m3");
    expect(merged).toMatchObject({ startDate: "2024-04-28", endDate: "2024-05-09" });
  });

  it("merge: unknown journey is 404 and leaves the candidate pending; accept(id, journeyId) merges", async () => {
    await addCandidates([experience("c1", "Lisbon", "2024-05-03")]);
    await expect(merge("calendar:c1", "nope")).rejects.toMatchObject({ status: 404, body: { error: "journey_not_found" } });
    expect((await getQueue(NOW)).candidates).toHaveLength(1);
    const j = await base();
    expect((await accept("calendar:c1", j.id)).experiences).toHaveLength(1);
  });

  it("merge that fails journal validation is released", async () => {
    const j = await base();
    await addCandidates([{ kind: "stop", provenance: prov("timeline", "t2"), payload: { cityHint: "Porto", arrive: "2024-05-04", depart: "2024-05-05" } }]);
    await expect(merge("timeline:t2", j.id)).rejects.toThrow(); // overlaps the Lisbon stop
    expect((await getQueue(NOW)).candidates).toHaveLength(1);
  });
});

describe("acceptCluster", () => {
  it("builds one confirmed journey with provenance on every item", async () => {
    await saveSettings({ homeCityId: LON });
    await addCandidates([...TRIP(), experience("far", "Lisbon", "2024-12-01")], NOW);
    const q = await getQueue(NOW);
    const cluster = q.clusters.find((c) => c.title === "Lisbon & Porto, May 2024")!;
    expect(cluster.candidateIds).toHaveLength(5);

    const j = await acceptCluster(cluster.id, NOW);
    expect(j).toMatchObject({ status: "confirmed", title: "Lisbon & Porto, May 2024", startDate: "2024-05-02", endDate: "2024-05-09" });
    expect(j.provenance).toMatchObject({ source: "gmail", confidence: "high" });
    expect(j.stops.map((s) => [s.cityId, s.arrive, s.depart, s.lodging?.name])).toEqual([
      [LIS, "2024-05-02", "2024-05-06", "Hotel m2"],
      [OPO, "2024-05-06", "2024-05-09", "Hotel m3"],
    ]);
    expect(j.segments.map((s) => [s.fromCityId, s.toCityId])).toEqual([[LON, LIS], [OPO, LON]]);
    expect(j.experiences).toHaveLength(1);

    const sources = [
      ...j.segments.map((s) => s.provenance),
      ...j.stops.map((s) => s.lodging!.provenance),
      ...j.experiences.map((e) => e.provenance),
    ];
    expect(sources.map((p) => p.sourceRef).sort()).toEqual(["c1", "m1", "m2", "m3", "m4"]);
    for (const p of sources) expect(p).toMatchObject({ confidence: "high", importedAt: NOW.toISOString() });
    expect(j.segments[0].cost).toMatchObject({ eur: 120 });

    expect(await getJourney(j.id)).toBeTruthy();
    const after = await getQueue(NOW);
    expect(after.candidates.map((c) => c.id)).toEqual(["calendar:far"]);
    await expect(acceptCluster(cluster.id)).rejects.toMatchObject({ status: 404 });
  });

  it("derives stops from segment arrival cities when there are no stop/lodging candidates", async () => {
    await saveSettings({ homeCityId: LON });
    await addCandidates([
      seg("a", "LHR", "LIS", "2024-05-02T09:00", { arriveAt: "2024-05-02T11:30" }),
      seg("b", "LIS", "OPO", "2024-05-04T10:00"),
      seg("c", "OPO", "LHR", "2024-05-06T18:00"),
    ]);
    const [cl] = (await getQueue(NOW)).clusters;
    const j = await acceptCluster(cl.id);
    expect(j.stops.map((s) => [s.cityId, s.arrive, s.depart])).toEqual([
      [LIS, "2024-05-02", "2024-05-04"],
      [OPO, "2024-05-04", "2024-05-06"],
    ]);
  });

  it("lowest member confidence and dominant source become the journey provenance", async () => {
    await addCandidates([
      { ...TRIP()[1], provenance: prov("gmail", "m2", "medium") },
      { ...TRIP()[2], provenance: prov("gmail", "m3") },
      experience("c1", "Lisbon", "2024-05-03"),
    ]);
    const [cl] = (await getQueue(NOW)).clusters;
    const j = await acceptCluster(cl.id);
    expect(j.provenance).toMatchObject({ source: "gmail", confidence: "medium" });
  });

  it("409 unresolved lists the offending candidates and changes nothing", async () => {
    await addCandidates([TRIP()[1], lodging("bad", "Xyzzyville", "2024-05-03", "2024-05-04")]);
    const [cl] = (await getQueue(NOW)).clusters;
    expect(cl.lowConfidence).toBe(true);
    await expect(acceptCluster(cl.id)).rejects.toMatchObject({ status: 409, body: { error: "unresolved", candidateIds: ["gmail:bad"] } });
    expect((await getQueue(NOW)).candidates).toHaveLength(2);
  });
});

// ── review fixes ────────────────────────────────────────────────────

const PARIS = "paris-france";
const BER = "berlin-germany";

describe("concurrent journal writes", () => {
  const base = () => createJourney({ title: "Lisbon", startDate: "2024-05-02", endDate: "2024-05-06", stops: [{ cityId: LIS, arrive: "2024-05-02", depart: "2024-05-06" }] });

  it("two merges into one journey at once keep both candidates", async () => {
    const j = await base();
    await addCandidates([experience("a", "Lisbon", "2024-05-03"), experience("b", "Lisbon", "2024-05-04")]);
    await Promise.all([merge("calendar:a", j.id), merge("calendar:b", j.id)]);
    expect((await getJourney(j.id))!.experiences.map((e) => e.provenance.sourceRef).sort()).toEqual(["a", "b"]);
  });

  it("updateJourney with a stale ifUpdatedAt is refused and writes nothing", async () => {
    const j = await base();
    const input = { title: "Edited", startDate: j.startDate, endDate: j.endDate, stops: j.stops };
    await new Promise((r) => setTimeout(r, 5));
    await updateJourney(j.id, { ...input, title: "User edit" }); // bumps updatedAt
    await expect(updateJourney(j.id, { ...input, title: "Stale" }, { ifUpdatedAt: j.updatedAt })).rejects.toBeInstanceOf(JournalConflictError);
    expect((await getJourney(j.id))!.title).toBe("User edit");
  });

  it("merging a booking segment records the booking id on the journey", async () => {
    const j = await base();
    await addCandidates([seg("bk", "LIS", "OPO", "2024-05-08", { bookingId: "bkg_9" })]);
    expect((await merge("gmail:bk", j.id)).bookingIds).toEqual(["bkg_9"]);
  });
});

describe("booking promotion is untrusted input", () => {
  it("skips a booking whose snapshot fails payload validation", async () => {
    writeFileSync(join(TMP, "bookings.json"), JSON.stringify([
      booking("evil", { offerSnapshot: { carrier: "TAP", segments: [{ originIata: "LHR", destinationIata: "LIS", departingAt: "2024-05-02garbage", carrier: "TAP" }] } }),
      booking("ok"),
    ]));
    const { candidates } = await getQueue(NOW);
    expect(candidates.map((c) => c.id)).toEqual(["booking:ok", "booking:ok:1"]);
  });

  it("mock bookings are low confidence and flagged", async () => {
    writeFileSync(join(TMP, "bookings.json"), JSON.stringify([booking("m", { source: "mock" })]));
    const { candidates, clusters } = await getQueue(NOW);
    for (const c of candidates) expect(c).toMatchObject({ flags: ["mock-booking"], provenance: { confidence: "low" } });
    expect(clusters[0].lowConfidence).toBe(true);
  });

  it("a Gmail confirmation of a booking leg is a duplicate, in either order", async () => {
    const confirmation = (ref: string) => seg(ref, "LHR", "LIS", "2024-05-02T08:00", { bookingRef: "ABC123", carrier: "TAP", number: "TP1023" });
    await addCandidates([confirmation("first")], NOW); // arrives before the booking is promoted
    writeFileSync(join(TMP, "bookings.json"), JSON.stringify([booking("bkg_1")]));
    let q = await getQueue(NOW);
    expect(q.candidates.map((c) => c.id).sort()).toEqual(["booking:bkg_1:1", "gmail:first"]);

    expect((await addCandidates([confirmation("second")], NOW)).duplicates).toBe(1);
    await discard("gmail:first");
    await discard("booking:bkg_1:1");
    writeFileSync(join(TMP, "bookings.json"), JSON.stringify([booking("bkg_1"), booking("bkg_2", { bookingReference: "XYZ789" })]));
    q = await getQueue(NOW);
    expect((await addCandidates([confirmation("third")], NOW)).duplicates).toBe(1); // matches the discarded one
  });

  it("external POSTs cannot use source booking or the booking: id prefix", async () => {
    const r = await addCandidates([
      { ...experience("x", "Lisbon", "2024-05-03"), provenance: prov("booking", "bkg_1") },
      { ...experience("y", "Lisbon", "2024-05-03"), id: "booking:bkg_1" },
    ]);
    expect(r).toMatchObject({ added: 0 });
    expect(r.errors).toHaveLength(2);
  });
});

describe("city resolution is exact-or-unresolved", () => {
  it.each(["Paris, Texas", "Paris, USA", "Port", "San", "Lond", "Valencia"])("%s is unresolved (low + flag)", async (hint) => {
    await addCandidates([experience("h", hint, "2024-05-03")]);
    expect((await getQueue(NOW)).candidates[0]).toMatchObject({ flags: ["unresolved-city"], provenance: { confidence: "low" } });
  });

  it("accepts exact names, a matching country hint, and accent-insensitive names", async () => {
    await addCandidates([experience("a", "Paris, France", "2024-05-03"), experience("b", "London", "2024-05-03"), experience("c", "Zürich", "2024-05-03")]);
    const { candidates } = await getQueue(NOW);
    expect(candidates.map((c) => c.payload.cityId).sort()).toEqual([PARIS, LON, "z-rich-switzerland"].sort());
    for (const c of candidates) expect(c.flags).toBeUndefined();
  });

  it("an airport code resolves to the city it serves, not a placeholder that shares the code", async () => {
    const codes = ["CDG", "ORY", "FCO", "JFK", "LGW", "MXP", "LHR"];
    await addCandidates(codes.map((c, i) => seg("a" + i, c, "LIS", `2024-05-0${i + 1}`)));
    const byRef = Object.fromEntries((await getQueue(NOW)).candidates.map((c) => [c.provenance.sourceRef, c.payload.fromCityId]));
    expect(codes.map((_, i) => byRef["a" + i])).toEqual([PARIS, PARIS, "rome-italy", "new-york-united-states", LON, "milan-italy", LON]);
  });
});

describe("stop candidates", () => {
  it("keep a nested lodging, with the import's provenance instead of a default manual one", async () => {
    await addCandidates([{ kind: "stop", provenance: prov("timeline", "t9", "medium"), payload: { cityHint: "Lisbon", arrive: "2024-05-02", depart: "2024-05-04", lodging: { name: "Hotel X" } } }]);
    const j = await accept("timeline:t9");
    expect(j.stops[0].lodging).toMatchObject({ name: "Hotel X", provenance: { source: "timeline", sourceRef: "t9", confidence: "medium" } });
  });
});

describe("segment dedupe", () => {
  it("TAP + TP1023, TP1023 and TP 01023 are the same flight; another route is not", async () => {
    const f = (ref: string, extra: object, to = "LIS") => seg(ref, "LHR", to, "2024-05-02T09:00", extra);
    const r = await addCandidates([f("a", { carrier: "TAP", number: "TP1023" }), f("b", { number: "TP1023" }), f("c", { carrier: "TAP", number: "1023" }), f("d", { number: "TP 01023" }), f("e", { number: "TP1023" }, "OPO")]);
    expect(r).toMatchObject({ added: 2, duplicates: 3 });
  });
});

describe("clustering of trips", () => {
  it("a promoted round-trip booking longer than 2 days is one cluster, with or without a home", async () => {
    writeFileSync(join(TMP, "bookings.json"), JSON.stringify([booking("bkg_1")]));
    for (const home of [undefined, LON]) {
      if (home) await saveSettings({ homeCityId: home });
      const { clusters } = await getQueue(NOW);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].candidateIds).toEqual(["booking:bkg_1", "booking:bkg_1:1"]);
    }
    const journey = await acceptCluster((await getQueue(NOW)).clusters[0].id, NOW);
    expect(journey.segments).toHaveLength(2);
    expect(journey.bookingIds).toEqual(["bkg_1"]);
  });

  it("a trip from home stays together across a long quiet stretch until it returns", () => {
    const out = flight(LON, LIS, "2024-05-01");
    const back = flight(LIS, LON, "2024-05-20");
    const next = flight(LON, OPO, "2024-06-10");
    expect(clusterCandidates([out, exp("2024-05-10"), back, next], LON).map((c) => c.candidateIds.length)).toEqual([3, 1]);
  });

  it("returning home and leaving again on one day: the return belongs to the old trip", () => {
    const c1 = flight(LON, PARIS, "2024-05-01T08:00");
    const c2 = flight(PARIS, LON, "2024-05-05T08:00");
    const c3 = flight(LON, BER, "2024-05-05T18:00");
    const c4 = cand("lodging", { name: "H", cityId: BER, arrive: "2024-05-05", depart: "2024-05-07" });
    expect(clusterCandidates([c4, c3, c2, c1], LON).map((c) => c.candidateIds)).toEqual([[c1.id, c2.id], [c3.id, c4.id]]);
  });
});

describe("stops derived from segments", () => {
  it("a city reached only by a segment still gets its stop next to lodging stops", async () => {
    await saveSettings({ homeCityId: LON });
    await addCandidates([
      seg("f1", "LHR", "CDG", "2024-05-01T08:00"),
      lodging("h1", "Paris", "2024-05-01", "2024-05-03"),
      seg("t1", "CDG", "BER", "2024-05-03T10:00", { mode: "train" }),
      seg("f2", "BER", "LHR", "2024-05-05T12:00"),
    ], NOW);
    const { clusters } = await getQueue(NOW);
    expect(clusters).toHaveLength(1);
    const j = await acceptCluster(clusters[0].id, NOW);
    expect(j.stops.map((s) => [s.cityId, s.arrive, s.depart])).toEqual([[PARIS, "2024-05-01", "2024-05-03"], [BER, "2024-05-03", "2024-05-05"]]);
    expect(j.stops[0].lodging?.name).toBe("Hotel h1");
  });
});
