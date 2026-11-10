import { describe, expect, it } from "vitest";
import { getVisaData } from "./visaData";
import { readValidity, token, validitySection } from "../../scripts/build-visa-data";
import { CURATED, SCHENGEN, cellOf, isoOf } from "../../src/lib/visa/data";

describe("build-visa-data parsing", () => {
  it("encodes dataset cells as compact tokens", () => {
    expect(token({ status: "visa free", days: 90 })).toBe("vf90");
    expect(token({ status: "visa free" })).toBe("vf");
    expect(token({ status: "visa on arrival", days: 30 })).toBe("voa30");
    expect(token({ status: "eta", days: 90 })).toBe("eta90");
    expect(token({ status: "e-visa" })).toBe("ev");
    expect(token({ status: "visa required" })).toBe("vr");
    expect(token({ status: "no admission" })).toBe("na");
    expect(token({ status: "covid ban" })).toBeNull();
    expect(token(undefined)).toBeNull();
  });

  it("reads plain FCDO validity wording and leaves the rest as a quote", () => {
    expect(readValidity("your passport must have an ‘expiry date’ at least 6 months after the date you arrive")).toEqual({ amount: 6, unit: "months", from: "arrival" });
    expect(readValidity("an ‘expiry date’ at least 3 months after the day you plan to leave")).toEqual({ amount: 3, unit: "months", from: "departure" });
    expect(readValidity("at least 90 days after the date you plan to leave Serbia")).toEqual({ amount: 90, unit: "days", from: "departure" });
    expect(readValidity("your passport must be valid for the length of your planned stay")).toEqual({ amount: 0, unit: "days", from: "departure" });
    expect(readValidity("at least 6 months after the date your visa expires")).toBeNull();
    expect(readValidity("at least 6 months after the date of your visa application")).toBeNull();
  });

  it("cuts the validity paragraph out of an entry-requirements page", () => {
    const body = "<h2>Passport validity requirements</h2><p>To enter X, your passport must have an ‘expiry date’ at least 6 months after the date you arrive.</p><p>Check with your travel provider.</p><h2>Visa requirements</h2><p>You need a visa.</p>";
    expect(validitySection(body)).toBe("To enter X, your passport must have an ‘expiry date’ at least 6 months after the date you arrive.");
    expect(validitySection("<p>nothing here</p>")).toBeNull();
  });
});

describe("committed visa data", () => {
  const data = getVisaData();

  it("is present and names its sources", () => {
    expect(data).not.toBeNull();
    expect(data!.sources.requirements.url).toMatch(/^https:\/\/github.com\//);
    expect(data!.sources.requirements.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(data!.matrix).length).toBeGreaterThan(150);
    for (const row of Object.values(data!.matrix)) expect(row.split(" ").length).toBe(data!.destinations.length);
  });

  it("maps the city dataset's spellings to codes", () => {
    expect(isoOf(data, "Bosnia And Herzegovina")).toBe("BA");
    expect(isoOf(data, "Korea, South")).toBe("KR");
    expect(isoOf(data, "Czechia")).toBe("CZ");
    expect(isoOf(data, "Côte D’Ivoire")).toBe("CI");
    expect(isoOf(data, "Burma")).toBe("MM");
    expect(isoOf(data, "Turkey")).toBe("TR");
    expect(isoOf(data, "United Kingdom")).toBe("GB");
    // Overseas territories have their own rules and are not folded into their state.
    expect(isoOf(data, "French Guiana")).toBeNull();
  });

  it("has a cell for the usual pairs", () => {
    expect(cellOf(data!, "US", "FR").status).toBe("visa-free");
    expect(cellOf(data!, "GB", "GB").status).toBe("home");
    expect(cellOf(data!, "IN", "FR").status).toBe("visa-required");
  });

  it("every curated row carries a source link and a checked date", () => {
    const dated = /^\d{4}-\d{2}-\d{2}$/;
    for (const z of CURATED.zones) {
      expect(z.checked).toMatch(dated);
      for (const s of z.sources) expect(s.url).toMatch(/^https:\/\//);
    }
    for (const r of CURATED.regimes) {
      expect(r.checked).toMatch(dated);
      expect(r.source.url).toMatch(/^https:\/\//);
      expect(data!.countries[r.destination]).toBeDefined();
    }
    for (const n of CURATED.nomadVisas) {
      expect(n.checked).toMatch(dated);
      expect(n.url).toMatch(/^https:\/\//);
    }
    for (const t of CURATED.taxRules) {
      expect(t.checked).toMatch(dated);
      expect(t.url).toMatch(/^https:\/\//);
    }
    for (const b of CURATED.borderRunNotes) expect(b.source.url).toMatch(/^https:\/\//);
    expect(CURATED.yellowFever.source.url).toMatch(/^https:\/\//);
    expect(CURATED.yellowFever.checked).toMatch(dated);
  });

  it("Schengen is the 29 members, with the city spelling for each", () => {
    expect(SCHENGEN.members).toHaveLength(29);
    expect(SCHENGEN.memberNames).toHaveLength(29);
    for (const n of SCHENGEN.memberNames) expect(SCHENGEN.members).toContain(isoOf(data, n));
    expect(SCHENGEN.members).not.toContain("CY");
    expect(SCHENGEN.members).not.toContain("IE");
    expect(SCHENGEN.members).toContain("BG");
    expect(SCHENGEN.members).toContain("RO");
  });
});
