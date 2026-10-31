import { describe, expect, it } from "vitest";
import type { Fingerprint, Stop } from "../../../types";
import {
  CROWDS_PENDING,
  WEATHER_PENDING,
  crowdCondition,
  day,
  fingerprintRows,
  plural,
  range,
  sentence,
  stopChain,
  weatherCondition,
  when,
} from "./format";

const status = (s: Fingerprint["status"][keyof Fingerprint["status"]]) =>
  ({ month: "ok", comfort: s, tempC: s, precipMm: s, dailySpendEur: "absent", flightCostEurPer1000km: "absent", crowdProxy: s }) as Fingerprint["status"];

const fp = (over: Partial<Fingerprint> = {}): Fingerprint => ({
  month: 5,
  weekOfYear: 20,
  durationNights: 3,
  tags: [],
  status: status("ok"),
  computedAt: "2024-06-01T00:00:00Z",
  inputsHash: "x",
  ...over,
});

const stop = (over: Partial<Stop> = {}): Stop => ({ cityId: "lis", arrive: "2024-05-12", depart: "2024-05-15", ...over });

describe("dates", () => {
  it("formats days and ranges in sentence case", () => {
    expect(day("2024-05-02")).toBe("2 May");
    expect(range("2024-05-12", "2024-05-20")).toBe("12–20 May 2024");
    expect(range("2024-05-28", "2024-06-02")).toBe("28 May – 2 Jun 2024");
    expect(range("2023-12-28", "2024-01-03")).toBe("28 Dec 2023 – 3 Jan 2024");
    expect(range("2024-05-12", "2024-05-12")).toBe("12 May 2024");
    expect(range("2024-05-12", "2024-05-20", false)).toBe("12–20 May");
    expect(range("2023-12-28", "2024-01-03", false)).toBe("28 Dec 2023 – 3 Jan 2024");
  });
  it("keeps a time when present", () => {
    expect(when("2024-05-15T09:40:00Z")).toBe("15 May, 09:40");
    expect(when("2024-05-15")).toBe("15 May");
  });
});

describe("words", () => {
  it("pluralises and sentence-cases", () => {
    expect(plural(1, "night")).toBe("1 night");
    expect(plural(3, "city", "cities")).toBe("3 cities");
    expect(sentence("ADD AT LEAST ONE STOP WITH A CITY")).toBe("Add at least one stop with a city");
  });
  it("joins stop names without repeating neighbours", () => {
    const names: Record<string, string> = { a: "Lisbon", b: "Porto" };
    expect(stopChain({ stops: [stop({ cityId: "a" }), stop({ cityId: "b" }), stop({ cityId: "b" })] }, (id) => names[id])).toBe("Lisbon → Porto");
  });
});

describe("conditions", () => {
  it("compares observed weather with the normal", () => {
    const c = weatherCondition(stop({ observed: { tempC: 22.4, precipMm: 30, comfort: 80, normalComfort: 65, normalTempC: 19 } }));
    expect(c.state).toBe("ok");
    expect(c.text).toBe("22°C, usually 19°C");
    expect(c.badge).toBe("Nicer than usual");
  });
  it("says pending in plain words", () => {
    expect(weatherCondition(stop({ fingerprint: fp({ status: status("pending") }) })).text).toBe(WEATHER_PENDING);
    expect(weatherCondition(stop(), fp({ status: status("pending") })).state).toBe("pending");
    expect(crowdCondition(stop({ fingerprint: fp({ status: status("pending") }) })).text).toBe(CROWDS_PENDING);
    expect(weatherCondition(stop()).state).toBe("none");
  });
  it("prefers the traveller's own crowd rating", () => {
    expect(crowdCondition(stop({ crowdOverride: 90, fingerprint: fp({ crowdProxy: 10 }) })).text).toBe("Very busy");
    expect(crowdCondition(stop({ fingerprint: fp({ crowdProxy: 10 }) })).text).toBe("Quiet");
  });
  it("builds fingerprint rows without field names", () => {
    const rows = fingerprintRows(fp({ comfort: 70, tempC: 20, precipMm: 40, crowdProxy: 60 }));
    expect(rows.map((r) => r.label)).toContain("Flights per 1,000 km");
    expect(rows.find((r) => r.dim === "month")?.value).toBe("May");
    expect(rows.find((r) => r.dim === "dailySpendEur")?.value).toBe("No data");
    expect(rows.find((r) => r.dim === "crowdProxy")?.value).toBe("Busy");
  });
});
