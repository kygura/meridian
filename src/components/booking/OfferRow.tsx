import {
  formatDurationMinutes,
  formatOfferTimes,
  formatStops,
  type Offer,
} from "../../lib/bookingApi";
import ProvenanceBadge from "./ProvenanceBadge";
import OfferExpiryCountdown from "./OfferExpiryCountdown";

/** One offer row (DESIGN-booking.md §3.3): carrier, price, duration, stops,
 *  times, provenance, expiry countdown, SELECT. Whole-row click selects
 *  (mirrors .candidate-row behavior). */
export default function OfferRow({
  offer,
  selected,
  onSelect,
}: {
  offer: Offer;
  selected: boolean;
  onSelect: () => void;
}) {
  const times = formatOfferTimes(offer.departingAt, offer.arrivingAt);
  const stops = formatStops(offer.stops);
  return (
    <div
      className={`cmd-row candidate-row offer-row ${selected ? "sel" : ""}`}
      onClick={onSelect}
    >
      <span className="candidate-color-bar bk-offer-bar" />
      <div className="bk-offer-main">
        <div className="bk-offer-line1">
          <span className="bk-offer-carrier-code">
            {offer.carrierIata ?? offer.carrier.slice(0, 2).toUpperCase()}
          </span>
          <span className="bk-offer-price">
            ${offer.priceAmount.toLocaleString()}
            <span className="bk-offer-currency"> {offer.currency}</span>
          </span>
          {offer.durationMinutes != null && (
            <span className="bk-offer-duration">
              {formatDurationMinutes(offer.durationMinutes)}
            </span>
          )}
          <span className={`bk-offer-stops${offer.stops === 0 ? " nonstop" : ""}`}>
            {stops}
          </span>
          <ProvenanceBadge source={offer.source} />
        </div>
        <div className="bk-offer-line2">
          <span className="bk-offer-carrier-name">{offer.carrier}</span>
          <span className="bk-offer-times">
            depart {times.departLabel}
            {times.arriveLabel ? ` → arrive ${times.arriveLabel}` : ""}
          </span>
        </div>
      </div>
      <div className="bk-offer-side">
        <OfferExpiryCountdown expiresAt={offer.expiresAt} />
        <button
          type="button"
          className="booking-primary-btn bk-offer-select"
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
        >
          SELECT
        </button>
      </div>
    </div>
  );
}
