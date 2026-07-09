import type { OfferSource } from "../../lib/bookingApi";

/** Shared MOCK / TEST provenance pill (DESIGN-booking.md §0/§8).
 *  The flow must never look like real ticketing — every surface carries one. */
export default function ProvenanceBadge({
  source,
  long = false,
}: {
  source: OfferSource;
  /** Long form for the review banner / list contexts. */
  long?: boolean;
}) {
  const mock = source === "mock";
  const label = long
    ? mock
      ? "MOCK BOOKING · NOT A REAL TICKET"
      : "TEST MODE · DUFFEL SANDBOX · NO REAL TICKET ISSUED"
    : mock
      ? "MOCK"
      : "TEST";
  return (
    <span
      className={`bk-badge ${mock ? "bk-badge-mock" : "bk-badge-test"}${long ? " bk-badge-long" : ""}`}
      aria-label={mock ? "Mock booking, not a real ticket" : "Test mode Duffel sandbox booking"}
    >
      {label}
    </span>
  );
}
