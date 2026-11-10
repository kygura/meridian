import { useMemo, useState } from "react";
import { formatOfferTimes, sortOffers, type Offer, type OfferSortKey, type OfferSource } from "../../../lib/bookingApi";
import { Button, Card, EmptyState, ErrorState, Segmented, Skeleton, UnlockCard, cx } from "../../../ui";
import { IconArrowRight, IconPlane } from "../../../ui/icons";
import { Countdown } from "./Countdown";
import { ProvenanceBadge, ProvenanceNote } from "./ProvenanceBadge";
import { durationText, priceText, stopsText } from "./flightText";
import { RealBookingLinks } from "./HandOff";
import type { BookLink } from "../../../lib/bookLinks";

const SORTS: { value: OfferSortKey; label: string }[] = [
  { value: "price", label: "Cheapest" },
  { value: "duration", label: "Fastest" },
  { value: "depart", label: "Earliest" },
];

export function OfferRow({ offer, selected, onSelect }: { offer: Offer; selected?: boolean; onSelect: () => void }) {
  const times = formatOfferTimes(offer.departingAt, offer.arrivingAt);
  const code = offer.carrierIata ?? offer.carrier.slice(0, 2).toUpperCase();
  return (
    <li>
      <Card padding="none" interactive className={cx("plan-flights-offer", selected && "is-selected")}>
        <button type="button" className="plan-flights-offer-hit" onClick={onSelect} aria-label={`Choose ${offer.carrier}, ${priceText(offer.priceAmount, offer.currency)}, ${stopsText(offer.stops)}`} />
        <span className="plan-flights-carrier iata" aria-hidden="true">
          {code}
        </span>
        <div className="plan-flights-offer-main">
          <div className="plan-flights-offer-line1">
            <span className="plan-flights-offer-times num">
              {times.departLabel}
              {times.arriveLabel ? (
                <>
                  <IconArrowRight size={14} />
                  {times.arriveLabel}
                </>
              ) : null}
            </span>
            <ProvenanceBadge source={offer.source} />
          </div>
          <div className="plan-flights-offer-line2">
            <span>{offer.carrier}</span>
            <span aria-hidden="true">·</span>
            <span className={cx(offer.stops === 0 && "plan-flights-nonstop")}>{stopsText(offer.stops)}</span>
            {offer.durationMinutes != null ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="num">{durationText(offer.durationMinutes)}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="plan-flights-offer-side">
          <span className="plan-flights-price num">{priceText(offer.priceAmount, offer.currency)}</span>
          <Countdown expiresAt={offer.expiresAt} compact />
        </div>
      </Card>
    </li>
  );
}

export interface OfferListProps {
  /** "locked": the server wants the owner signed in before it searches (it would spend a provider key). */
  status: "searching" | "ready" | "error" | "locked";
  offers: Offer[];
  source: OfferSource | null;
  selectedId?: string | null;
  onSelect: (o: Offer) => void;
  onRetry: () => void;
  onChangeSearch?: () => void;
  /** Shown after an expired offer was re-searched. */
  recovered?: boolean;
  /** The same search on real booking sites (lib/bookLinks). */
  realLinks?: BookLink[];
}

/** Offers with sorting, plus loading, empty and error states. */
export function OfferList({ status, offers, source, selectedId, onSelect, onRetry, onChangeSearch, recovered, realLinks }: OfferListProps) {
  const [sort, setSort] = useState<OfferSortKey>("price");
  const sorted = useMemo(() => sortOffers(offers, sort), [offers, sort]);

  if (status === "searching") {
    return (
      <div className="plan-flights-offers" aria-busy="true">
        <p className="plan-flights-status muted">Looking for flights…</p>
        <ul className="plan-flights-offer-list">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Card padding="md" className="plan-flights-offer-skel">
                <Skeleton width={40} height={40} radius={8} />
                <div className="plan-flights-grow">
                  <Skeleton width="45%" height={16} />
                  <Skeleton width="70%" height={12} />
                </div>
                <Skeleton width={64} height={20} />
              </Card>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (status === "locked") {
    return <UnlockCard title="Sign in to search flights" onUnlocked={onRetry} />;
  }
  if (status === "error") {
    return <ErrorState message="Couldn't search for flights. Check your connection and try again." onRetry={onRetry} />;
  }
  if (offers.length === 0) {
    return (
      <div className="plan-flights-offers">
        <EmptyState
          icon={<IconPlane />}
          title="No flights for this route and date"
          description="Try another date or a nearby airport."
          action={onChangeSearch ? <Button onClick={onChangeSearch}>Change search</Button> : <Button onClick={onRetry}>Search again</Button>}
        />
        {realLinks ? <RealBookingLinks links={realLinks} /> : null}
      </div>
    );
  }
  return (
    <div className="plan-flights-offers">
      <div className="plan-flights-offers-head">
        <p className="plan-flights-count">
          {offers.length} {offers.length === 1 ? "flight" : "flights"}
        </p>
        <Segmented<OfferSortKey> label="Sort flights" size="sm" options={SORTS} value={sort} onChange={setSort} />
      </div>
      {source ? <ProvenanceNote source={source} /> : null}
      {realLinks ? <RealBookingLinks links={realLinks} /> : null}
      {recovered ? <p className="plan-flights-status">That price expired, so here are fresh ones. Your details are saved.</p> : null}
      <ul className="plan-flights-offer-list">
        {sorted.map((o) => (
          <OfferRow key={o.id} offer={o} selected={o.id === selectedId} onSelect={() => onSelect(o)} />
        ))}
      </ul>
    </div>
  );
}
