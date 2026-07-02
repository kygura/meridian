// Orchestrator: prices a single flight leg using real providers, preferring
// Duffel (bookable inventory) and falling back to SerpAPI/Google Flights
// (broader route coverage + real market price insight). Returns null when
// neither provider is configured or neither has a usable result, so callers
// fall back to their own placeholder pricing.

import { hasDuffelKey, searchFlights as duffelSearchFlights } from "./providers/duffel.js";
import {
  hasSerpApiKey,
  getFlightPriceInsight,
  searchFlightsFallback,
} from "./providers/serpapi.js";

export interface FlightEstimate {
  priceAmount: number;
  currency: string;
  airline?: string;
  departingAt?: string;
  arrivingAt?: string;
  source: "duffel" | "serpapi";
  /** How the cheapest fare compares to SerpAPI's typical price range, when available. */
  dealRating?: "low" | "typical" | "high";
}

export function hasFlightProvider(): boolean {
  return hasDuffelKey() || hasSerpApiKey();
}

export async function getFlightEstimate(params: {
  originIata: string;
  destinationIata: string;
  departureDate: string;
  returnDate?: string;
}): Promise<FlightEstimate | null> {
  if (!hasFlightProvider()) return null;

  let cheapest:
    | Pick<FlightEstimate, "priceAmount" | "currency" | "airline" | "departingAt" | "arrivingAt" | "source">
    | null = null;

  if (hasDuffelKey()) {
    const offers = await duffelSearchFlights({
      origin: params.originIata,
      destination: params.destinationIata,
      departureDate: params.departureDate,
      returnDate: params.returnDate,
    });
    const best = offers[0];
    if (best) {
      cheapest = {
        priceAmount: best.priceAmount,
        currency: best.currency,
        airline: best.airline,
        departingAt: best.departingAt,
        arrivingAt: best.arrivingAt,
        source: "duffel",
      };
    }
  }

  if (!cheapest && hasSerpApiKey()) {
    const offers = await searchFlightsFallback({
      departureId: params.originIata,
      arrivalId: params.destinationIata,
      outboundDate: params.departureDate,
      returnDate: params.returnDate,
    });
    const best = offers[0];
    if (best) {
      cheapest = {
        priceAmount: best.priceAmount,
        currency: best.currency,
        airline: best.airline,
        departingAt: best.departingAt,
        arrivingAt: best.arrivingAt,
        source: "serpapi",
      };
    }
  }

  if (!cheapest) return null;

  let dealRating: FlightEstimate["dealRating"];
  if (hasSerpApiKey()) {
    const insight = await getFlightPriceInsight({
      departureId: params.originIata,
      arrivalId: params.destinationIata,
      outboundDate: params.departureDate,
      returnDate: params.returnDate,
    });
    if (insight?.typicalPriceRange) {
      const [low, high] = insight.typicalPriceRange;
      dealRating = cheapest.priceAmount < low ? "low" : cheapest.priceAmount > high ? "high" : "typical";
    }
  }

  return { ...cheapest, dealRating };
}
