import { useState } from "react";
import { useMeridianStore } from "../../store";
import {
  cancelBooking,
  type Booking,
} from "../../lib/bookingApi";
import ProvenanceBadge from "./ProvenanceBadge";

/** BOOKED success ticket (DESIGN-booking.md §3.6) — full ticket skeuomorphism,
 *  functional. Reused read-only in BookingsPanel (§5), where it also hosts the
 *  CANCEL BOOKING action. */
export default function BookingTicket({
  booking,
  animateIn = false,
  showCancel = false,
}: {
  booking: Booking;
  /** One-shot "print" reveal on success entry (respects prefers-reduced-motion). */
  animateIn?: boolean;
  /** §5.3 — cancel affordance shown when opened from the bookings list. */
  showCancel?: boolean;
}) {
  const { cities, applyBookingCancelled } = useMeridianStore();
  const [copied, setCopied] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const cancelled = booking.status === "cancelled";
  const originCity = cities.find((c) => c.iata === booking.leg.originIata);
  const destCity = cities.find((c) => c.iata === booking.leg.destinationIata);
  const passenger = booking.passengers[0];

  const copyRef = () => {
    navigator.clipboard
      ?.writeText(booking.bookingReference)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };

  const doCancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelBooking(booking.id);
      applyBookingCancelled(booking.id);
      setConfirmingCancel(false);
    } catch {
      setCancelError("COULD NOT CANCEL — TRY AGAIN");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className={`bk-ticket${cancelled ? " cancelled" : ""}${animateIn ? " print-reveal" : ""}`}>
      {cancelled && (
        <div className="bk-ticket-watermark" aria-hidden="true">
          CANCELLED
        </div>
      )}
      <div className="bk-ticket-head">
        <span className="bk-ticket-brand">MERIDIAN DISPATCH</span>
        <span className="bk-ticket-head-right">
          <ProvenanceBadge source={booking.source} />
          <span className={`bk-status-pill ${cancelled ? "cancelled" : "booked"}`}>
            {cancelled ? "· CANCELLED" : "· BOOKED"}
          </span>
        </span>
      </div>

      <div className="bk-ticket-route">
        <div className="bk-ticket-route-iata">
          {booking.leg.originIata} ✈ {booking.leg.destinationIata}
        </div>
        {(originCity || destCity) && (
          <div className="bk-ticket-route-cities">
            {originCity?.name ?? booking.leg.originIata} →{" "}
            {destCity?.name ?? booking.leg.destinationIata}
          </div>
        )}
      </div>

      <div className="bk-ticket-perforation" aria-hidden="true" />

      <div className="bk-ticket-refblock">
        <span className="bk-field-label">BOOKING REFERENCE</span>
        <div className="bk-ticket-ref-row">
          <span className="bk-ticket-ref">{booking.bookingReference}</span>
          <button type="button" className="tp-link bk-linkbtn" onClick={copyRef}>
            {copied ? "COPIED" : "COPY"}
          </button>
        </div>
      </div>

      <div className="bk-ticket-grid">
        <TicketRow k="DEPART" v={booking.leg.departureDate} />
        {booking.leg.returnDate && <TicketRow k="RETURN" v={booking.leg.returnDate} />}
        <TicketRow k="CARRIER" v={booking.offerSnapshot.carrier} />
        {passenger && (
          <TicketRow
            k="PASSENGER"
            v={`${passenger.title} ${passenger.givenName} ${passenger.familyName}`.toUpperCase()}
          />
        )}
        <TicketRow
          k="TOTAL"
          v={`$${booking.totalAmount.toLocaleString()} ${booking.totalCurrency}`}
        />
        <div className="bk-ticket-row">
          <span className="bk-proof-key">STATUS</span>
          <span className={`bk-status-pill ${cancelled ? "cancelled" : "booked"}`}>
            {cancelled ? "⨯ CANCELLED" : "● BOOKED"}
          </span>
        </div>
      </div>

      <div className="bk-ticket-barcode" aria-hidden="true">
        ▐▌▐ ▐▌▐▌ ▐ ▌▐▌ ▐▐▌ ▌▐ ▐▌▐ ▌▐▌
      </div>

      {showCancel && !cancelled && (
        <div className="bk-ticket-cancel-row">
          {cancelError && <span className="bk-field-error">{cancelError}</span>}
          {confirmingCancel ? (
            <>
              <button
                type="button"
                className="tm-action-btn tm-delete-confirm"
                disabled={cancelling}
                onClick={doCancel}
              >
                {cancelling ? "CANCELLING…" : "CONFIRM CANCEL"}
              </button>
              <button
                type="button"
                className="tm-action-btn"
                disabled={cancelling}
                onClick={() => setConfirmingCancel(false)}
              >
                KEEP
              </button>
            </>
          ) : (
            <button
              type="button"
              className="tm-action-btn tm-delete-btn"
              onClick={() => setConfirmingCancel(true)}
            >
              CANCEL BOOKING
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TicketRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="bk-ticket-row">
      <span className="bk-proof-key">{k}</span>
      <span className="bk-ticket-value">{v}</span>
    </div>
  );
}
