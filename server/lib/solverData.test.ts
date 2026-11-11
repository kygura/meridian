import { describe, it, expect } from "vitest";
import { standingRisks } from "./solverData";
import { anomaliesFor } from "./phenomena";

describe("standing risks", () => {
  it("name the curated list with its as-of date and say it is partial, not an official advisory", () => {
    const risks = standingRisks({ country: "Ukraine", lat: 50.45, lng: 30.52 });
    expect(risks.length).toBeGreaterThan(0);
    const asOf = anomaliesFor().asOf;
    expect(asOf).toMatch(/^\d{4}-\d{2}/);
    for (const r of risks) {
      expect(r.source).toContain(`as of ${asOf}`);
      expect(r.source).toMatch(/partial, not an official advisory/);
    }
  });
});
