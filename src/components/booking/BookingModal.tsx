import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../store";
import {
  searchOffers,
  createBooking,
  listBookings as fetchBookingsApi,
  OfferExpiredApiError,
  emptyPassengerDraft,
  validatePassengerDraft,
  isPassengerDraftValid,
  passengerDraftToPassenger,
  isDepartureDateValid,
  isReturnDateValid,
  type Booking,
  type Offer,
  type OfferSource,
  type PassengerDraft,
  type PassengerErrors,
} from "../../lib/bookingApi";
import BookingSearchForm, { type SearchDraft } from "./BookingSearchForm";
import OfferList from "./OfferList";
import PassengerForm from "./PassengerForm";
import BookingReview from "./BookingReview";
import BookingTicket from "./BookingTicket";
import ProvenanceBadge from "./ProvenanceBadge";
import "../../styles/booking.css";

// §4 UI state machine — BookingModal owns a discriminated state.
type Phase =
  | "configuring"
  | "searching"
  | "offers"
  | "passenger"
  | "review"
  | "submitting"
  | "booked"
  | "expired"
  | "error";

const STEPS = ["CONFIRM", "OFFERS", "PASSENGER", "REVIEW"] as const;

function phaseToStepIndex(phase: Phase): number {
  switch (phase) {
    case "configuring":
    case "searching":
      return phase === "configuring" ? 0 : 1;
    case "offers":
    case "expired":
      return 1;
    case "passenger":
      return 2;
    case "review":
    case "submitting":
    case "error":
      return 3;
    case "booked":
      return 4;
  }
}

export default function BookingModal() {
  const { bookingModal, closeBookingModal, cities, setBookings, setBookingsPanelOpen } =
    useMeridianStore();
  const { open, target } = bookingModal;

  const [phase, setPhase] = useState<Phase>("configuring");
  const [search, setSearch] = useState<SearchDraft>({
    originIata: "",
    originName: "",
    destinationIata: "",
    destName: "",
    departureDate: "",
    returnDate: "",
    passengers: 1,
  });
  const [offers, setOffers] = useState<Offer[]>([]);
  const [source, setSource] = useState<OfferSource | null>(null);
  const [selectedOffer, setSelectedOffer] = useState<Offer | null>(null);
  const [passengerDraft, setPassengerDraft] = useState<PassengerDraft>(emptyPassengerDraft());
  const [passengerErrors, setPassengerErrors] = useState<PassengerErrors>({});
  const [recoveredFromExpiry, setRecoveredFromExpiry] = useState(false);
  const [errorContext, setErrorContext] = useState<"search" | "submit">("search");
  const [discardGuard, setDiscardGuard] = useState(false);
  const [stillWorking, setStillWorking] = useState(false);
  const [createdBooking, setCreatedBooking] = useState<Booking | null>(null);
  const sessionStartRef = useRef<string>("");
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  // Reset all checkout state whenever the modal opens with a target (§7.3 —
  // passengerDraft is cleared only when the modal fully closes/reopens).
  useEffect(() => {
    if (!open || !target) return;
    sessionStartRef.current = new Date().toISOString();
    setPhase("configuring");
    setSearch({
      originIata: target.origin?.iata ?? "",
      originName: target.origin?.name ?? "",
      destinationIata: target.dest.iata ?? "",
      destName: target.dest.name,
      departureDate: target.departureDateHint ?? "",
      returnDate: "",
      passengers: 1,
    });
    setOffers([]);
    setSource(null);
    setSelectedOffer(null);
    setPassengerDraft(emptyPassengerDraft());
    setPassengerErrors({});
    setRecoveredFromExpiry(false);
    setDiscardGuard(false);
    setCreatedBooking(null);
  }, [open, target]);

  const passengerDirty = useMemo(
    () =>
      Boolean(
        passengerDraft.givenName ||
          passengerDraft.familyName ||
          passengerDraft.bornOn ||
          passengerDraft.gender ||
          passengerDraft.email ||
          passengerDraft.phoneNumber
      ),
    [passengerDraft]
  );

  const paramsLine = `${search.originIata} → ${search.destinationIata} · ${search.departureDate} · ${search.passengers} ${search.passengers === 1 ? "ADULT" : "ADULTS"}`;

  const departValid = isDepartureDateValid(search.departureDate);
  const returnValid = !search.returnDate || isReturnDateValid(search.returnDate, search.departureDate);
  const searchReady = departValid && returnValid && Boolean(search.originIata && search.destinationIata);

  // ── Actions ──────────────────────────────────────────────────────

  const runSearch = useCallback(
    async (recovery: boolean) => {
      setPhase(recovery ? "expired" : "searching");
      try {
        const result = await searchOffers({
          originIata: search.originIata,
          destinationIata: search.destinationIata,
          departureDate: search.departureDate,
          returnDate: search.returnDate || undefined,
          passengers: search.passengers,
        });
        setOffers(result.offers);
        setSource(result.source);
        setSelectedOffer(null);
        setRecoveredFromExpiry(recovery);
        setPhase("offers");
      } catch {
        setErrorContext("search");
        setPhase("error");
      }
    },
    [search]
  );

  // §4.1 expired-offer recovery: passenger details + params preserved,
  // auto re-search fires immediately.
  const triggerExpiredRecovery = useCallback(() => {
    setSelectedOffer(null);
    void runSearch(true);
  }, [runSearch]);

  const selectOffer = (offer: Offer) => {
    setSelectedOffer(offer);
    // §4.1: after recovery with a complete, valid form, selecting a fresh
    // offer jumps straight to REVIEW (user can still step back to edit).
    if (recoveredFromExpiry && isPassengerDraftValid(passengerDraft)) {
      setPhase("review");
    } else {
      setPhase("passenger");
    }
  };

  const goToReview = () => {
    // §4.3: validate on REVIEW →, block + mark + focus first invalid.
    const errors = validatePassengerDraft(passengerDraft);
    setPassengerErrors(errors);
    if (Object.keys(errors).length === 0) setPhase("review");
  };

  const refreshBookingsCache = useCallback(async (): Promise<Booking[]> => {
    try {
      const all = await fetchBookingsApi();
      setBookings(all);
      return all;
    } catch {
      return [];
    }
  }, [setBookings]);

  const submitBooking = useCallback(async () => {
    if (!selectedOffer) return;
    setPhase("submitting");
    setStillWorking(false);
    const slowTimer = setTimeout(() => setStillWorking(true), 20_000);
    try {
      const booking = await createBooking({
        offerId: selectedOffer.id,
        tripId: target?.tripId,
        legIndex: target?.legIndex,
        passengers: [passengerDraftToPassenger(passengerDraft)],
        searchSnapshot: {
          offer: selectedOffer,
          leg: {
            originIata: search.originIata,
            destinationIata: search.destinationIata,
            departureDate: search.departureDate,
            returnDate: search.returnDate || undefined,
          },
        },
      });
      setCreatedBooking(booking);
      setPhase("booked");
      void refreshBookingsCache();
    } catch (err) {
      if (err instanceof OfferExpiredApiError) {
        triggerExpiredRecovery();
      } else {
        setErrorContext("submit");
        setPhase("error");
      }
    } finally {
      clearTimeout(slowTimer);
    }
  }, [selectedOffer, target, passengerDraft, search, refreshBookingsCache, triggerExpiredRecovery]);

  // §4.2: RETRY on a submit error first checks whether the order already
  // landed server-side (avoid double-booking).
  const retry = useCallback(async () => {
    if (errorContext === "search") {
      void runSearch(false);
      return;
    }
    const all = await refreshBookingsCache();
    const landed = all.find(
      (b) =>
        b.createdAt >= sessionStartRef.current &&
        b.leg.originIata === search.originIata &&
        b.leg.destinationIata === search.destinationIata &&
        b.leg.departureDate === search.departureDate &&
        b.passengers[0]?.email === passengerDraft.email.trim()
    );
    if (landed) {
      setCreatedBooking(landed);
      setPhase("booked");
      return;
    }
    void submitBooking();
  }, [errorContext, runSearch, refreshBookingsCache, search, passengerDraft, submitBooking]);

  // ── Close / discard guard (§2) ───────────────────────────────────

  const requestClose = useCallback(() => {
    if (phase === "submitting") return; // §3.5a: no dismissal mid-order
    if (phase === "booked") {
      closeBookingModal();
      return;
    }
    if (passengerDirty) {
      setDiscardGuard(true);
      return;
    }
    closeBookingModal();
  }, [phase, passengerDirty, closeBookingModal]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      } else if (e.key === "Tab") {
        // §10: trap focus within the modal.
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select, a[href], [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  if (!open || !target) return null;

  const stepIndex = phaseToStepIndex(phase);
  const routeEditable = target.tripId === undefined;

  // §3.0: completed step labels clickable to jump back only when safe.
  const stepBack = (i: number) => {
    if (i >= stepIndex) return;
    if (i === 0 && (phase === "offers" || phase === "passenger" || phase === "review"))
      setPhase("configuring");
    else if (i === 1 && (phase === "passenger" || phase === "review")) setPhase("offers");
    else if (i === 2 && phase === "review") setPhase("passenger");
  };

  return (
    <div className="cmd-overlay" onMouseDown={requestClose}>
      <div
        className="booking-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Book flight"
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* §3.0 persistent header */}
        <div className="booking-head">
          <div className="booking-head-title-row">
            <span className="booking-head-title">
              ✈ BOOK FLIGHT
              <span className="booking-head-route">
                {" "}
                · {search.originIata || "—"} → {search.destinationIata || "—"}
              </span>
            </span>
            <span className="booking-head-right">
              {source && <ProvenanceBadge source={source} />}
              <button
                type="button"
                className="tm-action-btn booking-close"
                aria-label="Close"
                onClick={requestClose}
              >
                ✕
              </button>
            </span>
          </div>
          <div className="booking-steprail">
            {STEPS.map((label, i) => {
              const state = i < stepIndex ? "done" : i === stepIndex ? "current" : "upcoming";
              const clickable = i < stepIndex && phase !== "submitting" && phase !== "booked";
              return (
                <span key={label} className="booking-step-wrap">
                  {i > 0 && <span className="booking-step-connector" aria-hidden="true" />}
                  <button
                    type="button"
                    className={`booking-step ${state}`}
                    disabled={!clickable}
                    onClick={() => stepBack(i)}
                  >
                    <span className="booking-step-dot" aria-hidden="true">
                      {state === "upcoming" ? "○" : "●"}
                    </span>
                    {label}
                  </button>
                </span>
              );
            })}
          </div>
        </div>

        {/* Body (scrolls internally) */}
        <div className="booking-body">
          {phase === "configuring" && (
            <BookingSearchForm
              draft={search}
              onChange={(patch) => setSearch((s) => ({ ...s, ...patch }))}
              routeEditable={routeEditable}
              cities={cities}
            />
          )}

          {(phase === "searching" || phase === "offers") && (
            <OfferList
              searching={phase === "searching"}
              offers={offers}
              source={source}
              paramsLine={paramsLine}
              selectedOfferId={selectedOffer?.id ?? null}
              recoveredFromExpiry={recoveredFromExpiry}
              onSelect={selectOffer}
              onReSearch={() => void runSearch(false)}
              onChangeSearch={() => setPhase("configuring")}
            />
          )}

          {phase === "passenger" && selectedOffer && (
            <PassengerForm
              offer={selectedOffer}
              draft={passengerDraft}
              errors={passengerErrors}
              passengerCount={search.passengers}
              onChange={(patch) => setPassengerDraft((d) => ({ ...d, ...patch }))}
              onOfferExpire={triggerExpiredRecovery}
            />
          )}

          {(phase === "review" || phase === "submitting") && selectedOffer && (
            <div className="bk-review-host">
              <BookingReview
                offer={selectedOffer}
                draft={passengerDraft}
                originIata={search.originIata}
                destinationIata={search.destinationIata}
                departureDate={search.departureDate}
                returnDate={search.returnDate || undefined}
                onOfferExpire={phase === "review" ? triggerExpiredRecovery : () => {}}
                confirmRef={phase === "review" ? confirmBtnRef : undefined}
              />
              {phase === "submitting" && (
                <div className="bk-submitting-cover">
                  <div className="agent-brief-loading">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="bk-searching-title">ISSUING BOOKING…</div>
                  {stillWorking && <div className="bk-searching-sub">STILL WORKING…</div>}
                </div>
              )}
            </div>
          )}

          {phase === "booked" && createdBooking && (
            <BookingTicket booking={createdBooking} animateIn />
          )}

          {phase === "expired" && (
            <div className="bk-expired-banner" role="alert">
              <div className="bk-expired-title">⚠ OFFER EXPIRED</div>
              <div className="bk-expired-body">
                Offers only live a few minutes. Re-searching the same route now —
                your passenger details are saved.
              </div>
              <div className="bk-expired-loader">
                <div className="agent-brief-loading">
                  <span />
                  <span />
                  <span />
                </div>
                <span className="bk-searching-title">RE-SEARCHING</span>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="bk-error-panel" role="alert">
              <div className="bk-error-title">⚠ COULDN'T REACH THE BOOKING SERVICE</div>
              <div className="bk-error-body">The request failed. Your details are saved.</div>
              {errorContext === "submit" && (
                <div className="bk-error-hint">
                  IF YOU JUST CONFIRMED, CHECK BOOKINGS BEFORE RETRYING
                </div>
              )}
            </div>
          )}
        </div>

        {/* §2 discard guard */}
        {discardGuard && (
          <div className="bk-discard-guard" role="alertdialog" aria-label="Discard checkout">
            <span className="bk-discard-title">DISCARD CHECKOUT?</span>
            <span className="bk-discard-sub">Details will be lost.</span>
            <button
              type="button"
              className="tm-action-btn"
              autoFocus
              onClick={() => setDiscardGuard(false)}
            >
              KEEP
            </button>
            <button
              type="button"
              className="tm-action-btn tm-delete-btn"
              onClick={() => closeBookingModal()}
            >
              DISCARD
            </button>
          </div>
        )}

        {/* Persistent footer — contextual actions */}
        <div className="booking-foot">
          {phase === "configuring" && (
            <button
              type="button"
              className="booking-primary-btn"
              disabled={!searchReady}
              onClick={() => void runSearch(false)}
            >
              SEARCH OFFERS →
            </button>
          )}
          {phase === "offers" && (
            <button
              type="button"
              className="tm-action-btn"
              onClick={() => setPhase("configuring")}
            >
              ← BACK
            </button>
          )}
          {phase === "passenger" && (
            <>
              <button
                type="button"
                className="tm-action-btn"
                onClick={() => setPhase("offers")}
              >
                ← BACK
              </button>
              <button type="button" className="booking-primary-btn" onClick={goToReview}>
                REVIEW →
              </button>
            </>
          )}
          {phase === "review" && (
            <>
              <button
                type="button"
                className="tm-action-btn"
                onClick={() => setPhase("passenger")}
              >
                ← BACK
              </button>
              <button
                type="button"
                ref={confirmBtnRef}
                className="booking-primary-btn"
                onClick={() => void submitBooking()}
              >
                ✓ CONFIRM BOOKING
              </button>
            </>
          )}
          {phase === "booked" && (
            <>
              <button
                type="button"
                className="tm-action-btn"
                onClick={() => {
                  closeBookingModal();
                  setBookingsPanelOpen(true);
                }}
              >
                VIEW ALL BOOKINGS
              </button>
              <button
                type="button"
                className="booking-primary-btn"
                onClick={() => closeBookingModal()}
              >
                DONE
              </button>
            </>
          )}
          {phase === "error" && (
            <>
              <button
                type="button"
                className="tm-action-btn"
                onClick={() => setPhase(errorContext === "search" ? "configuring" : "review")}
              >
                ← BACK
              </button>
              <button
                type="button"
                className="booking-primary-btn"
                onClick={() => void retry()}
              >
                ↻ RETRY
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
