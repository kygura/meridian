import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TMP_DATA: string;

import bookings from "./bookings";

const PASSENGER = {
  title: "mr",
  givenName: "Ada",
  familyName: "Lovelace",
  bornOn: "1990-12-10",
  gender: "f",
  email: "ada@example.com",
  phoneNumber: "+442071234567",
};

async function post(path: string, body: unknown) {
  return bookings.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  delete process.env.DUFFEL_API_KEY;
});

afterAll(() => {
  rmSync(TMP_DATA, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  TMP_DATA = mkdtempSync(join(tmpdir(), "meridian-bookings-route-"));
  process.env.DATA_DIR = TMP_DATA;
});

describe("POST /search", () => {
  it("returns mock offers with a source label", async () => {
    const res = await post("/search", {
      originIata: "LHR",
      destinationIata: "JFK",
      departureDate: "2026-09-01",
      passengers: 1,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe("mock");
    expect(Array.isArray(json.offers)).toBe(true);
    expect(json.offers.length).toBeGreaterThan(0);
  });

  it("400s on a bad passenger count", async () => {
    const res = await post("/search", {
      originIata: "LHR",
      destinationIata: "JFK",
      departureDate: "2026-09-01",
      passengers: 42,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues).toBeTruthy();
  });
});

describe("POST / — zod validation of passengers", () => {
  async function firstOffer() {
    const res = await post("/search", { originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    const { offers } = await res.json();
    return offers[0];
  }

  it("rejects a passenger missing bornOn", async () => {
    const offer = await firstOffer();
    const { bornOn, ...bad } = PASSENGER;
    const res = await post("/", {
      offerId: offer.id,
      passengers: [bad],
      searchSnapshot: { offer, leg: { originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01" } },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(JSON.stringify(json.issues)).toContain("bornOn");
  });

  it("rejects a passenger with a bad email", async () => {
    const offer = await firstOffer();
    const res = await post("/", {
      offerId: offer.id,
      passengers: [{ ...PASSENGER, email: "not-an-email" }],
      searchSnapshot: { offer, leg: { originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01" } },
    });
    expect(res.status).toBe(400);
  });
});

describe("full mock cycle: search -> create -> list -> get -> cancel", () => {
  it("walks the happy path with correct statuses", async () => {
    const searchRes = await post("/search", { originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    const { offers } = await searchRes.json();
    const offer = offers[0];

    const createRes = await post("/", {
      offerId: offer.id,
      tripId: "trip-9",
      legIndex: 1,
      passengers: [PASSENGER],
      searchSnapshot: { offer, leg: { originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01" } },
    });
    expect(createRes.status).toBe(201);
    const { booking } = await createRes.json();
    expect(booking.status).toBe("booked");
    expect(booking.bookingReference).toMatch(/^[A-Z0-9]{6}$/);

    const listRes = await bookings.request("/");
    const { bookings: list } = await listRes.json();
    expect(list.some((b: { id: string }) => b.id === booking.id)).toBe(true);

    const getRes = await bookings.request(`/${booking.id}`);
    expect(getRes.status).toBe(200);
    const { booking: got } = await getRes.json();
    expect(got.id).toBe(booking.id);

    const delRes = await bookings.request(`/${booking.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const { booking: cancelled } = await delRes.json();
    expect(cancelled.status).toBe("cancelled");
  });

  it("404s for an unknown booking on GET and DELETE", async () => {
    expect((await bookings.request("/does-not-exist")).status).toBe(404);
    expect((await bookings.request("/does-not-exist", { method: "DELETE" })).status).toBe(404);
  });

  it("409s with an offer_expired signal when the snapshot offer has expired", async () => {
    const searchRes = await post("/search", { originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01", passengers: 1 });
    const { offers } = await searchRes.json();
    const expired = { ...offers[0], expiresAt: new Date(Date.now() - 60_000).toISOString() };
    const res = await post("/", {
      offerId: expired.id,
      passengers: [PASSENGER],
      searchSnapshot: { offer: expired, leg: { originIata: "LHR", destinationIata: "JFK", departureDate: "2026-09-01" } },
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("offer_expired");
    expect(json.message.toLowerCase()).toContain("search");
  });
});
