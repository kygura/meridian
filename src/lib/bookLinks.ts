// "Book on…" hand-off links (ADR 0010). Meridian never takes real money: flights in the
// app are test bookings only. These links open the real search on someone else's site with
// as much prefilled as that site's URL allows; `prefills` says what that is, so the UI
// never promises more than the link does.
//
// Only what the search needs goes into a URL: airport codes or city names, dates and a
// head count. Never a name, an email or a booking reference.

import type { LegMode } from "../types";

export interface BookLink {
  /** Stable key: "google-flights", "skyscanner"… */
  site: string;
  label: string;
  url: string;
  /** What the link carries over, in plain words ("route, date, travellers"). */
  prefills: string;
}

export interface PlaceRef {
  name: string;
  iata?: string;
  country?: string;
}

export interface LegSearch {
  from: PlaceRef;
  to: PlaceRef;
  /** YYYY-MM-DD; absent = the site asks for a date. */
  date?: string;
  travellers?: number;
}

const enc = encodeURIComponent;
const people = (n: number | undefined) => Math.max(1, Math.min(9, Math.round(n ?? 1)));
const isDate = (d: string | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
const full = (p: PlaceRef) => (p.country ? `${p.name}, ${p.country}` : p.name);

/** Flight search on Google Flights, Skyscanner and Kayak. Needs both airport codes. */
export function flightLinks(s: LegSearch): BookLink[] {
  const a = s.from.iata;
  const b = s.to.iata;
  if (!a || !b) return [];
  const n = people(s.travellers);
  const date = isDate(s.date) ? s.date : undefined;
  const carried = date ? "route, date and travellers" : "route and travellers";

  const q = [`Flights from ${a} to ${b}`, date ? `on ${date}` : "", "one way", n > 1 ? `for ${n} adults` : ""].filter(Boolean).join(" ");
  const out: BookLink[] = [
    { site: "google-flights", label: "Google Flights", url: `https://www.google.com/travel/flights?q=${enc(q)}`, prefills: carried },
  ];
  // Skyscanner and Kayak put the date in the path; without one they have no search to open.
  if (date) {
    const yymmdd = date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10);
    out.push({
      site: "skyscanner",
      label: "Skyscanner",
      url: `https://www.skyscanner.net/transport/flights/${a.toLowerCase()}/${b.toLowerCase()}/${yymmdd}/?adultsv2=${n}&cabinclass=economy&rtn=0`,
      prefills: carried,
    });
    out.push({
      site: "kayak",
      label: "Kayak",
      url: `https://www.kayak.com/flights/${a}-${b}/${date}${n > 1 ? `/${n}adults` : ""}`,
      prefills: carried,
    });
  }
  return out;
}

/**
 * Train, bus, ferry and road search. Rome2Rio and Google Maps take the two places in the
 * URL but not a date, so the date is picked there.
 */
export function groundLinks(s: LegSearch, mode: Exclude<LegMode, "flight">): BookLink[] {
  const a = full(s.from);
  const b = full(s.to);
  const slug = (t: string) => enc(t.replace(/,\s*/g, "-").replace(/\s+/g, "-"));
  const travelmode = mode === "drive" ? "driving" : "transit";
  return [
    {
      site: "rome2rio",
      label: "Rome2Rio",
      url: `https://www.rome2rio.com/map/${slug(a)}/${slug(b)}`,
      prefills: "route only; pick the date there",
    },
    {
      site: "google-maps",
      label: mode === "drive" ? "Google Maps (driving)" : "Google Maps (transit)",
      url: `https://www.google.com/maps/dir/?api=1&origin=${enc(a)}&destination=${enc(b)}&travelmode=${travelmode}`,
      prefills: "route only",
    },
  ];
}

export function legLinks(s: LegSearch, mode: LegMode): BookLink[] {
  return mode === "flight" ? flightLinks(s) : groundLinks(s, mode);
}

/** From this many nights a stay is searched as a monthly rental too. */
export const MONTHLY_NIGHTS = 28;

export interface StaySearch {
  place: PlaceRef;
  checkIn?: string;
  checkOut?: string;
  travellers?: number;
}

/**
 * Lodging search for a stop: Booking.com and Airbnb, and for stays of 28 nights or more
 * Flatio and Airbnb's monthly pricing.
 */
export function stayLinks(s: StaySearch): BookLink[] {
  const n = people(s.travellers);
  const dated = isDate(s.checkIn) && isDate(s.checkOut) && s.checkIn < s.checkOut;
  const nights = dated ? Math.round((Date.parse(s.checkOut!) - Date.parse(s.checkIn!)) / 86_400_000) : 0;
  const monthly = nights >= MONTHLY_NIGHTS;
  const where = full(s.place);
  const carried = dated ? "city, dates and guests" : "city and guests";

  const booking = new URLSearchParams({ ss: where, group_adults: String(n), no_rooms: "1" });
  const airbnb = new URLSearchParams({ adults: String(n) });
  if (dated) {
    booking.set("checkin", s.checkIn!);
    booking.set("checkout", s.checkOut!);
    airbnb.set("checkin", s.checkIn!);
    airbnb.set("checkout", s.checkOut!);
  }
  const airbnbPlace = enc(where.replace(/,\s*/g, "--").replace(/\s+/g, "-"));
  const out: BookLink[] = [
    { site: "booking", label: "Booking.com", url: `https://www.booking.com/searchresults.html?${booking}`, prefills: carried },
    {
      site: "airbnb",
      label: monthly ? "Airbnb (monthly rates)" : "Airbnb",
      url: `https://www.airbnb.com/s/${airbnbPlace}/homes?${airbnb}`,
      prefills: monthly ? `${carried}; ${nights} nights gets Airbnb's monthly price` : carried,
    },
  ];
  if (monthly) {
    out.push({
      site: "flatio",
      label: "Flatio",
      url: `https://www.flatio.com/s/${enc(s.place.name)}`,
      prefills: "city only; set the dates there",
    });
  }
  return out;
}
