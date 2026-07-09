import { useMeridianStore } from "../../store";
import type { Booking } from "../../lib/bookingApi";

/** Leg-row booked/cancelled badge (DESIGN-booking.md §6). Booked variant
 *  opens the BookingTicket directly (bypasses the list); cancelled variant
 *  opens the cancelled ticket and is followed by a fresh ✈ BOOK in the row. */
export default function BookingBadge({ booking }: { booking: Booking }) {
  const openBookingTicket = useMeridianStore((s) => s.openBookingTicket);
  const cancelled = booking.status === "cancelled";
  return (
    <button
      type="button"
      className={`bk-leg-badge ${cancelled ? "cancelled" : "booked"}`}
      onClick={() => openBookingTicket(booking.id)}
      title={cancelled ? "View cancelled booking" : "View booking"}
    >
      {cancelled ? "⨯ CANCELLED" : `● BOOKED · ${booking.bookingReference}`}
    </button>
  );
}
