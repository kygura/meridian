import { useEffect, useMemo, useState } from "react";
import { cancelBooking, listBookings, type Booking } from "../../../lib/bookingApi";
import { useMeridianStore } from "../../../store";
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Sheet, Skeleton, cx, toast, SectionHeader } from "../../../ui";
import { IconArrowRight, IconChevronRight, IconPlane } from "../../../ui/icons";
import { BookingTicket } from "./BookingTicket";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { dateText, passengerName, priceText, sortBookings } from "./flightText";

function BookingRow({ booking, onOpen }: { booking: Booking; onOpen: () => void }) {
  const cities = useMeridianStore((s) => s.cities);
  const cancelled = booking.status === "cancelled";
  const from = cities.find((c) => c.iata === booking.leg.originIata)?.name;
  const to = cities.find((c) => c.iata === booking.leg.destinationIata)?.name;
  const title = from && to ? `${from} to ${to}` : `${booking.leg.originIata} to ${booking.leg.destinationIata}`;
  return (
    <li>
      <Card padding="none" interactive className={cx("plan-flights-booking", cancelled && "is-cancelled")}>
        <button type="button" className="plan-flights-booking-hit" onClick={onOpen}>
          <span className="plan-flights-booking-main">
            <span className="plan-flights-booking-title">
              <span className="iata">{booking.leg.originIata}</span>
              <IconArrowRight size={14} />
              <span className="iata">{booking.leg.destinationIata}</span>
              <span className="plan-flights-booking-names">{title}</span>
            </span>
            <span className="plan-flights-booking-meta muted">
              <span className="num">{dateText(booking.leg.departureDate)}</span>
              {booking.leg.returnDate ? <span className="num"> – {dateText(booking.leg.returnDate)}</span> : null}
              <span aria-hidden="true"> · </span>
              {booking.offerSnapshot.carrier}
              {booking.passengers[0] ? (
                <>
                  <span aria-hidden="true"> · </span>
                  {passengerName(booking.passengers[0])}
                </>
              ) : null}
            </span>
          </span>
          <span className="plan-flights-booking-side">
            <span className="plan-flights-price num">{priceText(booking.totalAmount, booking.totalCurrency)}</span>
            <span className="plan-flights-booking-badges">
              {cancelled ? <Badge tone="danger">Cancelled</Badge> : <Badge tone="success">Booked</Badge>}
              <ProvenanceBadge source={booking.source} />
            </span>
          </span>
          <IconChevronRight size={18} className="plan-flights-booking-chev" />
        </button>
      </Card>
    </li>
  );
}

/** "Your bookings": list, ticket view and cancel. */
export function BookingsList() {
  const bookings = useMeridianStore((s) => s.bookings);
  const setBookings = useMeridianStore((s) => s.setBookings);
  const applyBookingCancelled = useMeridianStore((s) => s.applyBookingCancelled);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(bookings.length ? "ready" : "loading");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = async () => {
    if (!useMeridianStore.getState().bookings.length) setStatus("loading");
    try {
      setBookings(await listBookings());
      setStatus("ready");
    } catch {
      setStatus(useMeridianStore.getState().bookings.length ? "ready" : "error");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sorted = useMemo(() => sortBookings(bookings), [bookings]);
  const active = openId ? bookings.find((b) => b.id === openId) ?? null : null;
  const live = bookings.filter((b) => b.status === "booked").length;

  const doCancel = async () => {
    if (!active) return;
    setCancelling(true);
    try {
      await cancelBooking(active.id);
      applyBookingCancelled(active.id);
      setConfirm(false);
      toast("Booking cancelled");
    } catch {
      toast("Couldn't cancel the booking. Try again.", { tone: "danger" });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section className="plan-flights-section" aria-labelledby="plan-flights-bookings-h">
      <SectionHeader
        id="plan-flights-bookings-h"
        title="Your bookings"
        meta={status === "ready" && bookings.length ? (live === bookings.length ? String(live) : `${live} active`) : null}
      />

      {status === "loading" ? (
        <ul className="plan-flights-booking-list" aria-busy="true">
          {[0, 1].map((i) => (
            <li key={i}>
              <Card padding="md">
                <Skeleton width="40%" height={16} />
                <Skeleton width="65%" height={12} className="plan-flights-skel-gap" />
              </Card>
            </li>
          ))}
        </ul>
      ) : status === "error" ? (
        <ErrorState message="Couldn't load your bookings." onRetry={() => void load()} />
      ) : sorted.length === 0 ? (
        <Card padding="none">
          <EmptyState icon={<IconPlane />} title="No bookings yet" description="Flights you book here or from a trip show up in this list." />
        </Card>
      ) : (
        <ul className="plan-flights-booking-list">
          {sorted.map((b) => (
            <BookingRow key={b.id} booking={b} onOpen={() => setOpenId(b.id)} />
          ))}
        </ul>
      )}

      <Sheet
        open={!!active}
        onClose={() => setOpenId(null)}
        title="Booking"
        size="md"
        footer={
          active && active.status === "booked" ? (
            <div className="plan-flights-sheet-foot">
              <Button variant="danger-outline" onClick={() => setConfirm(true)}>
                Cancel booking
              </Button>
              <Button onClick={() => setOpenId(null)}>Close</Button>
            </div>
          ) : undefined
        }
      >
        {active ? <BookingTicket booking={active} /> : null}
      </Sheet>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        role="alertdialog"
        title="Cancel this booking?"
        description={active ? `${active.leg.originIata} to ${active.leg.destinationIata} on ${dateText(active.leg.departureDate)}. This can't be undone.` : undefined}
        footer={
          <>
            <Button onClick={() => setConfirm(false)} disabled={cancelling} data-autofocus>
              Keep booking
            </Button>
            <Button variant="danger" loading={cancelling} onClick={() => void doCancel()}>
              Cancel booking
            </Button>
          </>
        }
      />
    </section>
  );
}
