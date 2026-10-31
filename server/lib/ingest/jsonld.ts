// Deterministic e-mail ingestion (spec-journal §7 source 2): .eml / Google Takeout .mbox →
// schema.org JSON-LD reservations → ImportCandidate inputs (source "jsonld"). Stdlib only,
// no LLM. Emails without reservation markup are counted, never guessed at.
//
// The whole file is handled as a binary (latin1) string so 8-bit bodies survive; bytes are
// turned into text only after the transfer encoding is undone, using the part's charset.
// Defensive caps: upload size, message count, per-message size, MIME depth / part count.
// Nothing here evaluates input; JSON.parse failures are reported and skipped.

import type { ImportCandidate } from "../../../src/types.js";
import { isoDateOrDateTimeSchema } from "../journalSchemas.js";
import { ImportError } from "../imports.js";
import { countryName, shortHash } from "./geo.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGES = 20_000;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_MIME_DEPTH = 8;
const MAX_PARTS = 200;
const MAX_ERRORS = 50;

export interface EmailParse {
  /** Candidate inputs (unvalidated shape; addCandidates validates). */
  candidates: unknown[];
  messages: number;
  /** Messages with no recognised reservation markup. */
  unstructured: number;
  /** Cancelled reservations, mapped like candidates: they flag the confirmation they cancel (imports.flagCancelled). */
  cancelled: unknown[];
  errors: string[];
}

// ── mbox / MIME ─────────────────────────────────────────────────────

// "From 1790…@xxx Wed Mar 06 14:07:12 +0000 2024" (Takeout) / "From MAILER-DAEMON Fri Jul  8 12:08:34 2011".
const MBOX_SEP = /^From \S+[ \t]+(?:[A-Za-z]{3},?[ \t]+)?[A-Za-z]{3}[ \t]+\d{1,2}[ \t]+\d{1,2}:\d{2}[^\r\n]*\r?\n?/gm;

/** Splits an mbox on its "From " lines and undoes mboxrd ">From " quoting. A single .eml comes back as one message. */
export function splitMbox(bin: string): string[] {
  const seps = [...bin.matchAll(MBOX_SEP)];
  if (!seps.length || seps[0].index !== 0) return [bin];
  const out: string[] = [];
  seps.forEach((m, i) => {
    const end = seps[i + 1]?.index ?? bin.length;
    out.push(bin.slice(m.index! + m[0].length, end).replace(/^>(>*From )/gm, "$1"));
  });
  return out;
}

interface Mime {
  headers: Map<string, string>;
  body: string;
}

function parseMime(raw: string): Mime {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = (m ? raw.slice(0, m.index) : raw).replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      if (!headers.has(k)) headers.set(k, line.slice(i + 1).trim());
    }
  }
  return { headers, body: m ? raw.slice(m.index + m[0].length) : "" };
}

function param(value: string, name: string): string | undefined {
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return m?.[1] ?? m?.[2];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function decodeText(body: string, cte: string | undefined, charset: string | undefined): string {
  const enc = (cte ?? "7bit").trim().toLowerCase();
  let bytes: Buffer;
  if (enc === "base64") bytes = Buffer.from(body.replace(/[^A-Za-z0-9+/]/g, ""), "base64");
  else if (enc === "quoted-printable") {
    const t = body.replace(/=[ \t]*\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    bytes = Buffer.from(t, "latin1");
  } else bytes = Buffer.from(body, "latin1");
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder((charset ?? "utf-8").trim().toLowerCase());
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

/** Decoded text/html bodies of a message, descending through multipart/* (bounded). */
function htmlParts(raw: string, depth = 0, out: string[] = [], budget = { parts: 0 }): string[] {
  const { headers, body } = parseMime(raw);
  const ct = headers.get("content-type") ?? "text/plain";
  const type = ct.split(";")[0].trim().toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = param(ct, "boundary");
    if (!boundary || depth >= MAX_MIME_DEPTH) return out;
    const delim = new RegExp(`(?:^|\\r?\\n)--${escapeRe(boundary)}(?:--)?[ \\t]*(?:\\r?\\n|$)`);
    for (const part of body.split(delim).slice(1)) {
      if (++budget.parts > MAX_PARTS) break;
      htmlParts(part, depth + 1, out, budget);
    }
  } else if (type === "text/html") {
    out.push(decodeText(body, headers.get("content-transfer-encoding"), param(ct, "charset")));
  }
  return out;
}

const MAX_LD_BLOCKS = 200;
const LD_TYPE = /\btype\s*=\s*["']?application\/ld\+json/i;

/** Every parseable <script type="application/ld+json"> block; broken JSON is reported, not thrown.
 *  Linear scan (indexOf only): a hostile part with unclosed tags cannot cause quadratic regex work. */
function extractJsonLd(html: string, note: (msg: string) => void, label: string): unknown[] {
  const blocks: unknown[] = [];
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase()); // ASCII-only: keeps offsets aligned
  let pos = 0, seen = 0;
  while (seen < MAX_LD_BLOCKS) {
    const open = lower.indexOf("<script", pos);
    if (open < 0) break;
    const tagEnd = html.indexOf(">", open);
    if (tagEnd < 0) break;
    pos = tagEnd + 1;
    if (!LD_TYPE.test(html.slice(open + 7, tagEnd))) continue;
    const close = lower.indexOf("</script", pos);
    if (close < 0) break;
    pos = close + 8;
    seen++;
    try {
      blocks.push(JSON.parse(html.slice(tagEnd + 1, close).replace(/^\uFEFF/, "").trim()));
    } catch {
      note(`${label}: invalid JSON-LD block skipped`);
    }
  }
  return blocks;
}

// ── schema.org helpers ──────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const cut = (s: string | undefined, n: number) => (s ? s.slice(0, n).trim() || undefined : undefined);

/** String or number → trimmed string (arrays: first element). */
function str(v: unknown): string | undefined {
  const x = list(v)[0];
  if (typeof x === "string") return x.trim() || undefined;
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  return undefined;
}
const obj = (v: unknown): Obj | undefined => list(v).find(isObj);
/** Name of a thing given as a string or as {name}. */
const nameOf = (v: unknown): string | undefined => str(v) ?? str(obj(v)?.name);
const typeNames = (t: unknown): string[] => list(t).filter((x): x is string => typeof x === "string").map((x) => x.split(/[/#]/).pop()!);

/** "LIS" or {iataCode:"LIS"}. */
function iataOf(v: unknown): string | undefined {
  const code = str(obj(v)?.iataCode) ?? str(v);
  return code && /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : undefined;
}

/** City name for a place: address.addressLocality (+ country, as an English name), else the place's own name. */
function cityOf(v: unknown): string | undefined {
  const place = obj(v);
  const addr = place?.address;
  const locality = str(obj(addr)?.addressLocality);
  if (locality) {
    const raw = nameOf(obj(addr)?.addressCountry);
    const country = raw && countryName(raw);
    return cut(country ? `${locality}, ${country}` : locality, 200);
  }
  return cut(nameOf(place) ?? str(v), 200);
}

function dt(v: unknown): string | undefined {
  const s = str(v)?.replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, "$1T");
  return s && isoDateOrDateTimeSchema.safeParse(s).success ? s : undefined;
}

/** "1,234.50" / "1.234,50" / "245,6" / 245 → number. */
function amountOf(s: string): number {
  let t = s.replace(/[^\d.,-]/g, "");
  const comma = t.lastIndexOf(","), dot = t.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) t = comma > dot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (comma >= 0) t = /,\d{1,2}$/.test(t) && t.indexOf(",") === comma ? t.replace(",", ".") : t.replace(/,/g, "");
  else if ((t.match(/\./g) ?? []).length > 1) t = t.replace(/\./g, "");
  return Number(t);
}

function priceOf(r: Obj): { amount: number; currency: string } | undefined {
  let v: unknown = list(r.totalPrice ?? r.price)[0];
  let currency = str(r.priceCurrency);
  if (isObj(v)) {
    currency ??= str(v.priceCurrency ?? v.currency);
    v = v.price ?? v.value ?? v.amount;
  }
  const s = str(v);
  if (!s) return undefined;
  currency ??= /[A-Za-z]{3}/.exec(s)?.[0];
  const amount = amountOf(s);
  if (!currency || !/^[A-Za-z]{3}$/.test(currency) || !Number.isFinite(amount) || amount < 0) return undefined;
  return { amount, currency: currency.toUpperCase() };
}

const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

interface Mapped {
  kind: ImportCandidate["kind"];
  payload: Obj;
  confidence: "high" | "medium";
}

/** departAt must exist; arriveAt that precedes it by date is dropped (the journal would refuse it). */
function times(depart: unknown, arrive: unknown): { departAt: string; arriveAt?: string } | undefined {
  const departAt = dt(depart);
  if (!departAt) return undefined;
  const arriveAt = dt(arrive);
  return { departAt, ...(arriveAt && arriveAt.slice(0, 10) >= departAt.slice(0, 10) ? { arriveAt } : {}) };
}

// One mapper per reservation type; each returns candidates or a reason it could not map.
type Mapper = (r: Obj) => Mapped[] | string;

const flight: Mapper = (r) => {
  const out: Mapped[] = [];
  list(r.reservationFor).filter(isObj).forEach((f, i) => {
    const t = times(f.departureTime, f.arrivalTime);
    const iata = iataOf(f.departureAirport), toIata = iataOf(f.arrivalAirport);
    const from = iata ?? cityOf(f.departureAirport), to = toIata ?? cityOf(f.arrivalAirport);
    if (!t || !from || !to) return;
    const code = str(obj(f.airline)?.iataCode);
    const fn = str(f.flightNumber);
    const number = fn && code && /^\d+[A-Za-z]?$/.test(fn) ? `${code}${fn}` : fn;
    out.push({
      kind: "segment",
      confidence: iata && toIata ? "high" : "medium",
      payload: compact({
        mode: "flight",
        ...(iata ? { iataHint: iata } : { cityHint: from }),
        ...(toIata ? { toIataHint: toIata } : { toCityHint: to }),
        ...t,
        carrier: cut(nameOf(f.airline) ?? code, 100),
        number: cut(number, 20),
        bookingRef: cut(str(r.reservationNumber), 100),
        cost: i === 0 ? priceOf(r) : undefined,
      }),
    });
  });
  return out.length ? out : "FlightReservation without usable flight, airports or departureTime";
};

const train: Mapper = (r) => {
  const out: Mapped[] = [];
  list(r.reservationFor).filter(isObj).forEach((f, i) => {
    const t = times(f.departureTime, f.arrivalTime);
    const cityHint = cityOf(f.departureStation), toCityHint = cityOf(f.arrivalStation);
    if (!t || !cityHint || !toCityHint) return;
    out.push({
      kind: "segment",
      confidence: "medium",
      payload: compact({
        mode: "train",
        cityHint,
        toCityHint,
        ...t,
        carrier: cut(nameOf(f.provider) ?? str(f.trainName), 100),
        number: cut(str(f.trainNumber), 20),
        bookingRef: cut(str(r.reservationNumber), 100),
        cost: i === 0 ? priceOf(r) : undefined,
      }),
    });
  });
  return out.length ? out : "TrainReservation without usable stations or departureTime";
};

const LODGING_KINDS: Record<string, string> = { Hotel: "hotel", Hostel: "hostel", Apartment: "apartment" };

const lodging: Mapper = (r) => {
  const f = obj(r.reservationFor);
  const name = cut(nameOf(f), 300);
  const arrive = dt(r.checkinTime ?? r.checkinDate)?.slice(0, 10);
  if (!f || !name || !arrive) return "LodgingReservation without lodging name or check-in";
  const out = dt(r.checkoutTime ?? r.checkoutDate)?.slice(0, 10);
  return [
    {
      kind: "lodging",
      confidence: "medium",
      payload: compact({
        name,
        kind: typeNames(f["@type"]).map((t) => LODGING_KINDS[t]).find(Boolean),
        cityHint: cityOf(f),
        arrive,
        depart: out && out >= arrive ? out : undefined,
        cost: priceOf(r),
      }),
    },
  ];
};

const geoNum = (v: unknown, max: number) => {
  const n = Number(str(v));
  return str(v) !== undefined && Number.isFinite(n) && Math.abs(n) <= max ? n : undefined;
};

const event: Mapper = (r) => {
  const f = obj(r.reservationFor);
  const title = cut(nameOf(f), 300);
  const date = dt(f?.startDate ?? f?.startTime)?.slice(0, 10);
  if (!f || !title || !date) return "EventReservation without event name or startDate";
  const geo = obj(obj(f.location)?.geo);
  return [
    {
      kind: "experience",
      confidence: "medium",
      payload: compact({
        title,
        kind: "event",
        date,
        cityHint: cityOf(f.location),
        lat: geoNum(geo?.latitude, 90),
        lng: geoNum(geo?.longitude, 180),
        cost: priceOf(r),
      }),
    },
  ];
};

const rentalCar: Mapper = (r) => {
  const t = times(r.pickupTime, r.dropoffTime);
  const cityHint = cityOf(r.pickupLocation);
  if (!t || !cityHint) return "RentalCarReservation without pickupLocation or pickupTime";
  const car = obj(r.reservationFor);
  return [
    {
      kind: "segment",
      confidence: "medium",
      payload: compact({
        mode: "car",
        cityHint,
        toCityHint: cityOf(r.dropoffLocation) ?? cityHint,
        ...t,
        carrier: cut(nameOf(car?.rentalCompany) ?? nameOf(car?.brand), 100),
        bookingRef: cut(str(r.reservationNumber), 100),
        cost: priceOf(r),
      }),
    },
  ];
};

const MAPPERS: Record<string, Mapper> = {
  FlightReservation: flight,
  TrainReservation: train,
  LodgingReservation: lodging,
  EventReservation: event,
  RentalCarReservation: rentalCar,
};

/** Reservation nodes of a JSON-LD document: top level, arrays and @graph (bounded depth). */
function reservations(node: unknown, depth = 0, out: [string, Obj, boolean][] = []): [string, Obj, boolean][] {
  if (depth > 4) return out;
  if (Array.isArray(node)) node.forEach((n) => reservations(n, depth + 1, out));
  else if (isObj(node)) {
    if (node["@graph"]) reservations(node["@graph"], depth + 1, out);
    const type = typeNames(node["@type"]).find((t) => t in MAPPERS);
    if (type) out.push([type, node, /cancel/i.test(str(node.reservationStatus) ?? "")]);
  }
  return out;
}

// ── Entry point ─────────────────────────────────────────────────────

/** Parses an uploaded .eml or .mbox (raw bytes) into jsonld candidates. */
export function parseEmailUpload(file: Uint8Array): EmailParse {
  if (file.byteLength > MAX_UPLOAD_BYTES) throw new ImportError(413, { error: "too_large", maxBytes: MAX_UPLOAD_BYTES });
  const messages = splitMbox(Buffer.from(file.buffer, file.byteOffset, file.byteLength).toString("latin1").replace(/^\xEF\xBB\xBF/, ""));
  if (messages.length > MAX_MESSAGES) throw new ImportError(413, { error: "too_many_messages", max: MAX_MESSAGES });

  const result: EmailParse = { candidates: [], messages: 0, unstructured: 0, cancelled: [], errors: [] };
  const note = (msg: string) => result.errors.length < MAX_ERRORS && result.errors.push(msg);

  messages.forEach((raw, i) => {
    if (!raw.trim()) return;
    const label = `message ${i + 1}`;
    if (raw.length > MAX_MESSAGE_BYTES) {
      result.messages++;
      return void note(`${label}: skipped, larger than ${MAX_MESSAGE_BYTES / 1024 / 1024} MB`);
    }
    result.messages++;
    const id = (parseMime(raw).headers.get("message-id") ?? "").replace(/[<>\s]/g, "") || `sha1-${shortHash([raw.slice(0, 100_000)], 24)}`;
    const found = htmlParts(raw).flatMap((html) => extractJsonLd(html, note, label)).flatMap((doc) => reservations(doc));
    if (!found.length) return void result.unstructured++;
    let n = 0;
    for (const [type, r, cancelled] of found) {
      const mapped = MAPPERS[type](r);
      if (typeof mapped === "string") {
        note(`${label}: ${mapped}`);
        continue;
      }
      for (const m of mapped) {
        (cancelled ? result.cancelled : result.candidates).push({
          kind: m.kind,
          payload: m.payload,
          provenance: { source: "jsonld", sourceRef: `${id.slice(0, 400)}#${n++}`, confidence: m.confidence },
        });
      }
    }
  });
  return result;
}
