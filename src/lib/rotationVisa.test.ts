import { describe, expect, it } from "vitest";
import { rotationVisa } from "./rotationVisa";
import type { RotationStay } from "./rotation";

const data = {
  version: 1,
  builtAt: "2026-11-10",
  sources: { requirements: { name: "Test data", url: "https://example.org", fetchedAt: "2026-11-10", licence: "test" } },
  countries: { US: { name: "United States" }, PT: { name: "Portugal" }, ES: { name: "Spain" }, ME: { name: "Montenegro" }, FR: { name: "France" } },
  destinations: ["US", "PT", "ES", "ME", "FR"],
  matrix: { US: "- vf90 vf90 vf90 vf90" },
  validity: {},
};
const stay = (id: string, country: string, start: string, end: string, status: RotationStay["status"] = "planned"): RotationStay =>
  ({ id, place: { cityId: id, name: id, country, lat: 0, lng: 0 }, kind: "base", status, start, end, updatedAt: "x" }) as RotationStay;

describe("rotationVisa", () => {
  it("counts the journal's past Schengen days into a stay's verdict", () => {
    const past = [{ id: "j:1:0", country: "France", start: "2026-09-01", end: "2026-10-15", past: true }];
    const r = rotationVisa([stay("lis", "Portugal", "2026-11-20", "2027-01-10")], past, data, ["US"], { today: "2026-11-10" });
    expect(r.verdicts.get("lis")?.level).toBe("over");
    expect(r.check?.violations[0].key).toBe("schengen");
  });

  it("leaves ideas out of the counts but gives them their entry rule", () => {
    const r = rotationVisa([stay("lis", "Portugal", "2027-01-01", "2027-03-01"), stay("bcn", "Spain", "2027-03-01", "2027-05-01", "idea")], [], data, ["US"]);
    expect(r.check?.violations).toEqual([]);
    expect(r.verdicts.has("bcn")).toBe(false);
    expect(r.rules.get("bcn")?.pool).toBe("schengen");
  });

  it("does not count a rotation stay twice when the server's list already has it", () => {
    const fromServer = [{ id: "r:lis", country: "Portugal", start: "2027-01-01", end: "2027-03-01" }];
    const r = rotationVisa([stay("lis", "Portugal", "2027-01-01", "2027-03-01")], fromServer, data, ["US"]);
    expect(r.verdicts.get("lis")?.plannedDays).toBe(60);
    expect(r.check?.violations).toEqual([]);
  });
});
