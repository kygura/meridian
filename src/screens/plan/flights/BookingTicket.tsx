import { useState } from "react";
import type { Booking } from "../../../lib/bookingApi";
import { useMeridianStore } from "../../../store";
import { Badge, Button, Card, cx } from "../../../ui";
import { IconCheck, IconPlane } from "../../../ui/icons";
import { ProvenanceBadge, ProvenanceNote } from "./ProvenanceBadge";
import { dateText, passengerName, priceText } from "./flightText";

/** Booking confirmation: route, reference with copy, details, status. */
export function BookingTicket({ booking }: { booking: Booking }) {
  const cities = useMeridianStore((s) => s.cities);
  const [copied, setCopied] = useState(false);
  const cancelled = booking.status === "cancelled";
  const from = cities.find((c) => c.iata === booking.leg.originIata);
  const to = cities.find((c) => c.iata === booking.leg.destinationIata);
  const pax = booking.passengers[0];

  const copy = () => {
    navigator.clipboard
      ?.writeText(booking.bookingReference)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };

  return (
    <div className="plan-flights-ticket-wrap">
      <ProvenanceNote source={booking.source} kind="booking" />
      <Card padding="none" className={cx("plan-flights-ticket", cancelled && "is-cancelled")}>
        <div className="plan-flights-ticket-head">
          <div className="plan-flights-ticket-badges">
            {cancelled ? <Badge tone="danger">Cancelled</Badge> : <Badge tone="success">Booked</Badge>}
            <ProvenanceBadge source={booking.source} />
          </div>
          <div className="plan-flights-ticket-route">
            <div className="plan-flights-ticket-end">
              <span className="plan-flights-ticket-iata iata">{booking.leg.originIata}</span>
              <span className="muted">{from?.name ?? ""}</span>
            </div>
            <IconPlane size={20} className="plan-flights-ticket-plane" />
            <div className="plan-flights-ticket-end plan-flights-ticket-end--to">
              <span className="plan-flights-ticket-iata iata">{booking.leg.destinationIata}</span>
              <span className="muted">{to?.name ?? ""}</span>
            </div>
          </div>
        </div>
        <div className="plan-flights-ticket-ref">
          <div>
            <p className="plan-flights-total-label">Booking reference</p>
            <p className="plan-flights-ref iata">{booking.bookingReference}</p>
          </div>
          <Button size="sm" variant="ghost" icon={copied ? <IconCheck size={16} /> : undefined} onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <dl className="plan-flights-dl plan-flights-ticket-dl">
          <div className="plan-flights-dl-row">
            <dt>Depart</dt>
            <dd className="num">{dateText(booking.leg.departureDate)}</dd>
          </div>
          {booking.leg.returnDate ? (
            <div className="plan-flights-dl-row">
              <dt>Return</dt>
              <dd className="num">{dateText(booking.leg.returnDate)}</dd>
            </div>
          ) : null}
          <div className="plan-flights-dl-row">
            <dt>Airline</dt>
            <dd>{booking.offerSnapshot.carrier}</dd>
          </div>
          {pax ? (
            <div className="plan-flights-dl-row">
              <dt>Passenger</dt>
              <dd>
                {passengerName(pax)}
                {booking.passengers.length > 1 ? ` and ${booking.passengers.length - 1} more` : ""}
              </dd>
            </div>
          ) : null}
          <div className="plan-flights-dl-row">
            <dt>Total</dt>
            <dd className="num">{priceText(booking.totalAmount, booking.totalCurrency)}</dd>
          </div>
          {cancelled && booking.cancelledAt ? (
            <div className="plan-flights-dl-row">
              <dt>Cancelled</dt>
              <dd className="num">{dateText(booking.cancelledAt.slice(0, 10))}</dd>
            </div>
          ) : null}
        </dl>
      </Card>
    </div>
  );
}
