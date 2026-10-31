import { describe, expect, it } from "vitest";
import type { Journey, Money } from "../../../types";
import { ratesFromJourneys } from "./money";

const money = (amount: number, currency: string, eur: number, rateDate: string): Money => ({ amount, currency, eur, rateDate });

function journey(costs: Money[]): Journey {
  return {
    stops: costs.map((cost) => ({ lodging: { cost } })),
    segments: [],
    experiences: [],
  } as unknown as Journey;
}

describe("ratesFromJourneys", () => {
  it("is empty without journeys or foreign amounts", () => {
    expect(ratesFromJourneys(null)).toEqual({});
    expect(ratesFromJourneys([journey([money(100, "EUR", 100, "2024-05-01")])])).toEqual({});
  });

  it("derives EUR per unit and keeps the newest rate per currency", () => {
    const rates = ratesFromJourneys([
      journey([money(100, "USD", 90, "2024-01-01")]),
      journey([money(200, "USD", 184, "2024-06-01"), money(50, "GBP", 58, "2024-06-01")]),
    ]);
    expect(rates.USD).toEqual({ rate: 0.92, date: "2024-06-01" });
    expect(rates.GBP?.rate).toBeCloseTo(1.16);
  });
});
