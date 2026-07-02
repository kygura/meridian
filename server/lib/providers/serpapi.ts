// SerpAPI Google Flights client — used for (1) real market price insight to
// grade Duffel/mock estimates as a deal, and (2) a fallback flight search
// when Duffel has no key configured or returns no offers for a route.
//
// Docs: https://serpapi.com/google-flights-api
//       https://serpapi.com/google-flights-price-insights

const SERPAPI_BASE = "https://serpapi.com/search";

export interface PriceInsight {
  lowestPrice: number;
  priceLevel: string; // "low" | "typical" | "high" (as returned by SerpAPI)
  typicalPriceRange: [number, number];
}

export interface FallbackFlightOffer {
  priceAmount: number;
  currency: string;
  airline: string;
  departingAt?: string;
  arrivingAt?: string;
  durationMinutes?: number;
  stops: number;
}

export function hasSerpApiKey(): boolean {
  return !!process.env.SERPAPI_KEY;
}

async function serpApiFlightsGet(params: Record<string, string>): Promise<any | null> {
  if (!hasSerpApiKey()) return null;
  const url = new URL(SERPAPI_BASE);
  url.searchParams.set("engine", "google_flights");
  url.searchParams.set("api_key", process.env.SERPAPI_KEY!);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error(`[serpapi] request failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("[serpapi] request error:", err);
    return null;
  }
}

function tripParams(params: {
  departureId: string;
  arrivalId: string;
  outboundDate: string;
  returnDate?: string;
  currency?: string;
}): Record<string, string> {
  return {
    departure_id: params.departureId,
    arrival_id: params.arrivalId,
    outbound_date: params.outboundDate,
    ...(params.returnDate ? { return_date: params.returnDate, type: "1" } : { type: "2" }),
    currency: params.currency ?? "USD",
  };
}

export async function getFlightPriceInsight(params: {
  departureId: string;
  arrivalId: string;
  outboundDate: string;
  returnDate?: string;
  currency?: string;
}): Promise<PriceInsight | null> {
  const json = await serpApiFlightsGet(tripParams(params));
  const insight = json?.price_insights;
  if (!insight) return null;
  return {
    lowestPrice: insight.lowest_price,
    priceLevel: insight.price_level,
    typicalPriceRange: insight.typical_price_range,
  };
}

export async function searchFlightsFallback(params: {
  departureId: string;
  arrivalId: string;
  outboundDate: string;
  returnDate?: string;
  currency?: string;
}): Promise<FallbackFlightOffer[]> {
  const json = await serpApiFlightsGet(tripParams(params));
  if (!json) return [];

  const all: any[] = [...(json.best_flights ?? []), ...(json.other_flights ?? [])];

  return all
    .map((f): FallbackFlightOffer => {
      const legs: any[] = f.flights ?? [];
      const first = legs[0];
      const last = legs[legs.length - 1];
      return {
        priceAmount: f.price,
        currency: params.currency ?? "USD",
        airline: first?.airline ?? "Unknown",
        departingAt: first?.departure_airport?.time,
        arrivingAt: last?.arrival_airport?.time,
        durationMinutes: f.total_duration,
        stops: Math.max(0, legs.length - 1),
      };
    })
    .sort((a, b) => a.priceAmount - b.priceAmount);
}
