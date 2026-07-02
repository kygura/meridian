// Duffel API client — real flight + stay inventory, used as the primary
// pricing source once DUFFEL_API_KEY is set. Falls back to empty arrays
// (caller decides what to do) when no key is configured.
//
// Docs: https://duffel.com/docs/api/overview/making-requests
//       https://duffel.com/docs/api/offer-requests/create-offer-request
//       https://duffel.com/docs/api/offers/schema

const DUFFEL_BASE = "https://api.duffel.com";

export interface FlightOffer {
  id: string;
  priceAmount: number;
  currency: string;
  airline: string;
  airlineIata?: string;
  departingAt?: string;
  arrivingAt?: string;
  durationMinutes?: number;
  stops: number;
}

export interface StayOffer {
  id: string;
  name: string;
  ratePerNight?: number;
  currency?: string;
  rating?: number;
}

export function hasDuffelKey(): boolean {
  return !!process.env.DUFFEL_API_KEY;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.DUFFEL_API_KEY}`,
    "Duffel-Version": "v2",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// Duffel slice duration is ISO 8601 ("PT2H30M"); parse to minutes.
function parseIsoDurationMinutes(iso?: string): number | undefined {
  if (!iso) return undefined;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!m) return undefined;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + mins;
}

export async function searchFlights(params: {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  passengers?: number;
  cabinClass?: "economy" | "premium_economy" | "business" | "first";
}): Promise<FlightOffer[]> {
  if (!hasDuffelKey()) return [];

  const slices: Array<{ origin: string; destination: string; departure_date: string }> = [
    { origin: params.origin, destination: params.destination, departure_date: params.departureDate },
  ];
  if (params.returnDate) {
    slices.push({
      origin: params.destination,
      destination: params.origin,
      departure_date: params.returnDate,
    });
  }

  const body = {
    data: {
      slices,
      passengers: Array.from({ length: params.passengers ?? 1 }, () => ({ type: "adult" })),
      cabin_class: params.cabinClass ?? "economy",
    },
  };

  try {
    const res = await fetch(`${DUFFEL_BASE}/air/offer_requests?return_offers=true`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[duffel] offer_requests failed: ${res.status} ${await res.text().catch(() => "")}`);
      return [];
    }

    const json = await res.json();
    const offers: any[] = json?.data?.offers ?? [];

    return offers
      .map((o): FlightOffer => {
        const slice0 = o.slices?.[0];
        const segments: any[] = slice0?.segments ?? [];
        const first = segments[0];
        const last = segments[segments.length - 1];
        return {
          id: o.id,
          priceAmount: Number(o.total_amount),
          currency: o.total_currency,
          airline: o.owner?.name ?? "Unknown",
          airlineIata: o.owner?.iata_code,
          departingAt: first?.departing_at,
          arrivingAt: last?.arriving_at,
          durationMinutes: parseIsoDurationMinutes(slice0?.duration),
          stops: Math.max(0, segments.length - 1),
        };
      })
      .sort((a, b) => a.priceAmount - b.priceAmount);
  } catch (err) {
    console.error("[duffel] searchFlights error:", err);
    return [];
  }
}

export async function searchStays(params: {
  latitude: number;
  longitude: number;
  checkInDate: string;
  checkOutDate: string;
  guests?: number;
  rooms?: number;
  radiusKm?: number;
}): Promise<StayOffer[]> {
  if (!hasDuffelKey()) return [];

  const body = {
    data: {
      location: {
        radius: params.radiusKm ?? 2,
        geographic_coordinates: { latitude: params.latitude, longitude: params.longitude },
      },
      check_in_date: params.checkInDate,
      check_out_date: params.checkOutDate,
      rooms: params.rooms ?? 1,
      guests: Array.from({ length: params.guests ?? 1 }, () => ({ type: "adult" })),
    },
  };

  try {
    const res = await fetch(`${DUFFEL_BASE}/stays/search`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[duffel] stays/search failed: ${res.status} ${await res.text().catch(() => "")}`);
      return [];
    }

    const json = await res.json();
    // NOTE: exact result field names (rate/price/rating) weren't fully
    // documented in the public guide at time of writing — verify against a
    // live sandbox response and adjust these accessors once DUFFEL_API_KEY
    // is set. Optional chaining below keeps this from throwing either way.
    const results: any[] = json?.data?.results ?? [];

    return results
      .map((r): StayOffer => ({
        id: r.search_result_id ?? r.id,
        name: r.accommodation?.name ?? "Unknown property",
        ratePerNight: r.cheapest_rate_total_amount ? Number(r.cheapest_rate_total_amount) : undefined,
        currency: r.cheapest_rate_currency,
        rating: r.accommodation?.rating,
      }))
      .sort((a, b) => (a.ratePerNight ?? Infinity) - (b.ratePerNight ?? Infinity));
  } catch (err) {
    console.error("[duffel] searchStays error:", err);
    return [];
  }
}
