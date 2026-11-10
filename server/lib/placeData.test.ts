import { describe, it, expect, beforeAll } from "vitest";
import { getCityById, loadCities } from "./cities";
import { placeFacts, resetPlaceData } from "./placeData";

beforeAll(() => {
  loadCities();
  resetPlaceData();
});

const facts = (id: string) => {
  const c = getCityById(id);
  if (!c) throw new Error(`no city ${id}`);
  return placeFacts(c);
};

describe("monthly cost", () => {
  it("puts every city on the country price level, so cities of one country cost the same", () => {
    // Cairo and Tbilisi are Eurostat duty stations; their correction coefficients priced them
    // three and two times Alexandria and Batumi.
    for (const [a, b] of [
      ["cairo-egypt", "alexandria-egypt"],
      ["tbilisi-georgia", "batumi-georgia"],
    ]) {
      const fa = facts(a);
      const fb = facts(b);
      expect(fa.cost.monthlyEur, a).not.toBeNull();
      expect(fa.cost.monthlyEur!.value, `${a} vs ${b}`).toBe(fb.cost.monthlyEur!.value);
      expect(fa.cost.monthlyEur!.granularity).toBe("country");
      expect(fa.cost.index!.unit).toBe("index (Belgium = 100)");
      expect(fa.scores.cost).toBe(fb.scores.cost);
    }
  });
});
