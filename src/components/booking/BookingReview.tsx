import { useEffect, useRef } from "react";
import {
  formatDurationMinutes,
  formatStops,
  type Offer,
  type PassengerDraft,
} from "../../lib/bookingApi";
import OfferExpiryCountdown from "./OfferExpiryCountdown";

/** REVIEW step (DESIGN-booking.md §3.5) — everything the server will receive,
 *  laid out as a pre-print "dispatch proof" with an unmissable provenance
 *  banner and the live countdown. If the clock hits zero here, `onOfferExpire`
 *  routes to the expired-recovery path instead of letting a dead offer submit. */
export default function BookingReview({
  offer,
  draft,
  originIata,
  destinationIata,
  departureDate,
  returnDate,
  onOfferExpire,
  confirmRef,
}: {
  offer: Offer;
  draft: PassengerDraft;
  originIata: string;
  destinationIata: string;
  departureDate: string;
  returnDate?: string;
  onOfferExpire: () => void;
  confirmRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const mock = offer.source === "mock";
  const rootRef = useRef<HTMLDivElement>(null);

  // §10: REVIEW focuses the confirm button (lives in the modal footer).
  useEffect(() => {
    confirmRef?.current?.focus();
  }, [confirmRef]);

  return (
    <div className="bk-review" ref={rootRef}>
      <div className="bk-proof">
        <div className="bk-proof-title">DISPATCH PROOF</div>
        <div
          className={`bk-provenance-banner ${mock ? "mock" : "test"}`}
          role="note"
          aria-label={
            mock
              ? "Mock booking, not a real ticket"
              : "Test mode Duffel sandbox booking"
          }
        >
          {mock
            ? "⚠ MOCK BOOKING · NOT A REAL TICKET"
            : "TEST MODE · DUFFEL SANDBOX · NO REAL TICKET ISSUED"}
        </div>

        <div className="bk-proof-grid">
          <ProofRow k="ROUTE" v={`${originIata} → ${destinationIata}`} mono />
          <ProofRow
            k="DEPART"
            v={returnDate ? `${departureDate} · RETURN ${returnDate}` : departureDate}
            mono
          />
          <ProofRow
            k="CARRIER"
            v={`${offer.carrierIata ?? offer.carrier.slice(0, 2).toUpperCase()} · ${offer.carrier}`}
          />
          <ProofRow k="STOPS" v={formatStops(offer.stops)} mono />
          {offer.durationMinutes != null && (
            <ProofRow k="DURATION" v={formatDurationMinutes(offer.durationMinutes)} mono />
          )}
          <ProofRow k="CLASS" v="ECONOMY" mono />
        </div>

        <div className="bk-proof-seam" aria-hidden="true" />

        <div className="bk-proof-grid">
          <ProofRow
            k="PASSENGER"
            v={`${draft.title} ${draft.givenName} ${draft.familyName}`.toUpperCase()}
          />
          <ProofRow
            k="BORN"
            v={`${draft.bornOn} · ${draft.gender.toUpperCase()}`}
            mono
          />
          <ProofRow k="CONTACT" v={`${draft.email} · ${draft.phoneNumber}`} />
        </div>

        <div className="bk-proof-seam" aria-hidden="true" />

        <div className="bk-proof-total-row">
          <span className="bk-proof-key">TOTAL</span>
          <span className="bk-proof-total">
            ${offer.priceAmount.toLocaleString()}{" "}
            <span className="bk-proof-currency">{offer.currency}</span>
          </span>
        </div>
        <div className="bk-proof-expiry">
          <OfferExpiryCountdown expiresAt={offer.expiresAt} onExpire={onOfferExpire} />
        </div>
      </div>
    </div>
  );
}

function ProofRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="bk-proof-row">
      <span className="bk-proof-key">{k}</span>
      <span className={`bk-proof-value${mono ? " mono" : ""}`}>{v}</span>
    </div>
  );
}
