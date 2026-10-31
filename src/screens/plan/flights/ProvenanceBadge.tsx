import type { OfferSource } from "../../../lib/bookingApi";
import { Badge } from "../../../ui";
import { IconInfo } from "../../../ui/icons";

/** Mock / Test label. Every offer, review, ticket and booking row carries one. */
export function ProvenanceBadge({ source }: { source: OfferSource }) {
  return source === "mock" ? (
    <Badge tone="warning" title="Sample fare, not a real ticket">
      Mock
    </Badge>
  ) : (
    <Badge tone="accent" title="Test booking, no real ticket is issued">
      Test
    </Badge>
  );
}

/** One-line note explaining what Mock or Test means. */
export function ProvenanceNote({ source, kind = "offers" }: { source: OfferSource; kind?: "offers" | "booking" }) {
  const text =
    source === "mock"
      ? kind === "offers"
        ? "These are sample fares. Booking one won't issue a real ticket."
        : "This is a sample booking, not a real ticket."
      : kind === "offers"
        ? "These fares come from a test provider. No real ticket is issued."
        : "Test booking. No real ticket was issued.";
  return (
    <p className={`plan-flights-note plan-flights-note--${source === "mock" ? "mock" : "test"}`} role="note">
      <IconInfo size={16} />
      <span>{text}</span>
    </p>
  );
}
