import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ImportError } from "../imports";
import { MAX_UPLOAD_BYTES, parseEmailUpload, splitMbox } from "./jsonld";

const FIX = join(__dirname, "..", "__fixtures__", "ingest");
const fixture = (name: string) => readFileSync(join(FIX, name));
const parse = (name: string) => parseEmailUpload(fixture(name));

/** Minimal single-part HTML email around raw JSON-LD script bodies. */
function mail(id: string | null, ...scripts: string[]) {
  return Buffer.from(
    `${id ? `Message-ID: <${id}>\n` : ""}Content-Type: text/html; charset=utf-8\n\n<html><head>${scripts.map((s) => `<script type="application/ld+json">${s}</script>`).join("")}</head></html>\n`,
  );
}

type Cand = { kind: string; payload: Record<string, unknown>; provenance: { source: string; sourceRef: string; confidence: string } };
const cands = (r: { candidates: unknown[] }) => r.candidates as Cand[];

describe("reservation types", () => {
  it("FlightReservation → flight segment with IATA hints, number, cost, high confidence (quoted-printable)", () => {
    const r = parse("flight.eml");
    expect(r).toMatchObject({ messages: 1, unstructured: 0, errors: [] });
    expect(cands(r)).toEqual([
      {
        kind: "segment",
        payload: {
          mode: "flight",
          iataHint: "LHR",
          toIataHint: "LIS",
          departAt: "2024-05-02T09:05:00+01:00",
          arriveAt: "2024-05-02T11:35:00+01:00",
          carrier: "TAP Air Portugal",
          number: "TP1355",
          bookingRef: "XK7P2Q",
          cost: { amount: 189.5, currency: "EUR" },
        },
        provenance: { source: "jsonld", sourceRef: "flight-out-xk7p2q@mail.tap.example#0", confidence: "high" },
      },
    ]);
  });

  it("LodgingReservation → lodging with arrive/depart, cityHint, kind (base64, JSON-LD as an array)", () => {
    expect(cands(parse("lodging.eml"))).toMatchObject([
      {
        kind: "lodging",
        payload: { name: "Hotel Avenida Palace", kind: "hotel", cityHint: "Lisbon", arrive: "2024-05-02", depart: "2024-05-06", cost: { amount: 640, currency: "EUR" } },
        provenance: { confidence: "medium", sourceRef: "hotel-lisbon-hap88231@mail.hotel.example#0" },
      },
    ]);
  });

  it("EventReservation → experience kind event with date, city and geo (ISO-8859-1 quoted-printable)", () => {
    expect(cands(parse("event.eml"))).toMatchObject([
      {
        kind: "experience",
        payload: { title: "Noite de Fado no Teatro São Luiz", kind: "event", date: "2024-05-04", cityHint: "Lisbon", lat: 38.7107, lng: -9.1427, cost: { amount: 35, currency: "EUR" } },
        provenance: { confidence: "medium" },
      },
    ]);
  });

  it("TrainReservation (inside @graph) → train segment between station cities", () => {
    expect(cands(parse("train.eml"))).toMatchObject([
      {
        kind: "segment",
        payload: { mode: "train", cityHint: "Lisbon", toCityHint: "Porto", departAt: "2024-05-06T12:30:00+01:00", number: "122", carrier: "CP - Comboios de Portugal", cost: { amount: 31.5, currency: "EUR" } },
      },
    ]);
  });

  it("RentalCarReservation → car segment pickup → dropoff", () => {
    expect(cands(parse("rentalcar.eml"))).toMatchObject([
      { kind: "segment", payload: { mode: "car", cityHint: "Porto", toCityHint: "Porto", departAt: "2024-05-07T10:00:00+01:00", arriveAt: "2024-05-08T18:00:00+01:00", carrier: "Sixt" } },
    ]);
  });

  it("tolerates strings vs objects, arrays, @graph, schema.org URLs and numbers as strings", () => {
    const r = parseEmailUpload(
      mail(
        "odd@x",
        JSON.stringify([
          {
            "@type": ["http://schema.org/FlightReservation"],
            totalPrice: "EUR 1.234,50",
            reservationFor: [
              { "@type": "Flight", flightNumber: 77, airline: "Iberia", departureAirport: "mad", arrivalAirport: { iataCode: "LIS" }, departureTime: "2024-05-02 09:05", arrivalTime: "2024-05-02T10:00" },
              { "@type": "Flight", flightNumber: "IB78", airline: { name: "Iberia", iataCode: "IB" }, departureAirport: { iataCode: "LIS" }, arrivalAirport: { iataCode: "MAD" }, departureTime: "2024-05-03T09:05" },
            ],
          },
          { "@graph": [{ "@type": "EventReservation", reservationFor: { "@type": "Event", name: "Gig", startDate: "2024-05-04", location: "Somewhere" } }] },
        ]),
      ),
    );
    expect(r.errors).toEqual([]);
    const c = cands(r);
    expect(c.map((x) => x.provenance.sourceRef)).toEqual(["odd@x#0", "odd@x#1", "odd@x#2"]);
    expect(c[0].payload).toMatchObject({ iataHint: "MAD", toIataHint: "LIS", number: "77", carrier: "Iberia", departAt: "2024-05-02T09:05", cost: { amount: 1234.5, currency: "EUR" } });
    expect(c[1].payload).toMatchObject({ number: "IB78", carrier: "Iberia" });
    expect(c[1].payload.cost).toBeUndefined(); // the total is attached to the first leg only
    expect(c[2].payload).toMatchObject({ title: "Gig", date: "2024-05-04", cityHint: "Somewhere" });
  });

  it("a flight with only city names is medium confidence", () => {
    const r = parseEmailUpload(
      mail("c@x", JSON.stringify({ "@type": "FlightReservation", reservationFor: { "@type": "Flight", departureAirport: { name: "x", address: { addressLocality: "Madrid" } }, arrivalAirport: { iataCode: "LIS" }, departureTime: "2024-05-02T09:05" } })),
    );
    expect(cands(r)[0]).toMatchObject({ payload: { cityHint: "Madrid", toIataHint: "LIS" }, provenance: { confidence: "medium" } });
  });
});

describe("encodings and structure", () => {
  it("handles CRLF line endings", () => {
    const crlf = Buffer.from(fixture("flight.eml").toString("latin1").replace(/\n/g, "\r\n"), "latin1");
    expect(cands(parseEmailUpload(crlf))).toHaveLength(1);
    const lodging = Buffer.from(fixture("lodging.eml").toString("latin1").replace(/\n/g, "\r\n"), "latin1");
    expect(cands(parseEmailUpload(lodging))).toHaveLength(1);
  });

  it("decodes latin1 and utf-8 8bit bodies by charset", () => {
    // Latin-1 raw bytes in an 8bit body: "São" is 53 E3 6F.
    const body = Buffer.concat([
      Buffer.from('Message-ID: <l1@x>\nContent-Type: text/html; charset=iso-8859-1\nContent-Transfer-Encoding: 8bit\n\n<script type="application/ld+json">{"@type":"EventReservation","reservationFor":{"@type":"Event","name":"S'),
      Buffer.from([0xe3]),
      Buffer.from('o Jo","startDate":"2024-06-01","location":{"address":{"addressLocality":"Lisbon"}}}}</script>'),
    ]);
    expect(cands(parseEmailUpload(body))[0].payload.title).toBe("São Jo");
    // The utf-8 fixture keeps accents too.
    expect(cands(parse("train.eml"))[0].payload.carrier).toBe("CP - Comboios de Portugal");
  });

  it("splits an mbox on From lines and undoes >From quoting", () => {
    const text = fixture("trip-lisbon-porto-2024-05.mbox").toString("latin1");
    const msgs = splitMbox(text);
    expect(msgs).toHaveLength(7);
    expect(msgs[2]).toContain("\nFrom the notes we made last week:");
    expect(msgs[2]).toContain("\n>From the airport take the metro");
    expect(msgs[2]).toContain("\n>>From there walk.");
    expect(msgs[2]).not.toMatch(/^From 1790/m);
    // A plain .eml is one message.
    expect(splitMbox(fixture("flight.eml").toString("latin1"))).toHaveLength(1);
  });

  it("parses the whole mbox: 6 candidates, 1 unstructured, stable sourceRefs", () => {
    const r = parse("trip-lisbon-porto-2024-05.mbox");
    expect(r).toMatchObject({ messages: 7, unstructured: 1, errors: [] });
    expect(cands(r).map((c) => c.kind)).toEqual(["segment", "lodging", "experience", "segment", "lodging", "segment"]);
    expect(new Set(cands(r).map((c) => c.provenance.sourceRef)).size).toBe(6);
  });
});

describe("unstructured, bad input and caps", () => {
  it("counts emails without markup as unstructured", () => {
    expect(parse("unstructured.eml")).toMatchObject({ messages: 1, unstructured: 1, candidates: [] });
    // Markup that is not a reservation is still "no reservation markup".
    expect(parseEmailUpload(mail("o@x", JSON.stringify({ "@type": "Organization", name: "x" })))).toMatchObject({ unstructured: 1, candidates: [] });
  });

  it("reports broken JSON-LD and unmappable reservations, never throws on them", () => {
    const r = parseEmailUpload(mail("bad@x", "{not json", JSON.stringify({ "@type": "FlightReservation", reservationFor: { "@type": "Flight" } })));
    expect(r.candidates).toEqual([]);
    expect(r.unstructured).toBe(0);
    expect(r.errors).toEqual(expect.arrayContaining([expect.stringContaining("invalid JSON-LD"), expect.stringContaining("FlightReservation without usable")]));
  });

  it("skips cancelled reservations", () => {
    const r = parseEmailUpload(
      mail("x@x", JSON.stringify({ "@type": "EventReservation", reservationStatus: "http://schema.org/ReservationCancelled", reservationFor: { "@type": "Event", name: "Gig", startDate: "2024-05-04" } })),
    );
    expect(r.candidates).toEqual([]);
  });

  it("falls back to a content hash when there is no Message-ID", () => {
    const r = parseEmailUpload(mail(null, JSON.stringify({ "@type": "EventReservation", reservationFor: { "@type": "Event", name: "Gig", startDate: "2024-05-04" } })));
    expect(cands(r)[0].provenance.sourceRef).toMatch(/^sha1-[0-9a-f]{24}#0$/);
  });

  it("refuses uploads over 25 MB, and skips (reports) a single oversized message", () => {
    expect(() => parseEmailUpload(new Uint8Array(MAX_UPLOAD_BYTES + 1))).toThrow(ImportError);
    const huge = Buffer.from(`Message-ID: <big@x>\nContent-Type: text/html\n\n${"x".repeat(5 * 1024 * 1024 + 10)}`);
    const r = parseEmailUpload(huge);
    expect(r.errors[0]).toMatch(/larger than 5 MB/);
    expect(r.candidates).toEqual([]);
  });

  it("refuses more than 20k messages", () => {
    const one = "From a@b Mon Jan 01 00:00:00 2024\nSubject: x\n\nhi\n";
    expect(() => parseEmailUpload(Buffer.from(one.repeat(20_001)))).toThrow(expect.objectContaining({ status: 413, body: { error: "too_many_messages", max: 20_000 } }));
  });
});

describe("hostile input", () => {
  const raw = (html: string) => Buffer.from(`Content-Type: text/html; charset=utf-8\n\n${html}\n`);

  it("unclosed <script> tags are scanned in linear time", () => {
    const t = Date.now();
    for (const html of ['<script type="application/ld+json">'.repeat(40_000), "<script ".repeat(80_000), "<SCRIPT TYPE='application/ld+json'>{".repeat(30_000)]) {
      expect(parseEmailUpload(raw(html))).toMatchObject({ messages: 1, unstructured: 1 });
    }
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("error list stays capped (50) however many broken blocks there are", () => {
    const r = parseEmailUpload(raw('<script type="application/ld+json">{</script>'.repeat(100_000)));
    expect(r.errors.length).toBeLessThanOrEqual(50);
  });

  it("tag and type matching is case-insensitive and blocks after a non-ld script are found", () => {
    const ld = JSON.stringify({ "@type": "EventReservation", reservationFor: { name: "Fado", startDate: "2024-05-04", location: { address: { addressLocality: "Lisbon" } } } });
    const r = parseEmailUpload(raw(`<script>var a = 1;</script><SCRIPT type='Application/LD+JSON' >${ld}</SCRIPT >`));
    expect(cands(r)).toHaveLength(1);
  });
});

describe("city hint country", () => {
  const stay = (country: string) =>
    cands(
      parseEmailUpload(
        mail("c" + country, JSON.stringify({ "@type": "LodgingReservation", reservationFor: { "@type": "Hotel", name: "H", address: { addressLocality: "Berlin", addressCountry: country } }, checkinDate: "2024-05-02" })),
      ),
    )[0].payload.cityHint;

  it("ISO alpha-3 codes and native spellings become English names; other short codes are dropped", () => {
    expect(stay("DEU")).toBe("Berlin, Germany");
    expect(stay("Deutschland")).toBe("Berlin, Germany");
    expect(stay("Germany")).toBe("Berlin, Germany");
    expect(stay("DE")).toBe("Berlin");
  });
});
