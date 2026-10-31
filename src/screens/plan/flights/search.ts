import { create } from "zustand";
import {
  isDepartureDateValid,
  isReturnDateValid,
  type BookingTarget,
  type Offer,
  type OfferSource,
} from "../../../lib/bookingApi";
import { adultsText, dateText } from "./flightText";

/** One end of the route: an airport city. */
export interface RouteEnd {
  iata: string;
  name: string;
  cityId?: string;
}

export interface SearchDraft {
  origin: RouteEnd | null;
  dest: RouteEnd | null;
  departureDate: string;
  returnDate: string;
  passengers: number;
}

export function emptySearch(): SearchDraft {
  return { origin: null, dest: null, departureDate: "", returnDate: "", passengers: 1 };
}

export function searchFromTarget(t: BookingTarget): SearchDraft {
  const end = (n: BookingTarget["dest"] | undefined): RouteEnd | null =>
    n?.iata ? { iata: n.iata, name: n.name, cityId: n.cityId } : null;
  return {
    origin: end(t.origin),
    dest: end(t.dest),
    departureDate: t.departureDateHint ?? "",
    returnDate: "",
    passengers: 1,
  };
}

export interface SearchIssues {
  origin?: string;
  dest?: string;
  departureDate?: string;
  returnDate?: string;
}

export function searchIssues(d: SearchDraft, now: Date = new Date()): SearchIssues {
  const out: SearchIssues = {};
  if (!d.origin) out.origin = "Choose where you're flying from";
  if (!d.dest) out.dest = "Choose where you're going";
  if (d.origin && d.dest && d.origin.iata === d.dest.iata) out.dest = "Pick a different airport from the origin";
  if (!d.departureDate) out.departureDate = "Choose a date";
  else if (!isDepartureDateValid(d.departureDate, now)) out.departureDate = "Pick today or a later date";
  if (d.returnDate && !isReturnDateValid(d.returnDate, d.departureDate)) out.returnDate = "Return must be on or after departure";
  return out;
}

export function searchReady(d: SearchDraft): boolean {
  return Object.keys(searchIssues(d)).length === 0;
}

/** "LIS to OPO · Fri 14 Aug · 1 adult" */
export function searchSummary(d: SearchDraft): string {
  const parts = [`${d.origin?.name ?? "?"} to ${d.dest?.name ?? "?"}`];
  if (d.departureDate) parts.push(dateText(d.departureDate, { year: false }) + (d.returnDate ? ` – ${dateText(d.returnDate, { year: false })}` : ""));
  parts.push(adultsText(d.passengers));
  return parts.join(" · ");
}

export function searchParams(d: SearchDraft) {
  return {
    originIata: d.origin?.iata ?? "",
    destinationIata: d.dest?.iata ?? "",
    departureDate: d.departureDate,
    returnDate: d.returnDate || undefined,
    passengers: d.passengers,
  };
}

/**
 * Hand-off from the Flights page to the global BookingSheet: the page searched and the
 * person picked an offer, so the sheet should open on the passenger step with these offers.
 * Local to this directory; the shared store only knows about BookingTarget.
 */
export interface CheckoutHandoff {
  search: SearchDraft;
  offers: Offer[];
  source: OfferSource | null;
  offer: Offer;
}

interface HandoffState {
  handoff: CheckoutHandoff | null;
  put: (h: CheckoutHandoff) => void;
  take: () => CheckoutHandoff | null;
}

export const useCheckoutHandoff = create<HandoffState>((set, get) => ({
  handoff: null,
  put: (h) => set({ handoff: h }),
  take: () => {
    const h = get().handoff;
    if (h) set({ handoff: null });
    return h;
  },
}));
