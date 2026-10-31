// Plain-language formatting for the flight search and booking flow.
// Pure functions only: the booking logic itself stays in lib/bookingApi.

import type { Booking, PassengerErrors } from "../../../lib/bookingApi";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Nonstop", "1 stop", "2 stops". */
export function stopsText(stops: number): string {
  if (stops <= 0) return "Nonstop";
  return `${stops} ${stops === 1 ? "stop" : "stops"}`;
}

/** "1 adult", "3 adults". */
export function adultsText(n: number): string {
  return `${n} ${n === 1 ? "adult" : "adults"}`;
}

/** "2h 05m" → "2 h 5 min"; under an hour "45 min". */
export function durationText(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** "Fri 14 Aug 2026" from YYYY-MM-DD, parsed by hand so there is no timezone drift. */
export function dateText(iso: string | undefined, opts: { year?: boolean; weekday?: boolean } = {}): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const wd = DAYS_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const { year = true, weekday = true } = opts;
  return `${weekday ? `${wd} ` : ""}${d} ${MONTHS_SHORT[m - 1]}${year ? ` ${y}` : ""}`;
}

/** Currency amount, e.g. "$1,240" or "€312". Falls back to "1,240 XYZ" for unknown codes. */
export function priceText(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString("en-US")} ${currency}`;
  }
}

/** "4:05" (m:ss) or "Expired". */
export function countdownText(ms: number): string {
  if (ms <= 0) return "Expired";
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const PASSENGER_FIELD_LABEL: Record<keyof PassengerErrors, string> = {
  title: "a title",
  givenName: "a given name",
  familyName: "a family name",
  bornOn: "a date of birth",
  gender: "a gender",
  email: "an email address",
  phoneNumber: "a phone number",
};

/** The lib validator returns short codes; turn them into sentence-case messages. */
export function passengerErrorText(field: keyof PassengerErrors, code: string | undefined): string | undefined {
  if (!code) return undefined;
  switch (code) {
    case "REQUIRED":
      if (field === "givenName" || field === "familyName") return `Enter ${PASSENGER_FIELD_LABEL[field]} using letters only`;
      if (field === "gender") return "Choose one";
      return `Enter ${PASSENGER_FIELD_LABEL[field]}`;
    case "DATE MUST BE IN THE PAST":
      return "Date of birth must be in the past";
    case "ENTER A VALID EMAIL":
      return "Enter a valid email address";
    case "INCLUDE COUNTRY CODE":
      return "Start with the country code, for example +44";
    default:
      return code.charAt(0) + code.slice(1).toLowerCase();
  }
}

export const PASSENGER_TITLES: { value: string; label: string }[] = [
  { value: "MR", label: "Mr" },
  { value: "MRS", label: "Mrs" },
  { value: "MS", label: "Ms" },
  { value: "MISS", label: "Miss" },
  { value: "DR", label: "Dr" },
];

export function titleLabel(value: string): string {
  return PASSENGER_TITLES.find((t) => t.value === value)?.label ?? value;
}

/** "Mr Ada Lovelace". */
export function passengerName(p: { title: string; givenName: string; familyName: string } | undefined): string {
  if (!p) return "";
  return [titleLabel(p.title), p.givenName, p.familyName].filter(Boolean).join(" ");
}

/** Bookings for the list: live ones by departure date, then cancelled ones, newest first. */
export function sortBookings(bookings: Booking[]): Booking[] {
  return [...bookings].sort((a, b) => {
    const ac = a.status === "cancelled" ? 1 : 0;
    const bc = b.status === "cancelled" ? 1 : 0;
    if (ac !== bc) return ac - bc;
    if (ac === 1) return (b.cancelledAt ?? b.createdAt).localeCompare(a.cancelledAt ?? a.createdAt);
    return a.leg.departureDate.localeCompare(b.leg.departureDate);
  });
}
