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

// ── Booking flow (orders) — TEST MODE ONLY ──────────────────────────
//
// This project only ever runs against `duffel_test_...` tokens. Payments use
// `type: "balance"`, which Duffel documents as unlimited in test mode ("In test
// mode, your balance is unlimited."). No card/real-money path exists here by
// construction. See docs/research-apis.md §1.

/** Thrown when Duffel refuses an offer that has expired. Callers map this to a
 *  409 telling the client to re-search rather than retry the same offer. */
export class DuffelOfferExpiredError extends Error {
  constructor(message = "Duffel offer has expired") {
    super(message);
    this.name = "DuffelOfferExpiredError";
  }
}

export interface DuffelPassengerInput {
  title: string;
  givenName: string;
  familyName: string;
  bornOn: string; // YYYY-MM-DD
  gender: string;
  email: string;
  phoneNumber: string;
}

export interface DuffelOrderResult {
  id: string;
  bookingReference: string;
  totalAmount: string;
  totalCurrency: string;
  liveMode: boolean;
}

export interface DuffelBookingOfferSegment {
  originIata?: string;
  destinationIata?: string;
  departingAt?: string;
  arrivingAt?: string;
  carrier: string;
  carrierIata?: string;
}

export interface DuffelBookingOffer {
  id: string;
  priceAmount: number;
  currency: string;
  carrier: string;
  carrierIata?: string;
  segments: DuffelBookingOfferSegment[];
  durationMinutes?: number;
  stops: number;
  expiresAt: string;
  departingAt?: string;
  arrivingAt?: string;
}

// Duffel signals an unusable/expired offer via an `errors[].code`. The exact
// code string is UNCONFIRMED in research-apis.md (the offers/response-handling
// pages could not be fetched verbatim), so match defensively on known variants.
function looksLikeOfferExpired(bodyText: string): boolean {
  const t = bodyText.toLowerCase();
  return (
    t.includes("offer_expired") ||
    t.includes("offer_no_longer_available") ||
    t.includes("offer_request_already_processed") ||
    t.includes("expired")
  );
}

/** Richer offer search for the booking pipeline — keeps `expires_at` and
 *  per-segment detail that the pricing-only `searchFlights` drops. */
export async function searchBookingOffers(params: {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  passengers?: number;
  cabinClass?: "economy" | "premium_economy" | "business" | "first";
}): Promise<DuffelBookingOffer[]> {
  if (!hasDuffelKey()) return [];

  const slices: Array<{ origin: string; destination: string; departure_date: string }> = [
    { origin: params.origin, destination: params.destination, departure_date: params.departureDate },
  ];
  if (params.returnDate) {
    slices.push({ origin: params.destination, destination: params.origin, departure_date: params.returnDate });
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
      console.error(`[duffel] searchBookingOffers failed: ${res.status} ${await res.text().catch(() => "")}`);
      return [];
    }
    const json = await res.json();
    const offers: any[] = json?.data?.offers ?? [];

    return offers
      .map((o): DuffelBookingOffer => {
        const slice0 = o.slices?.[0];
        const rawSegments: any[] = (o.slices ?? []).flatMap((s: any) => s.segments ?? []);
        const segments: DuffelBookingOfferSegment[] = rawSegments.map((seg) => ({
          originIata: seg.origin?.iata_code,
          destinationIata: seg.destination?.iata_code,
          departingAt: seg.departing_at,
          arrivingAt: seg.arriving_at,
          carrier: seg.operating_carrier?.name ?? seg.marketing_carrier?.name ?? o.owner?.name ?? "Unknown",
          carrierIata: seg.operating_carrier?.iata_code ?? seg.marketing_carrier?.iata_code,
        }));
        const first = rawSegments[0];
        const last = rawSegments[rawSegments.length - 1];
        return {
          id: o.id,
          priceAmount: Number(o.total_amount),
          currency: o.total_currency,
          carrier: o.owner?.name ?? "Unknown",
          carrierIata: o.owner?.iata_code,
          segments,
          durationMinutes: parseIsoDurationMinutes(slice0?.duration),
          stops: Math.max(0, (slice0?.segments?.length ?? 1) - 1),
          // expires_at drives the offer_expired guard; default to now if Duffel
          // ever omits it so the offer reads as immediately stale (fail-safe).
          expiresAt: o.expires_at ?? new Date().toISOString(),
          departingAt: first?.departing_at,
          arrivingAt: last?.arriving_at,
        };
      })
      .sort((a, b) => a.priceAmount - b.priceAmount);
  } catch (err) {
    console.error("[duffel] searchBookingOffers error:", err);
    return [];
  }
}

/** Re-fetch a single offer right before ordering. Duffel recommends this to get
 *  authoritative pricing and the passenger IDs the order body must reference. */
export async function getOffer(offerId: string): Promise<any> {
  const res = await fetch(`${DUFFEL_BASE}/air/offers/${offerId}`, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (looksLikeOfferExpired(text)) throw new DuffelOfferExpiredError();
    throw new Error(`[duffel] getOffer failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  return json?.data;
}

/** Create an instant order paid from the (unlimited, in test mode) balance.
 *  Throws DuffelOfferExpiredError if the offer is stale. */
export async function createOrder(params: {
  offerId: string;
  passengers: DuffelPassengerInput[];
  amount: string;
  currency: string;
}): Promise<DuffelOrderResult> {
  // Re-fetch the offer for authoritative price + passenger IDs.
  const offer = await getOffer(params.offerId);

  // Proactive expiry guard — Duffel's own best practice is to check expires_at
  // client-side before calling create-order to avoid the offer_expired error.
  if (offer?.expires_at && new Date(offer.expires_at).getTime() <= Date.now()) {
    throw new DuffelOfferExpiredError();
  }

  // Zip our passenger details onto Duffel's offer passenger IDs, in order. The
  // order body keys each passenger by the `id` returned from the offer request.
  const offerPassengers: any[] = offer?.passengers ?? [];
  const passengers = params.passengers.map((p, i) => ({
    id: offerPassengers[i]?.id, // may be undefined if counts drift — Duffel will reject, which is correct
    title: p.title,
    given_name: p.givenName,
    family_name: p.familyName,
    born_on: p.bornOn,
    gender: p.gender,
    email: p.email,
    phone_number: p.phoneNumber,
  }));

  // Payment must match the offer total EXACTLY; prefer the freshly-fetched
  // amount/currency over whatever the caller passed.
  const amount = String(offer?.total_amount ?? params.amount);
  const currency = offer?.total_currency ?? params.currency;

  const body = {
    data: {
      type: "instant",
      selected_offers: [params.offerId],
      passengers,
      payments: [{ type: "balance", amount, currency }],
    },
  };

  const res = await fetch(`${DUFFEL_BASE}/air/orders`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (looksLikeOfferExpired(text)) throw new DuffelOfferExpiredError();
    throw new Error(`[duffel] createOrder failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  const order = json?.data;
  return {
    id: order?.id,
    bookingReference: order?.booking_reference ?? order?.booking_references?.[0]?.reference ?? "",
    totalAmount: order?.total_amount ?? amount,
    totalCurrency: order?.total_currency ?? currency,
    liveMode: !!order?.live_mode,
  };
}

/** Cancel an order in test mode.
 *
 *  UNCONFIRMED: research-apis.md only states Duffel Airways "supports
 *  cancellations" — it does not document the exact endpoints/params. This
 *  implements the documented public Duffel two-step pattern (create a pending
 *  cancellation, then confirm it). Re-verify against the live OpenAPI spec
 *  before relying on it against a real sandbox. Written defensively so a
 *  shape mismatch degrades to a thrown error rather than a silent success. */
export async function cancelOrder(orderId: string): Promise<{ id: string; status: string } | null> {
  // 1) Create a pending cancellation.
  const createRes = await fetch(`${DUFFEL_BASE}/air/order_cancellations`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ data: { order_id: orderId } }),
  });
  if (!createRes.ok) {
    throw new Error(`[duffel] cancelOrder(create) failed: ${createRes.status} ${await createRes.text().catch(() => "")}`);
  }
  const createJson = await createRes.json();
  const cancellationId = createJson?.data?.id;
  if (!cancellationId) return null;

  // 2) Confirm the cancellation.
  const confirmRes = await fetch(
    `${DUFFEL_BASE}/air/order_cancellations/${cancellationId}/actions/confirm`,
    { method: "POST", headers: authHeaders() },
  );
  if (!confirmRes.ok) {
    throw new Error(`[duffel] cancelOrder(confirm) failed: ${confirmRes.status} ${await confirmRes.text().catch(() => "")}`);
  }
  const confirmJson = await confirmRes.json();
  return { id: confirmJson?.data?.id ?? cancellationId, status: "cancelled" };
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
