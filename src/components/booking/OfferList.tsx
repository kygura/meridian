import { useMemo, useState } from "react";
import {
  sortOffers,
  type Offer,
  type OfferSortKey,
  type OfferSource,
} from "../../lib/bookingApi";
import OfferRow from "./OfferRow";

const SORT_ORDER: OfferSortKey[] = ["price", "duration", "depart"];
const SORT_LABEL: Record<OfferSortKey, string> = {
  price: "PRICE",
  duration: "DURATION",
  depart: "DEPART",
};

/** SEARCHING + OFFERS + empty states (DESIGN-booking.md §3.2/§3.3/§4.4).
 *  Sorting is client-side over the fetched offers array. */
export default function OfferList({
  searching,
  offers,
  source,
  paramsLine,
  selectedOfferId,
  recoveredFromExpiry,
  onSelect,
  onReSearch,
  onChangeSearch,
}: {
  searching: boolean;
  offers: Offer[];
  source: OfferSource | null;
  /** Mono echo of the search params, e.g. "JFK → DXB · 2026-08-14 · 1 ADULT". */
  paramsLine: string;
  selectedOfferId: string | null;
  /** §4.1 — after expired-offer recovery, hint that details are saved. */
  recoveredFromExpiry: boolean;
  onSelect: (offer: Offer) => void;
  onReSearch: () => void;
  onChangeSearch: () => void;
}) {
  const [sortKey, setSortKey] = useState<OfferSortKey>("price");
  const sorted = useMemo(() => sortOffers(offers, sortKey), [offers, sortKey]);

  if (searching) {
    return (
      <div className="bk-searching">
        <div className="agent-brief-loading">
          <span />
          <span />
          <span />
        </div>
        <div className="bk-searching-title">SEARCHING OFFERS</div>
        <div className="bk-searching-params">{paramsLine}</div>
        <div className={`bk-searching-sub${source === "mock" ? " mock" : ""}`}>
          {source === "mock"
            ? "NO PROVIDER KEY · GENERATING MOCK OFFERS"
            : "QUERYING PROVIDER…"}
        </div>
      </div>
    );
  }

  if (offers.length === 0) {
    return (
      <div className="cmd-empty">
        <div className="cmd-empty-title">NO OFFERS FOUND</div>
        <div className="cmd-empty-sub">
          No bookable offers for this route and date. Try a different date or
          nearby airport.
        </div>
        <div className="bk-empty-actions">
          <button type="button" className="tm-action-btn" onClick={onChangeSearch}>
            ← CHANGE SEARCH
          </button>
          <button type="button" className="tm-action-btn" onClick={onReSearch}>
            RE-SEARCH ↻
          </button>
        </div>
      </div>
    );
  }

  const cycleSort = () => {
    const next =
      SORT_ORDER[(SORT_ORDER.indexOf(sortKey) + 1) % SORT_ORDER.length];
    setSortKey(next);
  };

  return (
    <div className="bk-offers">
      <div className="bk-offers-head">
        <span className="bk-offers-count">OFFERS · {offers.length} FOUND</span>
        <button
          type="button"
          className="bk-sort-toggle"
          onClick={cycleSort}
          title="Cycle sort key"
        >
          SORT: {SORT_LABEL[sortKey]} ▾
        </button>
      </div>
      <div className="bk-offers-subline">
        <span>{paramsLine}</span>
        <button type="button" className="tp-link bk-linkbtn" onClick={onChangeSearch}>
          RE-SEARCH ↻
        </button>
      </div>
      {recoveredFromExpiry && (
        <div className="bk-recovered-hint">SELECT A FRESH OFFER — DETAILS SAVED</div>
      )}
      <div className="bk-offers-list">
        {sorted.map((offer) => (
          <OfferRow
            key={offer.id}
            offer={offer}
            selected={offer.id === selectedOfferId}
            onSelect={() => onSelect(offer)}
          />
        ))}
      </div>
    </div>
  );
}
