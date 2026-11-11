import { describe, expect, it } from "vitest";
import { solve } from "./engine";
import { baseInput } from "./fixtures";
import { replacedByAccept, stayLevel, swapStay } from "./view";
import type { RotationStay } from "../rotation";

const place = { cityId: "lisbon", name: "Lisbon", country: "Portugal", lat: 38.7, lng: -9.1 };
const stay = (id: string, over: Partial<RotationStay>): RotationStay => ({ id, place, kind: "base", status: "planned", ...over });

describe("solve view helpers", () => {
  it("lists exactly the stays an accept would replace", () => {
    const plan = { stays: [{ id: "a", cityId: "x", start: "2027-01-01", end: "2028-01-01", kind: "base" as const, role: "base" as const }] };
    const stays = [
      stay("idea-in", { status: "idea", start: "2027-02-01", end: "2027-03-01" }),
      stay("planned-in", { start: "2027-05-01", end: "2027-06-01" }),
      stay("locked", { start: "2027-05-01", end: "2027-06-01", locked: true }),
      stay("booked", { status: "booked", start: "2027-07-01", end: "2027-08-01" }),
      stay("before", { start: "2026-11-01", end: "2027-01-01" }),
      stay("after", { start: "2028-02-01", end: "2028-03-01" }),
    ];
    expect(replacedByAccept(stays, plan, "2026-11-10").map((s) => s.id)).toEqual(["idea-in", "planned-in"]);
  });

  it("swaps one stay's place and keeps the dates", () => {
    const best = solve(baseInput()).proposals[0];
    const target = best.stays.find((s) => s.alternatives.length)!;
    const plan = swapStay(best, target.id, target.alternatives[0].cityId);
    const swapped = plan.stays.find((s) => s.id === target.id)!;
    expect(swapped.cityId).toBe(target.alternatives[0].cityId);
    expect([swapped.start, swapped.end]).toEqual([target.start, target.end]);
  });

  it("colours a stay by its night-weighted fit, with a week of avoid winning", () => {
    const base = { id: "s", cityId: "c", name: "C", start: "", end: "", nights: 0, kind: "base" as const, role: "base" as const, notes: [], costMonthlyEur: null, costSource: null, alternatives: [] };
    expect(stayLevel({ ...base, months: [{ ym: "2027-01", nights: 20, level: "great", why: "" }, { ym: "2027-02", nights: 10, level: "fair", why: "" }] })).toBe("good");
    expect(stayLevel({ ...base, months: [{ ym: "2027-01", nights: 20, level: "great", why: "" }, { ym: "2027-02", nights: 8, level: "avoid", why: "" }] })).toBe("avoid");
    expect(stayLevel({ ...base, months: [{ ym: "2027-01", nights: 20, level: "unknown", why: "" }] })).toBe("unknown");
  });
});
