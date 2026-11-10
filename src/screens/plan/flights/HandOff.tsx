// Test-mode labelling and the hand-off to real booking sites (ADR 0010).
// Everything bookable inside Meridian is a test: no ticket, no payment. To really fly,
// the person books on an airline's or a search site and records it on their trip.

import { flightLinks, type BookLink } from "../../../lib/bookLinks";
import { IconAlert, IconExternal } from "../../../ui/icons";
import type { SearchDraft } from "./search";

/** The banner at the top of the Flights page and the booking sheet. */
export function TestModeBanner({ context = "page" }: { context?: "page" | "sheet" }) {
  return (
    <div className="plan-flights-testmode" role="note">
      <IconAlert size={18} />
      <p>
        <strong>Test mode. Nothing here is a real ticket and no money moves.</strong>{" "}
        {context === "page"
          ? "Use this to try routes and prices. To really fly, book on one of the sites linked from your results or your trip, then record the booking on the trip's leg."
          : "This makes a practice booking only. To really fly, book on an airline's or a search site, then record the booking on the trip's leg."}
      </p>
    </div>
  );
}

/** Real search links for a flight search: route, date and travellers carried over. */
export function searchLinks(d: SearchDraft | null): BookLink[] {
  if (!d?.origin || !d.dest) return [];
  return flightLinks({
    from: { name: d.origin.name, iata: d.origin.iata },
    to: { name: d.dest.name, iata: d.dest.iata },
    date: d.departureDate || undefined,
    travellers: d.passengers,
  });
}

/** "Book for real on: Google Flights · Skyscanner · Kayak", shown with the offers. */
export function RealBookingLinks({ links }: { links: BookLink[] }) {
  if (!links.length) return null;
  return (
    <div className="plan-flights-real">
      <span className="plan-flights-real-label">Book this for real on</span>
      <ul className="plan-flights-real-list">
        {links.map((l) => (
          <li key={l.site}>
            <a href={l.url} target="_blank" rel="noreferrer noopener" title={`Fills in ${l.prefills}`}>
              {l.label}
              <IconExternal size={12} />
              <span className="sr-only"> (opens in a new tab; fills in {l.prefills})</span>
            </a>
          </li>
        ))}
      </ul>
      <span className="plan-flights-real-sub">Same route, date and travellers. You pay there, not in Meridian.</span>
    </div>
  );
}
