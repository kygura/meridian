import { describe, it, expect } from "vitest";
import { TRIP_COLORS, randomTripColor, resolveTripColor } from "./tripColors";

describe("tripColors", () => {
  it("has at least 12 distinct colors", () => {
    expect(new Set(TRIP_COLORS).size).toBeGreaterThanOrEqual(12);
  });
  it("randomTripColor avoids colors already in use", () => {
    const used = TRIP_COLORS.slice(0, TRIP_COLORS.length - 1);
    for (let i = 0; i < 20; i++) {
      expect(randomTripColor(used)).toBe(TRIP_COLORS[TRIP_COLORS.length - 1]);
    }
  });
  it("randomTripColor still returns a palette color when all are used", () => {
    expect(TRIP_COLORS).toContain(randomTripColor([...TRIP_COLORS]));
  });
  it("resolves legacy a/b/c and passes hexes through", () => {
    expect(resolveTripColor("a")).toBe("#b3261e");
    expect(resolveTripColor("b")).toBe("#0f766e");
    expect(resolveTripColor("c")).toBe("#6d28d9");
    expect(resolveTripColor("#123456")).toBe("#123456");
  });
});
