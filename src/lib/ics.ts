// A trip as an iCalendar file (RFC 5545): stays as all-day spans, legs and activities as
// timed events where a time is known. Pure, so the browser's download and the server's
// subscribable feed produce the same calendar (ADR 0010).
//
// Times on a leg are typed in as local wall-clock times. With the cities' time zones
// (data/city-geo.json) they are written as UTC instants, which every calendar reads the
// same way. Without a zone they are written as floating local times and say so.

import { datedSpan, isMonthSpan, tripSeason } from "./season";
import { MODE_LABEL, type TripLeg, type TripRoute } from "./legs";
import { addDays, formatDay, isClockTime, isIsoDate, legDate, nightsText, stopNights, type ZoneOf } from "./itinerary";
import { isLocalDateTime, offsetLabel, zonedToUtc } from "./zoned";
import type { MoneyInput, Trip } from "../types";

export interface IcsOptions {
  zoneOf?: ZoneOf;
  /**
   * Include booking references, prices, links and notes. True for the file the owner
   * downloads; false for the feed, whose URL is handed to a calendar service.
   */
  includePrivate?: boolean;
  now?: Date;
  calendarName?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

const dateValue = (iso: string) => iso.replace(/-/g, "");
const floating = (local: string) => `${local.replace(/[-:]/g, "")}00`;

/** RFC 5545 §3.3.11 TEXT escaping. */
export function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold a content line at 75 octets (§3.1), never inside a UTF-8 sequence. */
export function icsFold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + b > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

interface Event {
  uid: string;
  summary: string;
  /** Property lines for the start and end (already formatted). */
  when: string[];
  location?: string;
  description?: string[];
}

function money(m: MoneyInput | undefined): string | undefined {
  return m ? `${m.amount} ${m.currency}` : undefined;
}

const code = (n: { iata?: string; name: string }) => n.iata ?? n.name;

function legEvent(trip: Trip, leg: TripLeg, opts: IcsOptions): Event | null {
  const r = leg.record;
  const date = legDate(trip, leg);
  if (!date) return null;
  const what = [r?.carrier, r?.number].filter(Boolean).join(" ");
  const summary = `${MODE_LABEL[leg.mode]} ${code(leg.from)} → ${code(leg.to)}${what ? ` · ${what}` : ""}${r ? "" : " (not booked)"}`;
  const desc: string[] = [`${leg.from.name} to ${leg.to.name}`];
  const when: string[] = [];

  if (r && isLocalDateTime(r.departAt)) {
    const fromZone = opts.zoneOf?.(leg.from.cityId);
    const toZone = opts.zoneOf?.(leg.to.cityId);
    const start = zonedToUtc(r.departAt, fromZone);
    const end = isLocalDateTime(r.arriveAt) ? zonedToUtc(r.arriveAt, toZone) : null;
    if (start) {
      when.push(`DTSTART:${utcStamp(start)}`);
      if (end && end.getTime() > start.getTime()) when.push(`DTEND:${utcStamp(end)}`);
      desc.push(`Departs ${r.departAt.slice(11)} ${leg.from.name} time (${offsetLabel(start, fromZone!)})`);
      if (end && isLocalDateTime(r.arriveAt)) {
        const nextDay = r.arriveAt.slice(0, 10) !== r.departAt.slice(0, 10) ? ` on ${formatDay(r.arriveAt.slice(0, 10), { year: false })}` : "";
        desc.push(`Arrives ${r.arriveAt.slice(11)}${nextDay} ${leg.to.name} time (${offsetLabel(end, toZone!)})`);
      }
    } else {
      // No time zone for the city: a floating time, shown as typed wherever the calendar is.
      when.push(`DTSTART:${floating(r.departAt)}`);
      desc.push(`Departs ${r.departAt.slice(11)} local time. The time zone isn't known, so this shows as typed.`);
      if (isLocalDateTime(r.arriveAt)) desc.push(`Arrives ${r.arriveAt.slice(11)} local time at the destination.`);
    }
  } else {
    when.push(`DTSTART;VALUE=DATE:${dateValue(date)}`, `DTEND;VALUE=DATE:${dateValue(addDays(date, 1))}`);
    if (!r) desc.push("Not booked yet. The day comes from your stop dates.");
  }
  if (opts.includePrivate && r?.reference) desc.push(`Booking reference: ${r.reference}`);
  if (opts.includePrivate && r?.cost) desc.push(`Price: ${money(r.cost)}`);
  return { uid: `${trip.id}-leg-${leg.index}`, summary, when, location: leg.from.name, description: desc };
}

function stayEvents(trip: Trip, opts: IcsOptions): Event[] {
  const out: Event[] = [];
  const season = tripSeason(trip);
  trip.nodes.forEach((n, i) => {
    const a = isIsoDate(n.arrive) ? n.arrive : isIsoDate(n.depart) ? n.depart : undefined;
    const d = isIsoDate(n.depart) ? n.depart : a;
    const l = n.lodging;
    if (a && d) {
      const nights = stopNights(n);
      const desc: string[] = [];
      if (nights !== null) desc.push(nights === 0 ? "Day visit" : nightsText(nights));
      if (l?.name) desc.push(`Staying at ${l.name}`);
      if (l?.checkIn || l?.checkOut) desc.push(`Check-in ${l.checkIn ?? "?"}, check-out ${l.checkOut ?? "?"}`);
      if (opts.includePrivate) {
        if (l?.bookingRef) desc.push(`Booking reference: ${l.bookingRef}`);
        if (l?.cost) desc.push(`Price: ${money(l.cost)}`);
        if (l?.link) desc.push(l.link);
        if (n.notes) desc.push(n.notes);
      }
      out.push({
        uid: `${trip.id}-stay-${i}`,
        summary: l?.name ? `${n.name} · ${l.name}` : n.name,
        // DTEND is exclusive: the span covers the nights, so the day you leave belongs to the next stop.
        when: [`DTSTART;VALUE=DATE:${dateValue(a)}`, `DTEND;VALUE=DATE:${dateValue(d > a ? d : addDays(a, 1))}`],
        location: l?.address ?? n.name,
        description: desc,
      });
    } else if (trip.year && isMonthSpan(n.months)) {
      const span = datedSpan(n.months, trip.year, season?.start ?? n.months.start);
      out.push({
        uid: `${trip.id}-stay-${i}`,
        summary: `${n.name} (dates not set)`,
        when: [`DTSTART;VALUE=DATE:${dateValue(span.start)}`, `DTEND;VALUE=DATE:${dateValue(addDays(span.end, 1))}`],
        location: n.name,
        description: ["Planned by month. Exact dates aren't set yet."],
      });
    }
  });
  return out;
}

function activityEvents(trip: Trip, opts: IcsOptions): Event[] {
  const out: Event[] = [];
  trip.nodes.forEach((n) => {
    for (const a of n.activities ?? []) {
      if (!isIsoDate(a.date)) continue;
      const desc: string[] = [`In ${n.name}`];
      const when: string[] = [];
      if (isClockTime(a.time)) {
        const local = `${a.date}T${a.time}`;
        const start = zonedToUtc(local, opts.zoneOf?.(n.cityId));
        when.push(start ? `DTSTART:${utcStamp(start)}` : `DTSTART:${floating(local)}`);
        desc.push(`${a.time} ${n.name} time`);
      } else {
        when.push(`DTSTART;VALUE=DATE:${dateValue(a.date)}`, `DTEND;VALUE=DATE:${dateValue(addDays(a.date, 1))}`);
      }
      if (opts.includePrivate) {
        if (a.note) desc.push(a.note);
        if (a.cost) desc.push(`Cost: ${money(a.cost)}`);
        if (a.link) desc.push(a.link);
      }
      out.push({ uid: `${trip.id}-act-${a.id}`, summary: a.title, when, location: n.name, description: desc });
    }
  });
  return out;
}

/** The trip as a VCALENDAR. Stops and legs without any date are left out. */
export function tripToIcs(trip: Trip, route: TripRoute, opts: IcsOptions = {}): string {
  const stamp = utcStamp(opts.now ?? new Date());
  const events = [
    ...stayEvents(trip, opts),
    ...route.all.map((l) => legEvent(trip, l, opts)).filter((e): e is Event => !!e),
    ...activityEvents(trip, opts),
  ];
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meridian//Trip itinerary//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(opts.calendarName ?? trip.name)}`,
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${icsEscape(e.uid)}@meridian`, `DTSTAMP:${stamp}`, ...e.when, `SUMMARY:${icsEscape(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    if (e.description?.length) lines.push(`DESCRIPTION:${icsEscape(e.description.join("\n"))}`);
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

/** "lisbon-loop.ics" */
export function icsFileName(tripName: string): string {
  const slug = tripName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${slug || "trip"}.ics`;
}
