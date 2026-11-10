import { create } from "zustand";
import { BookingLockedError, searchOffers, type Offer, type OfferSource } from "../../../lib/bookingApi";
import { useMeridianStore } from "../../../store";
import type { TripNode } from "../../../types";
import { Button, Card, SectionHeader } from "../../../ui";
import { IconSearch } from "../../../ui/icons";
import { BookingsList } from "./BookingsList";
import { OfferList } from "./OfferList";
import { SearchForm } from "./SearchForm";
import { emptySearch, searchParams, searchReady, searchSummary, useCheckoutHandoff, type RouteEnd, type SearchDraft } from "./search";
import "./flights.css";

/** Page state survives switching Plan tabs (module-level store, this directory only). */
interface FlightsPageState {
  draft: SearchDraft;
  showErrors: boolean;
  status: "idle" | "searching" | "ready" | "error" | "locked";
  offers: Offer[];
  source: OfferSource | null;
  searched: SearchDraft | null;
  patch: (p: Partial<FlightsPageState>) => void;
}

const useFlightsPage = create<FlightsPageState>((set) => ({
  draft: emptySearch(),
  showErrors: false,
  status: "idle",
  offers: [],
  source: null,
  searched: null,
  patch: (p) => set(p),
}));

function toNode(end: RouteEnd): TripNode {
  const c = end.cityId ? useMeridianStore.getState().cities.find((x) => x.id === end.cityId) : undefined;
  return { cityId: end.cityId ?? end.iata, name: end.name, iata: end.iata, lat: c?.lat ?? 0, lng: c?.lng ?? 0 };
}

/** #/plan/flights: search form, offers, then the BookingSheet; "Your bookings" below. */
export default function Flights() {
  const { draft, showErrors, status, offers, source, searched, patch } = useFlightsPage();

  const run = async (d: SearchDraft) => {
    patch({ status: "searching", searched: d });
    try {
      const res = await searchOffers(searchParams(d));
      // Ignore a late answer for a search that has since been replaced.
      if (useFlightsPage.getState().searched !== d) return;
      patch({ status: "ready", offers: res.offers, source: res.source });
    } catch (err) {
      if (useFlightsPage.getState().searched !== d) return;
      patch({ status: err instanceof BookingLockedError ? "locked" : "error" });
    }
  };

  const submit = () => {
    if (!searchReady(draft)) {
      patch({ showErrors: true });
      return;
    }
    patch({ showErrors: false });
    void run({ ...draft });
  };

  const choose = (offer: Offer) => {
    if (!searched?.origin || !searched.dest) return;
    useCheckoutHandoff.getState().put({ search: searched, offers, source, offer });
    useMeridianStore.getState().openBookingModal({
      origin: toNode(searched.origin),
      dest: toNode(searched.dest),
      departureDateHint: searched.departureDate,
    });
  };

  return (
    <div className="plan-flights">
      <Card padding="md" className="plan-flights-search">
        <SearchForm
          idPrefix="fl"
          layout="page"
          draft={draft}
          onChange={(p) => patch({ draft: { ...useFlightsPage.getState().draft, ...p } })}
          showErrors={showErrors}
          onSubmit={submit}
          submit={
            <Button type="submit" variant="primary" block icon={<IconSearch size={18} />} loading={status === "searching"}>
              Search
            </Button>
          }
        />
      </Card>

      {status !== "idle" && searched ? (
        <section className="plan-flights-section" aria-labelledby="plan-flights-results-h" aria-live="polite">
          <SectionHeader id="plan-flights-results-h" title="Flights" meta={searchSummary(searched)} />
          <OfferList
            status={status}
            offers={offers}
            source={source}
            onSelect={choose}
            onRetry={() => void run(searched)}
          />
        </section>
      ) : null}

      <BookingsList />
    </div>
  );
}
