import type { Offer, PassengerDraft } from "../../../lib/bookingApi";
import { Card } from "../../../ui";
import { Countdown } from "./Countdown";
import { ProvenanceNote } from "./ProvenanceBadge";
import { dateText, durationText, passengerName, priceText, stopsText } from "./flightText";
import type { SearchDraft } from "./search";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="plan-flights-dl-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Everything that will be sent, with the provenance note and the live countdown. */
export function BookingReview({ offer, draft, search, onOfferExpire }: { offer: Offer; draft: PassengerDraft; search: SearchDraft; onOfferExpire: () => void }) {
  return (
    <div className="plan-flights-review">
      <ProvenanceNote source={offer.source} kind="booking" />
      <Card padding="md">
        <h3 className="ui-section-title">Flight</h3>
        <dl className="plan-flights-dl">
          <Row label="Route">
            {search.origin?.name} <span className="iata muted">{search.origin?.iata}</span> to {search.dest?.name}{" "}
            <span className="iata muted">{search.dest?.iata}</span>
          </Row>
          <Row label="Depart">
            <span className="num">{dateText(search.departureDate)}</span>
          </Row>
          {search.returnDate ? (
            <Row label="Return">
              <span className="num">{dateText(search.returnDate)}</span>
            </Row>
          ) : null}
          <Row label="Airline">{offer.carrier}</Row>
          <Row label="Stops">{stopsText(offer.stops)}</Row>
          {offer.durationMinutes != null ? (
            <Row label="Duration">
              <span className="num">{durationText(offer.durationMinutes)}</span>
            </Row>
          ) : null}
          <Row label="Cabin">Economy</Row>
        </dl>
      </Card>
      <Card padding="md">
        <h3 className="ui-section-title">Lead passenger</h3>
        <dl className="plan-flights-dl">
          <Row label="Name">{passengerName(draft)}</Row>
          <Row label="Born">
            <span className="num">{dateText(draft.bornOn, { weekday: false })}</span>
          </Row>
          <Row label="Email">{draft.email}</Row>
          <Row label="Phone">
            <span className="num">{draft.phoneNumber}</span>
          </Row>
        </dl>
      </Card>
      <div className="plan-flights-total">
        <div>
          <p className="plan-flights-total-label">Total</p>
          <Countdown expiresAt={offer.expiresAt} onExpire={onOfferExpire} />
        </div>
        <span className="plan-flights-total-value num">{priceText(offer.priceAmount, offer.currency)}</span>
      </div>
    </div>
  );
}
