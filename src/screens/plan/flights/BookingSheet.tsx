import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OfferExpiredApiError,
  createBooking,
  emptyPassengerDraft,
  isPassengerDraftValid,
  listBookings,
  passengerDraftToPassenger,
  searchOffers,
  validatePassengerDraft,
  type Booking,
  type Offer,
  type OfferSource,
  type PassengerDraft,
  type PassengerErrors,
} from "../../../lib/bookingApi";
import { navigate } from "../../../lib/router";
import { useMeridianStore } from "../../../store";
import { Button, Dialog, ErrorState, Sheet, Spinner, toast } from "../../../ui";
import { IconArrowLeft, IconSearch } from "../../../ui/icons";
import { BookingReview } from "./BookingReview";
import { BookingTicket } from "./BookingTicket";
import { OfferList } from "./OfferList";
import { PassengerForm } from "./PassengerForm";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { SearchForm } from "./SearchForm";
import { priceText } from "./flightText";
import { emptySearch, searchFromTarget, searchParams, searchReady, useCheckoutHandoff, type SearchDraft } from "./search";
import "./flights.css";

type Phase = "configuring" | "searching" | "offers" | "passenger" | "review" | "submitting" | "booked" | "expired" | "error";

const STEP: Record<Phase, string> = {
  configuring: "Step 1 of 4 · Where and when",
  searching: "Step 2 of 4 · Choose a flight",
  offers: "Step 2 of 4 · Choose a flight",
  expired: "Step 2 of 4 · Choose a flight",
  passenger: "Step 3 of 4 · Passenger details",
  review: "Step 4 of 4 · Review and book",
  submitting: "Step 4 of 4 · Review and book",
  error: "Something went wrong",
  booked: "You're booked",
};

/**
 * Global booking flow. Opens from anywhere with
 * useMeridianStore.getState().openBookingModal(target), or from the Flights page with an
 * offer already chosen (via the local checkout hand-off). State lives here; the shared
 * store only holds { open, target }.
 */
export default function BookingSheet() {
  const bookingModal = useMeridianStore((s) => s.bookingModal);
  const closeBookingModal = useMeridianStore((s) => s.closeBookingModal);
  const setBookings = useMeridianStore((s) => s.setBookings);
  const { open, target } = bookingModal;

  const [phase, setPhase] = useState<Phase>("configuring");
  const [search, setSearch] = useState<SearchDraft>(emptySearch);
  const [locks, setLocks] = useState({ origin: false, dest: false });
  const [showSearchErrors, setShowSearchErrors] = useState(false);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [source, setSource] = useState<OfferSource | null>(null);
  const [selected, setSelected] = useState<Offer | null>(null);
  const [draft, setDraft] = useState<PassengerDraft>(emptyPassengerDraft);
  const [errors, setErrors] = useState<PassengerErrors>({});
  const [recovered, setRecovered] = useState(false);
  const [errorContext, setErrorContext] = useState<"search" | "submit">("search");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [stillWorking, setStillWorking] = useState(false);
  const [booking, setBooking] = useState<Booking | null>(null);
  const sessionStart = useRef("");

  // Fresh checkout every time the sheet opens.
  useEffect(() => {
    if (!open) return;
    sessionStart.current = new Date().toISOString();
    const handoff = useCheckoutHandoff.getState().take();
    setDraft(emptyPassengerDraft());
    setErrors({});
    setRecovered(false);
    setDiscardOpen(false);
    setBooking(null);
    setShowSearchErrors(false);
    if (handoff) {
      setSearch(handoff.search);
      setLocks({ origin: false, dest: false });
      setOffers(handoff.offers);
      setSource(handoff.source);
      setSelected(handoff.offer);
      setPhase("passenger");
      return;
    }
    const s = target ? searchFromTarget(target) : emptySearch();
    setSearch(s);
    setLocks({ origin: target?.tripId !== undefined && !!s.origin, dest: target?.tripId !== undefined && !!s.dest });
    setOffers([]);
    setSource(null);
    setSelected(null);
    setPhase("configuring");
  }, [open, target]);

  const dirty = useMemo(
    () => Boolean(draft.givenName || draft.familyName || draft.bornOn || draft.gender || draft.email || draft.phoneNumber),
    [draft]
  );
  const route = search.origin && search.dest ? `${search.origin.iata} to ${search.dest.iata}` : "";

  const runSearch = useCallback(
    async (recovery: boolean) => {
      setPhase(recovery ? "expired" : "searching");
      try {
        const res = await searchOffers(searchParams(search));
        setOffers(res.offers);
        setSource(res.source);
        setSelected(null);
        setRecovered(recovery);
        setPhase("offers");
      } catch {
        setErrorContext("search");
        setPhase("error");
      }
    },
    [search]
  );

  const startSearch = () => {
    if (!searchReady(search)) {
      setShowSearchErrors(true);
      return;
    }
    void runSearch(false);
  };

  const onExpired = useCallback(() => {
    setSelected(null);
    void runSearch(true);
  }, [runSearch]);

  const choose = (o: Offer) => {
    setSelected(o);
    setPhase(recovered && isPassengerDraftValid(draft) ? "review" : "passenger");
  };

  const toReview = () => {
    const e = validatePassengerDraft(draft);
    setErrors(e);
    if (Object.keys(e).length === 0) setPhase("review");
  };

  const refreshBookings = useCallback(async (): Promise<Booking[]> => {
    try {
      const all = await listBookings();
      setBookings(all);
      return all;
    } catch {
      return [];
    }
  }, [setBookings]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setPhase("submitting");
    setStillWorking(false);
    const slow = window.setTimeout(() => setStillWorking(true), 20_000);
    try {
      const b = await createBooking({
        offerId: selected.id,
        tripId: target?.tripId,
        legIndex: target?.legIndex,
        passengers: [passengerDraftToPassenger(draft)],
        searchSnapshot: {
          offer: selected,
          leg: {
            originIata: search.origin?.iata ?? "",
            destinationIata: search.dest?.iata ?? "",
            departureDate: search.departureDate,
            returnDate: search.returnDate || undefined,
          },
        },
      });
      setBooking(b);
      setPhase("booked");
      toast("Flight booked", { tone: "success" });
      void refreshBookings();
    } catch (err) {
      if (err instanceof OfferExpiredApiError) onExpired();
      else {
        setErrorContext("submit");
        setPhase("error");
      }
    } finally {
      window.clearTimeout(slow);
    }
  }, [selected, target, draft, search, refreshBookings, onExpired]);

  // Retrying a failed booking first checks whether it went through, so nobody books twice.
  const retry = useCallback(async () => {
    if (errorContext === "search") {
      void runSearch(false);
      return;
    }
    const all = await refreshBookings();
    const landed = all.find(
      (b) =>
        b.createdAt >= sessionStart.current &&
        b.leg.originIata === search.origin?.iata &&
        b.leg.destinationIata === search.dest?.iata &&
        b.leg.departureDate === search.departureDate &&
        b.passengers[0]?.email === draft.email.trim()
    );
    if (landed) {
      setBooking(landed);
      setPhase("booked");
      return;
    }
    void submit();
  }, [errorContext, runSearch, refreshBookings, search, draft, submit]);

  const requestClose = useCallback(() => {
    if (phase === "submitting") return;
    if (phase !== "booked" && dirty) {
      setDiscardOpen(true);
      return;
    }
    closeBookingModal();
  }, [phase, dirty, closeBookingModal]);

  const back = (to: Phase) => () => setPhase(to);

  let footer: React.ReactNode = null;
  switch (phase) {
    case "configuring":
      footer = (
        <Button variant="primary" block icon={<IconSearch size={18} />} onClick={startSearch}>
          Search flights
        </Button>
      );
      break;
    case "offers":
      footer = (
        <Button icon={<IconArrowLeft size={18} />} onClick={back("configuring")}>
          Change search
        </Button>
      );
      break;
    case "passenger":
      footer = (
        <>
          <Button icon={<IconArrowLeft size={18} />} onClick={back("offers")}>
            Back
          </Button>
          <Button variant="primary" onClick={toReview}>
            Review
          </Button>
        </>
      );
      break;
    case "review":
    case "submitting":
      footer = (
        <>
          <Button icon={<IconArrowLeft size={18} />} onClick={back("passenger")} disabled={phase === "submitting"}>
            Back
          </Button>
          <Button variant="primary" loading={phase === "submitting"} onClick={() => void submit()} data-autofocus>
            {phase === "submitting" ? "Booking…" : selected ? `Book for ${priceText(selected.priceAmount, selected.currency)}` : "Book"}
          </Button>
        </>
      );
      break;
    case "booked":
      footer = (
        <>
          <Button
            onClick={() => {
              closeBookingModal();
              navigate({ view: "plan", tab: "flights" });
            }}
          >
            See all bookings
          </Button>
          <Button variant="primary" onClick={closeBookingModal}>
            Done
          </Button>
        </>
      );
      break;
    case "error":
      footer = (
        <Button icon={<IconArrowLeft size={18} />} onClick={back(errorContext === "search" ? "configuring" : "review")}>
          Back
        </Button>
      );
      break;
  }

  return (
    <>
      <Sheet
        open={open}
        onClose={requestClose}
        title="Book a flight"
        description={STEP[phase]}
        headerExtra={source ? <ProvenanceBadge source={source} /> : undefined}
        size="lg"
        desktop="center"
        footer={footer ? <div className="plan-flights-sheet-foot">{footer}</div> : undefined}
        className="plan-flights-sheet"
      >
        {phase === "configuring" ? (
          <SearchForm
            idPrefix="bk"
            layout="sheet"
            draft={search}
            onChange={(p) => setSearch((s) => ({ ...s, ...p }))}
            lockOrigin={locks.origin}
            lockDest={locks.dest}
            showErrors={showSearchErrors}
            onSubmit={startSearch}
          />
        ) : null}

        {phase === "searching" || phase === "offers" ? (
          <OfferList
            status={phase === "searching" ? "searching" : "ready"}
            offers={offers}
            source={source}
            selectedId={selected?.id}
            recovered={recovered}
            onSelect={choose}
            onRetry={() => void runSearch(false)}
            onChangeSearch={back("configuring")}
          />
        ) : null}

        {phase === "expired" ? (
          <div className="plan-flights-center" role="status">
            <Spinner size={24} />
            <p className="ui-section-title">That price expired</p>
            <p className="muted">Prices are only held for a few minutes. Finding fresh ones now. Your details are saved.</p>
          </div>
        ) : null}

        {phase === "passenger" && selected ? (
          <PassengerForm
            idPrefix="bk"
            offer={selected}
            route={route}
            draft={draft}
            errors={errors}
            passengerCount={search.passengers}
            onChange={(p) => setDraft((d) => ({ ...d, ...p }))}
            onOfferExpire={onExpired}
          />
        ) : null}

        {(phase === "review" || phase === "submitting") && selected ? (
          <>
            <BookingReview offer={selected} draft={draft} search={search} onOfferExpire={phase === "review" ? onExpired : () => {}} />
            {phase === "submitting" && stillWorking ? (
              <p className="plan-flights-status muted" role="status">
                Still working. This can take a little while.
              </p>
            ) : null}
          </>
        ) : null}

        {phase === "booked" && booking ? <BookingTicket booking={booking} /> : null}

        {phase === "error" ? (
          <div className="plan-flights-error">
            <ErrorState
              message={errorContext === "search" ? "Couldn't search for flights." : "Couldn't finish the booking. Your details are saved."}
              onRetry={() => void retry()}
            />
            {errorContext === "submit" ? (
              <p className="muted plan-flights-sub">If you just pressed Book, Retry checks your bookings first so nothing is booked twice.</p>
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <Dialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        role="alertdialog"
        title="Discard this booking?"
        description="The passenger details you entered will be lost."
        footer={
          <>
            <Button onClick={() => setDiscardOpen(false)} data-autofocus>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDiscardOpen(false);
                closeBookingModal();
              }}
            >
              Discard
            </Button>
          </>
        }
      />
    </>
  );
}
