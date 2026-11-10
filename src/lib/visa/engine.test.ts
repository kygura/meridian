import { describe, expect, it } from "vitest";
import type { VisaData } from "./data";
import { addRange, dayIso, dayNum, firstOver, peakUse, usedOn, type Ranges } from "./days";
import { entryRule } from "./rules";
import {
  borderRunOptions,
  checkStays,
  countLimits,
  earliestEntry,
  entriesOf,
  limitUsage,
  limitsFor,
  firstArrivals,
  maxStayFrom,
  passportValidity,
  schengenBuffers,
  schengenOn,
  schengenRanges,
  schengenSummary,
  schengenTimeline,
  taxDays,
  taxWarnings,
  toPresence,
  yellowFever,
  type Place,
  type StayInput,
} from "./engine";

// A small hand-made data file: test inputs, not the real dataset (which has its own tests).
const DEST = ["US", "GB", "DE", "FR", "ES", "PT", "TH", "VN", "KH", "LA", "ME", "AL", "TR", "CY", "IE", "GE", "IN", "BR", "KP", "AD"];
const row = (cells: Record<string, string>) => DEST.map((d) => cells[d] ?? "vr").join(" ");
const DATA: VisaData = {
  version: 1,
  builtAt: "2026-11-10",
  sources: { requirements: { name: "Test data", url: "https://example.org", fetchedAt: "2026-11-10", licence: "test", datasetUpdated: "2026-02-17" } },
  countries: {
    US: { name: "United States" },
    GB: { name: "United Kingdom" },
    DE: { name: "Germany" },
    FR: { name: "France" },
    ES: { name: "Spain" },
    PT: { name: "Portugal" },
    TH: { name: "Thailand" },
    VN: { name: "Vietnam" },
    KH: { name: "Cambodia" },
    LA: { name: "Laos" },
    ME: { name: "Montenegro" },
    AL: { name: "Albania" },
    TR: { name: "Turkey" },
    CY: { name: "Cyprus" },
    IE: { name: "Ireland" },
    GE: { name: "Georgia" },
    IN: { name: "India" },
    BR: { name: "Brazil" },
    KP: { name: "North Korea", aliases: ["Korea, North"] },
    AD: { name: "Andorra" },
  },
  destinations: DEST,
  matrix: {
    US: row({ US: "-", GB: "eta", DE: "vf90", FR: "vf90", ES: "vf90", PT: "vf90", TH: "vf60", VN: "ev90", KH: "voa30", LA: "voa30", ME: "vf90", AL: "vf360", TR: "vf90", CY: "vf90", IE: "vf90", GE: "vf360", IN: "ev", BR: "vf90", KP: "na", AD: "vf90" }),
    DE: row({ US: "eta90", GB: "eta", DE: "-", FR: "vf", ES: "vf", PT: "vf", TH: "vf60", VN: "vf45", KH: "voa30", LA: "voa30", ME: "vf90", AL: "vf90", TR: "vf90", CY: "vf", IE: "vf", GE: "vf360", IN: "ev30", BR: "vf90" }),
    GB: row({ US: "eta90", GB: "-", DE: "vf90", FR: "vf90", ES: "vf90", PT: "vf90", TH: "vf60", VN: "vf45", KH: "voa30", LA: "vf30", ME: "vf90", AL: "vf90", TR: "vf90", CY: "vf90", IE: "vf", GE: "vf360", IN: "ev", BR: "vf90" }),
    IN: row({ IN: "-", TH: "vf60", VN: "ev90", KH: "voa30", LA: "voa30", GE: "ev", ME: "vr", AL: "vf90", TR: "ev30", CY: "vr", IE: "vr", BR: "vr" }),
  },
  validity: {
    TH: { quote: "at least 6 months after the date you arrive", rule: { amount: 6, unit: "months", from: "arrival" }, url: "https://www.gov.uk/foreign-travel-advice/thailand/entry-requirements", updated: "2026-10-12" },
    FR: { quote: "at least 3 months after the day you plan to leave", rule: { amount: 3, unit: "months", from: "departure" }, url: "https://www.gov.uk/foreign-travel-advice/france/entry-requirements", updated: "2026-10-01" },
  },
};

const d = dayNum;
const stay = (id: string, country: string, start: string, end: string, extra: Partial<StayInput> = {}): StayInput => ({ id, country, start, end, ...extra });
const plus = (iso: string, n: number) => dayIso(d(iso) + n);

describe("day ranges", () => {
  it("joins touching and overlapping ranges", () => {
    let r: Ranges = [];
    r = addRange(r, 10, 20);
    r = addRange(r, 21, 25);
    r = addRange(r, 40, 45);
    r = addRange(r, 44, 50);
    expect(r).toEqual([
      [10, 25],
      [40, 50],
    ]);
  });

  it("counts a window ending on a day, that day included", () => {
    const r: Ranges = [[0, 9]];
    expect(usedOn(r, 9, 180)).toBe(10);
    expect(usedOn(r, 188, 180)).toBe(1);
    expect(usedOn(r, 189, 180)).toBe(0);
  });

  it("finds the first day over a limit and the peak", () => {
    const r: Ranges = [[0, 99]];
    expect(firstOver(r, 90, 180)).toBe(90);
    expect(peakUse(r, 180)).toEqual({ used: 100, day: 99 });
    expect(firstOver([[0, 89]], 90, 180)).toBeNull();
  });
});

describe("Schengen 90/180", () => {
  const US = ["US"];

  it("allows exactly 90 days, entry and exit days counted, and flags the 91st", () => {
    const ok = checkStays(DATA, US, [stay("a", "France", "2027-01-01", plus("2027-01-01", 89))]);
    expect(ok.violations).toEqual([]);
    expect(ok.verdicts[0].plannedDays).toBe(90);
    expect(ok.verdicts[0].allowedDays).toBe(90);
    const over = checkStays(DATA, US, [stay("a", "France", "2027-01-01", plus("2027-01-01", 90))]);
    expect(over.violations).toHaveLength(1);
    expect(over.violations[0].key).toBe("schengen");
    expect(over.violations[0].firstOver).toBe(plus("2027-01-01", 90));
    expect(over.verdicts[0].level).toBe("over");
    expect(over.verdicts[0].overFrom).toBe(plus("2027-01-01", 90));
  });

  it("pools every member country and counts a shared moving day once", () => {
    // France 1 Jan to 15 Feb (46 days), then Spain 15 Feb to 31 Mar (45 days, sharing 15 Feb): 90 in all.
    const r = checkStays(DATA, US, [stay("a", "France", "2027-01-01", "2027-02-15"), stay("b", "Spain", "2027-02-15", "2027-03-31")]);
    expect(r.violations).toEqual([]);
    const sch = schengenRanges(toPresence(DATA, [stay("a", "France", "2027-01-01", "2027-02-15"), stay("b", "Spain", "2027-02-15", "2027-03-31")]));
    expect(schengenOn(sch, d("2027-03-31"))).toEqual({ used: 90, left: 0 });
    const r2 = checkStays(DATA, US, [stay("a", "France", "2027-01-01", "2027-02-15"), stay("b", "Spain", "2027-02-15", "2027-04-01")]);
    expect(r2.violations[0].firstOver).toBe("2027-04-01");
    expect(r2.violations[0].stayIds.sort()).toEqual(["a", "b"]);
  });

  it("does not count Cyprus, Ireland or Montenegro towards Schengen", () => {
    const r = checkStays(DATA, US, [stay("a", "France", "2027-01-01", plus("2027-01-01", 89)), stay("b", "Cyprus", plus("2027-01-01", 89), plus("2027-01-01", 120)), stay("c", "Ireland", plus("2027-01-01", 120), plus("2027-01-01", 150))]);
    expect(r.violations.filter((v) => v.key === "schengen")).toEqual([]);
  });

  it("lets old days fall out of the window and finds the earliest re-entry", () => {
    // 90 days used from 1 Jan; the first of them leaves the window 180 days later.
    const p = toPresence(DATA, [stay("a", "Germany", "2027-01-01", plus("2027-01-01", 89))]);
    const r = schengenRanges(p);
    const back = earliestEntry(r, d(plus("2027-01-01", 90)));
    expect(dayIso(back!)).toBe(plus("2027-01-01", 180));
    // From then on, each new day replaces one old day leaving the window: a full 90 fits again.
    expect(maxStayFrom(r, d(plus("2027-01-01", 180)))).toBe(90);
    // A day earlier, the first old day is still in the window: nothing fits.
    expect(maxStayFrom(r, d(plus("2027-01-01", 179)))).toBe(0);
    expect(dayIso(earliestEntry(r, d("2027-04-01"), 90)!)).toBe(plus("2027-01-01", 180));
  });

  it("counts planned presence after an entry day when saying how long a stay can be", () => {
    // 30 days planned in June: entering on 1 March cannot use the full 90 without breaking June's window.
    const p = toPresence(DATA, [stay("june", "Spain", "2027-06-01", "2027-06-30")]);
    const r = schengenRanges(p);
    expect(maxStayFrom(r, d("2027-03-01"))).toBe(60);
    expect(maxStayFrom(r, d("2026-01-01"))).toBe(90);
  });

  it("reads past journal days into today's count and a first overstay", () => {
    const stays = [stay("j1", "France", "2026-09-01", "2026-10-15", { past: true }), stay("p1", "Spain", "2026-11-20", "2027-01-10")];
    const s = schengenSummary(DATA, US, stays, "2026-11-10");
    expect(s.applies).toBe(true);
    expect(s.today.used).toBe(45);
    expect(s.today.left).toBe(45);
    // 45 past days still in the window, plus 45 from 20 Nov: day 91 is 4 January 2027.
    expect(s.firstOverstay).toBe("2027-01-04");
    const tl = schengenTimeline(schengenRanges(toPresence(DATA, stays)), d("2026-11-09"), d("2026-11-21"));
    expect(tl[0].used).toBe(45);
    expect(tl[tl.length - 1].used).toBe(47);
    expect(tl[tl.length - 1].present).toBe(true);
  });

  it("does not apply to an EU passport, or to someone holding one", () => {
    expect(schengenSummary(DATA, ["DE"], [], "2026-11-10").applies).toBe(false);
    const r = checkStays(DATA, ["US", "DE"], [stay("a", "France", "2027-01-01", "2027-12-31")]);
    expect(r.violations).toEqual([]);
    expect(r.verdicts[0].level).toBe("free");
    expect(r.verdicts[0].rule!.passport).toBe("DE");
  });
});

describe("per-country limits", () => {
  it("counts days per entry, entry and exit days included", () => {
    const ok = checkStays(DATA, ["GB"], [stay("v", "Vietnam", "2027-01-01", plus("2027-01-01", 44))]);
    expect(ok.violations).toEqual([]);
    expect(ok.verdicts[0].allowedDays).toBe(45);
    const over = checkStays(DATA, ["GB"], [stay("v", "Vietnam", "2027-01-01", plus("2027-01-01", 45))]);
    expect(over.violations[0].kind).toBe("per-entry");
    expect(over.violations[0].firstOver).toBe(plus("2027-01-01", 45));
  });

  it("joins back-to-back stays in one country into one entry, and a stay abroad breaks it", () => {
    const joined = [stay("a", "Vietnam", "2027-01-01", "2027-01-30"), stay("b", "Vietnam", "2027-01-30", "2027-02-20")];
    expect(entriesOf(toPresence(DATA, joined), ["VN"])).toHaveLength(1);
    expect(checkStays(DATA, ["GB"], joined).violations).toHaveLength(1);
    const run = [stay("a", "Vietnam", "2027-01-01", "2027-01-30"), stay("r", "Cambodia", "2027-01-30", "2027-02-01"), stay("b", "Vietnam", "2027-02-01", "2027-02-20")];
    expect(entriesOf(toPresence(DATA, run), ["VN"])).toHaveLength(2);
    expect(checkStays(DATA, ["GB"], run).violations).toEqual([]);
  });

  it("gives the later stay of one entry only what is left", () => {
    const r = checkStays(DATA, ["GB"], [stay("a", "Vietnam", "2027-01-01", "2027-01-30"), stay("b", "Vietnam", "2027-01-30", "2027-02-10")]);
    expect(r.verdicts[1].allowedDays).toBe(45 - 29);
  });

  it("counts a rolling window apart from Schengen (Montenegro 90 in 180)", () => {
    const r = checkStays(DATA, ["GB"], [stay("a", "Montenegro", "2027-01-01", "2027-02-14"), stay("x", "Albania", "2027-02-14", "2027-02-20"), stay("b", "Montenegro", "2027-02-20", "2027-04-10")]);
    const me = r.violations.find((v) => v.key === "ME");
    expect(me?.kind).toBe("rolling");
    // 45 days, then from 20 Feb: the 91st day in the window is 6 April.
    expect(me?.firstOver).toBe("2027-04-06");
  });

  it("applies Thailand's 30 days only to arrivals from 15 September 2026", () => {
    expect(entryRule(DATA, ["GB"], "TH", "2026-09-14").limit).toEqual({ kind: "per-entry", days: 60 });
    expect(entryRule(DATA, ["GB"], "TH", "2026-09-15").limit).toEqual({ kind: "per-entry", days: 30 });
    const r = checkStays(DATA, ["GB"], [stay("t", "Thailand", "2026-12-01", "2026-12-31")]);
    expect(r.verdicts[0].level).toBe("over");
    expect(r.verdicts[0].overFrom).toBe("2026-12-31");
    expect(r.verdicts[0].rule!.landEntriesPerYear).toBe(2);
  });

  it("uses a year-long dataset figure as a per-entry limit when the curated window does not apply", () => {
    // Albania's 90/180 is for passports the dataset gives 90 days; a 360-day passport counts per entry.
    expect(entryRule(DATA, ["US"], "AL", "2027-01-01").limit).toEqual({ kind: "per-entry", days: 360 });
    expect(entryRule(DATA, ["GB"], "AL", "2027-01-01").limit).toEqual({ kind: "rolling", days: 90, windowDays: 180 });
  });

  it("counts a calendar-year rule the owner typed, splitting at the new year", () => {
    const stays = [stay("a", "Georgia", "2027-10-01", "2027-12-31"), stay("b", "Georgia", "2028-01-01", "2028-02-15")];
    const r = checkStays(DATA, ["GB"], stays, { overrides: [{ country: "Georgia", maxDaysPerYear: 80 }] });
    const v = r.violations.filter((x) => x.kind === "calendar-year");
    expect(v).toHaveLength(1);
    expect(v[0].days).toBe(92);
    expect(v[0].firstOver).toBe("2027-12-20");
    // The owner's rule replaces the data's limit for that country.
    expect(r.limits.filter((l) => l.key === "GE").map((l) => l.origin)).toEqual(["owner"]);
  });

  it("chooses the easiest of several passports and says which", () => {
    const r = entryRule(DATA, ["IN", "GB"], "ME", "2027-01-01");
    expect(r.passport).toBe("GB");
    expect(r.status).toBe("visa-free");
  });

  it("says when a visa is needed, entry is refused, or there is no data", () => {
    const r = checkStays(DATA, ["IN"], [stay("a", "Cyprus", "2027-01-01", "2027-01-10"), stay("b", "Atlantis", "2027-01-10", "2027-01-12")]);
    expect(r.verdicts[0].level).toBe("visa");
    expect(r.verdicts[1].level).toBe("unknown");
    expect(checkStays(DATA, ["US"], [stay("k", "Korea, North", "2027-01-01", "2027-01-05")]).verdicts[0].level).toBe("blocked");
    const none = checkStays(DATA, [], [stay("a", "France", "2027-01-01", "2027-12-01")]);
    expect(none.violations).toEqual([]);
    expect(none.notes[0]).toMatch(/No passport set/);
  });

  it("ignores breaches that ended before today", () => {
    const p = toPresence(DATA, [stay("a", "France", "2026-01-01", "2026-05-01", { past: true })]);
    const limits = [{ key: "schengen", label: "Schengen", countries: ["FR"], limit: { kind: "rolling" as const, days: 90, windowDays: 180 }, source: "test", origin: "zone" as const }];
    expect(countLimits(p, limits)).toHaveLength(1);
    expect(countLimits(p, limits, d("2026-11-10"))).toEqual([]);
  });
});

describe("passport validity and yellow fever", () => {
  it("works out the day the passport must last to", () => {
    const v = passportValidity(DATA, "TH", "2027-01-15", "2027-02-10", "2027-06-30")!;
    expect(v.requiredUntil).toBe("2027-07-15");
    expect(v.ok).toBe(false);
    expect(passportValidity(DATA, "FR", "2027-01-15", "2027-02-10", "2027-06-30")!.requiredUntil).toBe("2027-05-10");
    expect(passportValidity(DATA, "FR", "2027-01-15", "2027-02-10")!.ok).toBeNull();
    expect(passportValidity(DATA, "VN", "2027-01-15", "2027-02-10")).toBeNull();
  });

  it("flags a certificate after a stay in a WHO risk country", () => {
    expect(yellowFever("TH", { code: "BR", name: "Brazil" })!.triggeredBy).toBe("Brazil");
    expect(yellowFever("TH", { code: "VN", name: "Vietnam" })!.triggeredBy).toBeNull();
    expect(yellowFever("TH", null)!.requirement).toBe("from-risk");
    expect(yellowFever("AO", null)!.requirement).toBe("all");
    expect(yellowFever("FR", null)).toBeNull();
    const r = checkStays(DATA, ["GB"], [stay("b", "Brazil", "2027-01-01", "2027-01-20"), stay("t", "Thailand", "2027-01-20", "2027-02-10")]);
    expect(r.verdicts[1].yellowFever?.triggeredBy).toBe("Brazil");
  });
});

describe("tax days", () => {
  it("counts days present per calendar year and warns near 183", () => {
    const p = toPresence(DATA, [stay("a", "Thailand", "2027-01-01", "2027-05-31"), stay("b", "Thailand", "2027-12-01", "2028-01-31")]);
    const rows = taxDays(DATA, p, { years: [2027, 2028] });
    const th27 = rows.find((r) => r.country === "TH" && r.period === "2027")!;
    expect(th27.days).toBe(151 + 31);
    expect(th27.status).toBe("near");
    expect(rows.find((r) => r.country === "TH" && r.period === "2028")!.days).toBe(31);
    expect(taxWarnings(rows)[0]).toMatch(/Thailand \(2027\): 182 days/);
  });

  it("uses a rolling 12 months where that is the country's test, and a tax year where it has one", () => {
    // Portugal: 100 days at the end of 2027 and 100 at the start of 2028 are more than 183 in 12 months.
    const p = toPresence(DATA, [stay("a", "Portugal", "2027-09-23", "2027-12-31"), stay("b", "Portugal", "2028-01-01", "2028-04-09")]);
    const pt = taxDays(DATA, p, { years: [2027] }).find((r) => r.country === "PT")!;
    expect(pt.days).toBe(200);
    expect(pt.status).toBe("over");
    const uk = taxDays(DATA, toPresence(DATA, [stay("u", "United Kingdom", "2027-03-01", "2027-04-30")]), { years: [2027] }).find((r) => r.country === "GB")!;
    expect(uk.periodStart).toBe("2027-04-06");
    expect(uk.days).toBe(25);
  });

  it("lists watched and residency countries with no days, and leaves the residency out of warnings", () => {
    const p = toPresence(DATA, [stay("a", "Spain", "2027-01-01", "2027-07-31")]);
    const rows = taxDays(DATA, p, { years: [2027], watch: ["PT"], residency: "ES" });
    expect(rows.find((r) => r.country === "PT")!.days).toBe(0);
    expect(rows.find((r) => r.country === "ES")!.residency).toBe(true);
    expect(taxWarnings(rows)).toEqual([]);
  });
});

describe("border runs and Schengen buffers", () => {
  const places: Place[] = [
    { cityId: "danang", name: "Da Nang", country: "Vietnam", lat: 16.07, lng: 108.22 },
    { cityId: "pakse", name: "Pakse", country: "Laos", lat: 15.12, lng: 105.8 },
    { cityId: "siemreap", name: "Siem Reap", country: "Cambodia", lat: 13.36, lng: 103.86 },
    { cityId: "phnompenh", name: "Phnom Penh", country: "Cambodia", lat: 11.56, lng: 104.92 },
    { cityId: "bangkok", name: "Bangkok", country: "Thailand", lat: 13.75, lng: 100.5 },
    { cityId: "delhi", name: "Delhi", country: "India", lat: 28.6, lng: 77.2 },
  ];

  it("lists the nearest countries you can enter on arrival, one city each", () => {
    const r = borderRunOptions(DATA, ["GB"], { country: "Vietnam", lat: 16.07, lng: 108.22, date: "2027-01-10" }, places);
    expect(r.options.map((o) => o.place.cityId)).toEqual(["pakse", "siemreap", "bangkok"]);
    expect(r.options.every((o) => o.place.country !== "India")).toBe(true);
    expect(r.notes.join(" ")).toMatch(/e-visa obtained inside Vietnam/);
    expect(r.options.find((o) => o.place.cityId === "bangkok")!.notes.join(" ")).toMatch(/land borders/);
  });

  it("says a run does not help against a rolling window", () => {
    const r = borderRunOptions(DATA, ["GB"], { country: "Montenegro", lat: 42.4, lng: 19.26, date: "2027-01-10" }, places);
    expect(r.options).toEqual([]);
    expect(r.notes[0]).toMatch(/does not restart it/);
  });

  const europe: Place[] = [
    { cityId: "kotor", name: "Kotor", country: "Montenegro", lat: 42.42, lng: 18.77, comfort: [40, 45, 55, 65, 75, 80, 70, 70, 80, 70, 55, 45] },
    { cityId: "tirana", name: "Tirana", country: "Albania", lat: 41.33, lng: 19.82, comfort: [40, 45, 55, 65, 75, 70, 60, 60, 75, 70, 55, 45] },
    { cityId: "limassol", name: "Limassol", country: "Cyprus", lat: 34.68, lng: 33.04, comfort: [60, 60, 70, 80, 85, 70, 55, 55, 75, 85, 75, 65] },
    { cityId: "dublin", name: "Dublin", country: "Ireland", lat: 53.35, lng: -6.26, comfort: [30, 30, 40, 50, 60, 70, 75, 75, 65, 50, 40, 30] },
    { cityId: "lyon", name: "Lyon", country: "France", lat: 45.76, lng: 4.84, comfort: [50, 50, 60, 70, 80, 85, 85, 85, 80, 70, 55, 50] },
    { cityId: "tbilisi", name: "Tbilisi", country: "Georgia", lat: 41.72, lng: 44.78, comfort: null },
    { cityId: "andorra", name: "Andorra la Vella", country: "AD", lat: 42.51, lng: 1.52, comfort: null },
  ];

  it("offers places outside Schengen, Cyprus and Ireland included, ranked by distance and comfort", () => {
    const b = schengenBuffers(DATA, ["US"], { lat: 41.9, lng: 12.5 }, "2027-04-01", 60, europe);
    const ids = b.map((x) => x.place.cityId);
    expect(ids).not.toContain("lyon");
    // Enclaved by Schengen: reached only through it.
    expect(ids).not.toContain("andorra");
    expect(ids).toEqual(expect.arrayContaining(["kotor", "tirana", "limassol", "dublin", "tbilisi"]));
    const kotor = b.find((x) => x.place.cityId === "kotor")!;
    expect(kotor.distanceRank).toBe(1);
    expect(b.find((x) => x.place.cityId === "tbilisi")!.comfort).toBeNull();
    expect(b.find((x) => x.place.cityId === "limassol")!.notes.join(" ")).toMatch(/not in the Schengen Area/);
    // Sorted by the combined score.
    for (let i = 1; i < b.length; i++) expect(b[i - 1].score).toBeGreaterThanOrEqual(b[i].score);
  });

  it("leaves out places under an avoid advisory and names lesser ones", () => {
    const withAdv = europe.map((p) => (p.cityId === "kotor" ? { ...p, advisories: [{ label: "Test conflict", severity: 3, source: "test list" }] } : p.cityId === "tirana" ? { ...p, advisories: [{ label: "Test watch", severity: 1, source: "test list" }] } : p));
    const b = schengenBuffers(DATA, ["US"], { lat: 41.9, lng: 12.5 }, "2027-04-01", 60, withAdv);
    expect(b.map((x) => x.place.cityId)).not.toContain("kotor");
    expect(b.find((x) => x.place.cityId === "tirana")!.notes[0]).toMatch(/Test watch/);
  });

  it("leaves out places the passport cannot enter, or not for that long", () => {
    const india = schengenBuffers(DATA, ["IN"], { lat: 41.9, lng: 12.5 }, "2027-04-01", 60, europe).map((x) => x.place.cityId);
    expect(india).not.toContain("kotor");
    expect(india).not.toContain("limassol");
    const long = schengenBuffers(DATA, ["GB"], { lat: 41.9, lng: 12.5 }, "2027-04-01", 120, europe).map((x) => x.place.cityId);
    expect(long).not.toContain("kotor");
    expect(long).toContain("tbilisi");
  });
});

describe("limit usage for the counters", () => {
  it("reports the peak from today on and today's count for each kind of limit", () => {
    const stays = [stay("a", "France", "2026-10-01", "2026-10-30", { past: true }), stay("b", "Spain", "2026-12-01", "2027-01-29"), stay("v", "Vietnam", "2027-03-01", "2027-04-10")];
    const p = toPresence(DATA, stays);
    const limits = limitsFor(DATA, ["GB"], firstArrivals(p), [{ country: "Georgia", maxDaysPerYear: 120 }]);
    const u = limitUsage(p, limits, d("2026-11-10"));
    const sch = u.find((x) => x.limit.key === "schengen")!;
    expect(sch.now).toBe(30);
    expect(sch.peak).toBe(90);
    expect(sch.over).toBe(false);
    const vn = u.find((x) => x.limit.key === "VN")!;
    expect(vn.peak).toBe(41);
    expect(vn.now).toBe(0);
    const ge = u.find((x) => x.limit.key === "GE")!;
    expect(ge.peak).toBe(0);
  });
});
