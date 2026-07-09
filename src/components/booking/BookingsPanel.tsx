import { useEffect } from "react";
import { useMeridianStore } from "../../store";
import ProvenanceBadge from "./ProvenanceBadge";
import BookingTicket from "./BookingTicket";

/** Global bookings list overlay (DESIGN-booking.md §5), opened from the Trips
 *  page aside. Bookings are server-persisted and global (A1) — this is a
 *  lookup/aftercare view, so it reuses the overlay language rather than a
 *  route. Row click swaps to the read-only BookingTicket with cancel. */
export default function BookingsPanel() {
  const {
    bookingsPanelOpen,
    setBookingsPanelOpen,
    bookings,
    fetchBookings,
    activeBookingId,
    openBookingTicket,
  } = useMeridianStore();

  // Refresh the server-truth cache whenever the panel opens.
  useEffect(() => {
    if (bookingsPanelOpen) void fetchBookings();
  }, [bookingsPanelOpen, fetchBookings]);

  useEffect(() => {
    if (!bookingsPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setBookingsPanelOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bookingsPanelOpen, setBookingsPanelOpen]);

  if (!bookingsPanelOpen) return null;

  const active = activeBookingId
    ? bookings.find((b) => b.id === activeBookingId)
    : undefined;

  return (
    <div className="cmd-overlay" onMouseDown={() => setBookingsPanelOpen(false)}>
      <div
        className="bookings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Bookings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="bookings-panel-head">
          {active ? (
            <button
              type="button"
              className="tm-action-btn"
              onClick={() => openBookingTicket(null)}
            >
              ← BACK
            </button>
          ) : (
            <span className="bookings-panel-title">BOOKINGS</span>
          )}
          <span className="bookings-panel-meta">
            {!active && <span className="bookings-panel-count">{bookings.length}</span>}
            <button
              type="button"
              className="tm-action-btn booking-close"
              aria-label="Close"
              onClick={() => setBookingsPanelOpen(false)}
            >
              ✕
            </button>
          </span>
        </div>

        <div className="bookings-panel-body">
          {active ? (
            <BookingTicket booking={active} showCancel />
          ) : bookings.length === 0 ? (
            <div className="cmd-empty">
              <div className="cmd-empty-title">NO BOOKINGS YET</div>
              <div className="cmd-empty-sub">
                Book a flight from a trip leg to see it here. Bookings are stored
                on the server.
              </div>
            </div>
          ) : (
            bookings.map((b) => {
              const cancelled = b.status === "cancelled";
              const passenger = b.passengers[0];
              return (
                <div
                  key={b.id}
                  className={`cmd-row candidate-row booking-row${cancelled ? " cancelled" : ""}`}
                  onClick={() => openBookingTicket(b.id)}
                >
                  <span className="candidate-color-bar bk-offer-bar" />
                  <div className="bk-booking-main">
                    <div className="bk-booking-line1">
                      <span className="bk-booking-ref">{b.bookingReference}</span>
                      <span className="bk-booking-route">
                        {b.leg.originIata} → {b.leg.destinationIata}
                      </span>
                      <span className="bk-booking-date">{b.leg.departureDate}</span>
                      <span className="bk-booking-price">
                        ${b.totalAmount.toLocaleString()}
                      </span>
                      <ProvenanceBadge source={b.source} />
                      <span
                        className={`bk-status-pill ${cancelled ? "cancelled" : "booked"}`}
                      >
                        {cancelled ? "⨯ CANCELLED" : "● BOOKED"}
                      </span>
                    </div>
                    <div className="bk-booking-line2">
                      {b.offerSnapshot.carrier}
                      {passenger
                        ? ` · ${passenger.title} ${passenger.givenName} ${passenger.familyName}`.toUpperCase()
                        : ""}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
