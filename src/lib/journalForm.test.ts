import { describe, it, expect } from "vitest";
import {
  autoTitle,
  emptyForm,
  fromJourney,
  isDirty,
  newExperience,
  newExtraSegment,
  newStop,
  syncSegments,
  toJourneyInput,
  validateLog,
  type LogForm,
  type StopDraft,
} from "./journalForm";
import type { Journey } from "../types";

const st = (cityId: string, arrive: string, depart: string): StopDraft => ({ ...newStop(cityId, arrive), depart });
const name = (id: string) => ({ lisbon: "Lisbon", porto: "Porto", madrid: "Madrid" } as Record<string, string>)[id] ?? id;

describe("syncSegments", () => {
  it("creates one flight segment per adjacent pair, dated at the previous depart", () => {
    const stops = [st("lisbon", "2024-05-12", "2024-05-15"), st("porto", "2024-05-15", "2024-05-18"), st("madrid", "2024-05-18", "2024-05-20")];
    const segs = syncSegments(stops, []);
    expect(segs.map((s) => [s.fromCityId, s.toCityId, s.mode, s.date])).toEqual([
      ["lisbon", "porto", "flight", "2024-05-15"],
      ["porto", "madrid", "flight", "2024-05-18"],
    ]);
  });

  it("keeps mode and cost of a pair that survives a reorder, follows auto dates", () => {
    const stops = [st("lisbon", "2024-05-12", "2024-05-15"), st("porto", "2024-05-15", "2024-05-18")];
    const first = syncSegments(stops, []);
    first[0].mode = "train";
    first[0].cost = { amount: "25", currency: "EUR" };
    const moved = [{ ...stops[0], depart: "2024-05-16" }, stops[1]];
    const again = syncSegments(moved, first);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ mode: "train", date: "2024-05-16", cost: { amount: "25" } });
    // reversed order is a different pair: old one is dropped, new one defaults
    const rev = syncSegments([stops[1], stops[0]], first);
    expect(rev[0]).toMatchObject({ fromCityId: "porto", toCityId: "lisbon", mode: "flight" });
  });

  it("skips pairs with a missing or identical city, and passes 'other' segments through", () => {
    const extra = newExtraSegment();
    const segs = syncSegments([st("lisbon", "", ""), st("", "", ""), st("lisbon", "", "")], [extra]);
    expect(segs).toEqual([extra]);
  });
});

describe("validateLog", () => {
  const ok = (): LogForm => ({ ...emptyForm(), stops: [st("lisbon", "2024-05-12", "2024-05-15"), st("porto", "2024-05-15", "2024-05-18")] });

  it("accepts a valid form", () => {
    expect(validateLog(ok())).toEqual({});
  });
  it("needs a city, dates in order, and no overlap", () => {
    expect(validateLog(emptyForm()).stops).toBeTruthy();
    const f = ok();
    f.stops[0].depart = "2024-05-10";
    expect(validateLog(f)[`stop-${f.stops[0].key}-dates`]).toMatch(/BEFORE/);
    const g = ok();
    g.stops[1].arrive = "2024-05-14";
    expect(validateLog(g)[`stop-${g.stops[1].key}-dates`]).toBe("OVERLAPS PREVIOUS STOP");
  });
  it("rejects zero/negative amounts but allows blank", () => {
    const f = ok();
    f.stops[0].lodging = { name: "Casa", kind: "", cost: { amount: "0", currency: "EUR" } };
    expect(validateLog(f)[`money-${f.stops[0].key}-stay`]).toBeTruthy();
    f.stops[0].lodging.cost.amount = "";
    expect(validateLog(f)).toEqual({});
    f.stops[0].lodging.cost.amount = "420,50";
    expect(validateLog(f)).toEqual({});
  });
  it("experience rows and other segments need their fields", () => {
    const f = ok();
    f.experiences = [newExperience()];
    f.segments = [newExtraSegment()];
    const e = validateLog(f);
    expect(Object.keys(e).sort()).toEqual(
      [`exp-${f.experiences[0].key}-city`, `exp-${f.experiences[0].key}-date`, `exp-${f.experiences[0].key}-title`, `seg-${f.segments[0].key}-from`, `seg-${f.segments[0].key}-to`].sort()
    );
  });
});

describe("toJourneyInput", () => {
  it("builds dates from stops, auto-titles, tags manual provenance and sends amounts without eur", () => {
    const f: LogForm = { ...emptyForm(), stops: [st("lisbon", "2024-05-12", "2024-05-15"), st("porto", "2024-05-15", "2024-05-18")] };
    f.stops[0].lodging = { name: "Casa do Rio", kind: "apartment", cost: { amount: "420", currency: "PLN" } };
    f.stops[1].crowd = 85;
    f.segments = syncSegments(f.stops, []);
    f.segments[0].carrier = "TAP";
    f.segments[0].number = "TP1023";
    f.segments[0].cost = { amount: "80", currency: "EUR" };
    f.tags = ["food"];
    f.travellers = 2;
    const input = toJourneyInput(f, name);
    expect(input.title).toBe("Lisbon & Porto");
    expect(input.status).toBe("confirmed");
    expect(input.startDate).toBe("2024-05-12");
    expect(input.endDate).toBe("2024-05-18");
    expect(input.stops[0].lodging).toEqual({
      name: "Casa do Rio",
      kind: "apartment",
      cost: { amount: 420, currency: "PLN" },
      provenance: { source: "manual", confidence: "high" },
    });
    expect(input.stops[1].crowdOverride).toBe(85);
    expect(input.segments[0]).toMatchObject({ mode: "flight", carrier: "TAP", number: "TP1023", departAt: "2024-05-15", cost: { amount: 80, currency: "EUR" } });
    expect(input.companions).toBe(2);
    expect(input.bookingIds).toEqual([]);
    expect(input.provenance).toEqual({ source: "manual", confidence: "high" });
  });

  it("drops city-less stops and incomplete other segments", () => {
    const f: LogForm = { ...emptyForm(), stops: [st("lisbon", "2024-05-12", "2024-05-15"), st("", "", "")] };
    f.segments = [newExtraSegment()];
    const input = toJourneyInput(f, name);
    expect(input.stops).toHaveLength(1);
    expect(input.segments).toEqual([]);
  });
});

describe("fromJourney round trip", () => {
  const prov = { source: "gmail", confidence: "medium", sourceRef: "m1" } as const;
  const j: Journey = {
    id: "j1",
    title: "Iberia",
    status: "draft",
    startDate: "2024-05-12",
    endDate: "2024-05-18",
    stops: [
      { cityId: "lisbon", arrive: "2024-05-12", depart: "2024-05-15", rating: 4, observed: { tempC: 20, precipMm: 1, comfort: 80, normalComfort: 70 } },
      { cityId: "porto", arrive: "2024-05-15", depart: "2024-05-18" },
    ],
    segments: [
      { mode: "flight", fromCityId: "lisbon", toCityId: "porto", departAt: "2024-05-15T09:40", arriveAt: "2024-05-15T10:30", bookingRef: "ABC", provenance: prov },
      { mode: "train", fromCityId: "porto", toCityId: "madrid", departAt: "2024-05-17", provenance: prov },
    ],
    experiences: [],
    tags: ["x"],
    companions: 2,
    fromTripId: "trip-1",
    bookingIds: ["b1"],
    provenance: prov,
    createdAt: "",
    updatedAt: "",
  };

  it("keeps imported provenance, booking refs, status and links; marks off-chain segments as other", () => {
    const form = fromJourney(j);
    expect(form.segments.map((s) => s.extra)).toEqual([false, true]);
    const out = toJourneyInput(form, name);
    expect(out.status).toBe("draft");
    expect(out.fromTripId).toBe("trip-1");
    expect(out.bookingIds).toEqual(["b1"]);
    expect(out.provenance).toEqual(prov);
    expect(out.segments[0]).toMatchObject({ bookingRef: "ABC", arriveAt: "2024-05-15T10:30", departAt: "2024-05-15T09:40", provenance: prov });
    expect(out.segments).toHaveLength(2);
    expect(out.stops[0]).not.toHaveProperty("observed");
    expect(out.companions).toBe(2);
  });

  it("isDirty is false for an untouched form and true after an edit", () => {
    const a = fromJourney(j);
    const b = fromJourney(j);
    expect(isDirty(a, b)).toBe(false);
    b.title = "x";
    expect(isDirty(b, a)).toBe(true);
  });
});

describe("autoTitle", () => {
  it("joins names", () => {
    expect(autoTitle(["Lisbon"])).toBe("Lisbon");
    expect(autoTitle(["Lisbon", "Porto", "Lisbon"])).toBe("Lisbon & Porto");
    expect(autoTitle(["A", "B", "C"])).toBe("A, B & C");
    expect(autoTitle(["A", "B", "C", "D"])).toBe("A + 3 more");
    expect(autoTitle([])).toBe("Untitled journey");
  });
});

describe("syncSegments parking", () => {
  it("keeps entered details when a pair goes away and re-attaches them when it returns", () => {
    const stops = [st("lisbon", "2024-05-12", "2024-05-15"), st("porto", "2024-05-15", "2024-05-18")];
    const [seg] = syncSegments(stops, []);
    seg.carrier = "TAP";
    const cleared = syncSegments([stops[0], { ...stops[1], cityId: "" }], [seg]);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ extra: true, orphan: true, carrier: "TAP" });
    const back = syncSegments(stops, cleared);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ extra: false, orphan: false, carrier: "TAP", key: seg.key });
  });
  it("drops a blank auto segment", () => {
    const stops = [st("lisbon", "", ""), st("porto", "", "")];
    expect(syncSegments([stops[0]], syncSegments(stops, []))).toEqual([]);
  });
});

describe("money round trip", () => {
  it("sends the stored eur/rateDate when amount, currency and date are unchanged", () => {
    const j: Journey = {
      id: "j2", title: "T", status: "confirmed", startDate: "2024-05-12", endDate: "2024-05-15",
      stops: [{ cityId: "lisbon", arrive: "2024-05-12", depart: "2024-05-15", lodging: { name: "H", cost: { amount: 2350, currency: "PLN", eur: 550, rateDate: "2024-05-12" }, provenance: { source: "manual", confidence: "high" } } }],
      segments: [], experiences: [], tags: [], bookingIds: [], provenance: { source: "manual", confidence: "high" }, createdAt: "", updatedAt: "",
    };
    const form = fromJourney(j);
    const input = toJourneyInput(form, name);
    expect(input.stops[0].lodging?.cost).toEqual({ amount: 2350, currency: "PLN", eur: 550, rateDate: "2024-05-12" });
    form.stops[0].lodging!.cost.amount = "2000";
    expect(toJourneyInput(form, name).stops[0].lodging?.cost).toEqual({ amount: 2000, currency: "PLN" });
  });
});

describe("syncSegments create:false", () => {
  it("re-dates existing pairs but does not invent segments", () => {
    const stops = [st("lisbon", "2024-05-12", "2024-05-15"), st("porto", "2024-05-15", "2024-05-18"), st("madrid", "2024-05-18", "2024-05-20")];
    const [first] = syncSegments(stops.slice(0, 2), []);
    const out = syncSegments(stops, [first], false);
    expect(out.map((s) => s.toCityId)).toEqual(["porto"]);
  });
});
