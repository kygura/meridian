import { describe, expect, it } from "vitest";
import type { City, ImportCandidate } from "../../types";
import { candidateTitle, candidateWhen, count, dateRange, errorText, flagNotes, kindWord, noteText, queueSummary, reportSummary, sourceWord } from "./inboxText";
import { groupFiles } from "./useUploads";

const city = (id: string, name: string, iata?: string): City => ({ id, name, iata, country: "Portugal", lat: 0, lng: 0, population: 1 }) as City;
const cities = new Map([
  ["lis", city("lis", "Lisbon", "LIS")],
  ["opo", city("opo", "Porto", "OPO")],
]);

const cand = (over: Partial<ImportCandidate>): ImportCandidate => ({
  id: "c1",
  kind: "stop",
  payload: {},
  provenance: { source: "gmail", confidence: "high" },
  state: "pending",
  createdAt: "2024-05-01T00:00:00Z",
  ...over,
});

describe("inbox copy", () => {
  it("counts in sentence case", () => {
    expect(count(1, "item")).toBe("1 item");
    expect(count(1200, "photo")).toBe("1,200 photos");
    expect(queueSummary(37, 6)).toBe("37 items in 6 suggested trips");
    expect(queueSummary(1, 0)).toBe("1 item");
  });

  it("formats date ranges without caps", () => {
    expect(dateRange("2024-05-12", "2024-05-20")).toBe("12–20 May 2024");
    expect(dateRange("2024-05-28", "2024-06-02")).toBe("28 May – 2 Jun 2024");
    expect(dateRange("2023-12-31", "2024-01-03")).toBe("31 Dec 2023 – 3 Jan 2024");
    expect(dateRange("2024-05-14", "2024-05-14")).toBe("14 May 2024");
  });

  it("names candidates with city names", () => {
    const flight = cand({ kind: "segment", payload: { mode: "flight", number: "TP1023", fromCityId: "lis", toCityId: "opo", departAt: "2024-05-14T08:00" } });
    expect(kindWord(flight)).toBe("Flight");
    expect(candidateTitle(flight, cities)).toBe("TP1023 · Lisbon → Porto");
    expect(candidateWhen(flight)).toBe("14 May");
    const stay = cand({ kind: "lodging", payload: { cityId: "lis", lodging: { name: "Hotel Baixa" }, arrive: "2024-05-14", depart: "2024-05-17" } });
    expect(kindWord(stay)).toBe("Stay");
    expect(candidateTitle(stay, cities)).toBe("Hotel Baixa, Lisbon");
    expect(candidateWhen(stay)).toBe("14 May – 17 May");
    expect(candidateTitle(cand({ payload: { cityHint: "Oporto Cty" } }), cities)).toBe("Oporto Cty");
  });

  it("explains flags in plain words", () => {
    const c = cand({ flags: ["unresolved-city"], payload: { cityHint: "Oporto Cty" } });
    expect(flagNotes(c, cities)).toEqual(["Pick the city for “Oporto Cty”"]);
    expect(flagNotes(cand({ flags: ["date_guessed"] }))).toEqual(["Date guessed"]);
    expect(flagNotes(cand({ provenance: { source: "photo", confidence: "low" } }))).toEqual(["Low confidence"]);
  });

  it("names sources without internal ids", () => {
    expect(sourceWord({ source: "jsonld", confidence: "high" })).toBe("Email");
    expect(sourceWord({ source: "timeline", confidence: "high" })).toBe("Location history");
    expect(sourceWord({ source: "manual", sourceRef: "agent:0123456789abcdef", confidence: "medium" })).toBe("Suggested by Ask");
  });

  it("summarises upload reports", () => {
    expect(reportSummary({ received: 12, added: 8, duplicates: 4, unstructured: 2 })).toBe("8 new items to review, 4 already seen, 2 emails without booking details.");
    expect(reportSummary({ received: 3, added: 1, duplicates: 0, note: "CANCELLED" })).toBe("1 new item to review. Cancelled.");
    expect(reportSummary({ received: 0, added: 0, duplicates: 0, note: "No photos with a location found" })).toBe("No photos with a location found");
    expect(noteText("3 photos skipped · CANCELLED")).toBe("3 photos skipped. Cancelled");
  });

  it("maps errors to sentences", () => {
    expect(errorText({ code: "not_pending" })).toBe("Already reviewed elsewhere. The list was refreshed.");
    expect(errorText({ name: "JournalNetworkError" })).toBe("Couldn't reach the server. Try again.");
    expect(errorText({ status: 413 })).toBe("That file is too large.");
    expect(errorText(undefined)).toBe("Something went wrong. Try again.");
    for (const code of ["unresolved", "too_many", "fx_unavailable", "invalid_json"]) expect(errorText({ code })).not.toMatch(/[A-Z]{3,}|_/);
  });
});

describe("groupFiles", () => {
  it("sorts a mixed selection by import kind", () => {
    const f = (name: string, type = "") => new File(["x"], name, { type });
    const g = groupFiles([f("a.eml"), f("b.mbox"), f("Records.json"), f("IMG_1.HEIC"), f("p.jpg", "image/jpeg"), f("notes.txt")]);
    expect(g.email.map((x) => x.name)).toEqual(["a.eml", "b.mbox"]);
    expect(g.timeline.map((x) => x.name)).toEqual(["Records.json"]);
    expect(g.photo.map((x) => x.name)).toEqual(["IMG_1.HEIC", "p.jpg"]);
    expect(g.other.map((x) => x.name)).toEqual(["notes.txt"]);
  });
});
