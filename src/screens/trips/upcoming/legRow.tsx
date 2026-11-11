// One leg of the route in the trip editor (ADR 0010): how you travel it, a rough time
// and cost, where to really book it, and the booking you made written down.
//
// Meridian never takes real money. "Book on…" opens someone else's search; the only
// booking Meridian makes itself is a test booking, and it is always labelled as one.

import { useEffect, useRef, useState } from "react";
import { useMeridianStore } from "../../../store";
import { findLegBooking } from "../../../lib/bookingApi";
import { hrefFor } from "../../../lib/router";
import { legLinks } from "../../../lib/bookLinks";
import { LEG_MODES, MODE_LABEL, legPlanSlot, type TripLeg } from "../../../lib/legs";
import { cleanLegRecord, formatDay, legDate } from "../../../lib/itinerary";
import { formatFlightTime, formatKm } from "../../../lib/tripPlan";
import { Badge, Button, Field, Input, Popover, Select, Sheet, SectionHeader, toast } from "../../../ui";
import { IconCheck, IconEdit, IconExternal, IconPlane } from "../../../ui/icons";
import type { City, LegMode, LegPlan, LegRecord, Trip } from "../../../types";
import { useTripMoney } from "./money";
import { MoneyInput, moneyDraft, moneyFromDraft, type MoneyDraftValue } from "./moneyInput";

/** Small line icons for the modes the shared icon set has no glyph for. */
function ModeIcon({ mode, size = 16 }: { mode: LegMode; size?: number }) {
  if (mode === "flight") return <IconPlane size={size} />;
  const paths: Record<Exclude<LegMode, "flight">, string> = {
    train: "M7 3h10a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Zm-2 7h14M9 14h.01M15 14h.01M8 17l-2 4m10-4 2 4",
    bus: "M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11H5V5Zm0 6h14M8 16v3m8-3v3M8 13.5h.01M16 13.5h.01M3 8v3m18-3v3",
    ferry: "M3 17c1.5 1.5 3 1.5 4.5 0s3-1.500 4.5 0 3 1.500 4.5 0 3-1.500 4.5 0M5 14l-1-4h16l-1 4M7 10V6h10v4M12 6V3",
    drive: "M5 11l1.500-4.500A2 2 0 0 1 8.400 5h7.200a2 2 0 0 1 1.900 1.500L19 11m-14 0h14a1 1 0 0 1 1 1v4H4v-4a1 1 0 0 1 1-1Zm1 5v2m12-2v2M7.500 13.500h.01M16.500 13.500h.01",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[mode]} />
    </svg>
  );
}

export interface LegRowProps {
  trip: Trip;
  leg: TripLeg;
  size: "sm" | "md";
  booking: ReturnType<typeof findLegBooking>;
  /** Month-level hint from the season (first day of the next stop's months). */
  departureDateHint?: string;
  cityIdx: Map<string, City>;
}

export function LegRow({ trip, leg, size, booking, departureDateHint, cityIdx }: LegRowProps) {
  const money = useTripMoney();
  const [menu, setMenu] = useState(false);
  const [recording, setRecording] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const slot = legPlanSlot(leg.index);
  const testBooked = booking && booking.status === "booked";
  // An exact date beats the month-level hint.
  const date = (trip.year ? legDate(trip, leg) : undefined) ?? departureDateHint;

  const savePlan = (patch: Partial<Pick<LegPlan, "mode" | "booked">>) => {
    const current: LegPlan = { fromCityId: leg.from.cityId, mode: leg.modeIsDefault ? undefined : leg.mode, booked: leg.record };
    const next: LegPlan = { ...current, ...patch };
    if (!next.mode) delete next.mode;
    if (!next.booked) delete next.booked;
    useMeridianStore.getState().setLegPlan(trip.id, slot, next.mode || next.booked ? next : undefined);
  };

  const place = (n: TripLeg["from"]) => ({ name: n.name, iata: n.iata, country: cityIdx.get(n.cityId)?.country });
  const links = legLinks({ from: place(leg.from), to: place(leg.to), date, travellers: trip.travellers }, leg.mode);
  const what = `${MODE_LABEL[leg.mode].toLowerCase()} from ${leg.from.name} to ${leg.to.name}`;
  const r = leg.record;

  const testBook = () => {
    setMenu(false);
    useMeridianStore
      .getState()
      .openBookingModal({ tripId: trip.id, legIndex: leg.index, origin: leg.from, dest: leg.to, departureDateHint: date });
  };

  return (
    <div className="trips-ed-leg trips-leg">
      <span className="trips-ed-leg-icon" aria-hidden="true">
        <ModeIcon mode={leg.mode} />
      </span>
      <Select
        size="sm"
        className="trips-leg-mode"
        aria-label={`How you travel from ${leg.from.name} to ${leg.to.name}`}
        title={leg.modeIsDefault ? `Suggested: ${leg.modeReason}. Change it if you know better.` : undefined}
        value={leg.mode}
        options={LEG_MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
        onChange={(e) => savePlan({ mode: e.target.value as LegMode })}
      />
      <div className="trips-ed-leg-text" title={leg.method}>
        <span className="sr-only">Estimate for the {what}: </span>
        <span className="tabular">{formatFlightTime(leg.hours)}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular">{formatKm(leg.km)}</span>
        <span aria-hidden="true">·</span>
        <span>
          about <span className="tabular">{money(leg.cost)}</span>
        </span>
        {leg.via ? (
          <span className="trips-ed-leg-via">
            via <span className="iata">{leg.via}</span>
          </span>
        ) : null}
        {leg.mode === "flight" && !leg.bookable ? <span className="trips-ed-leg-note">No airport at one end</span> : null}
      </div>
      <div className="trips-ed-leg-actions">
        {r ? (
          <button type="button" className="trips-leg-booked" onClick={() => setRecording(true)} aria-label={`Edit the booking for the ${what}`}>
            <Badge tone="success">
              <IconCheck size={12} /> Booked
              {r.carrier || r.number ? ` · ${[r.carrier, r.number].filter(Boolean).join(" ")}` : ""}
              {r.reference ? (
                <>
                  {" · "}
                  <span className="tabular">{r.reference}</span>
                </>
              ) : null}
            </Badge>
            <IconEdit size={14} />
          </button>
        ) : null}
        {testBooked ? (
          <a className="trips-ed-booking" href={hrefFor({ view: "plan", tab: "flights" })} title="A test booking: no ticket was issued. View it in Flights.">
            <Badge tone="warning">
              Test booking, not a ticket · <span className="tabular">{booking.bookingReference}</span>
            </Badge>
          </a>
        ) : null}
        {!r ? (
          <>
            <Button
              ref={anchor}
              size={size}
              icon={<IconExternal size={14} />}
              aria-haspopup="dialog"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
              aria-label={`Book the ${what} on another site`}
            >
              Book on…
            </Button>
            <Button size={size} variant="ghost" onClick={() => setRecording(true)} aria-label={`Record a booking for the ${what}`}>
              Record booking
            </Button>
          </>
        ) : null}
      </div>

      <Popover open={menu} onClose={() => setMenu(false)} anchorRef={anchor} placement="bottom-end" label={`Where to book the ${what}`}>
        <div className="trips-up-pop trips-leg-pop">
          <p className="trips-up-pop-title">Book for real on</p>
          {links.length ? (
            <ul className="trips-up-pop-list" role="list">
              {links.map((l) => (
                <li key={l.site}>
                  <a className="trips-up-pop-item trips-leg-pop-link" href={l.url} target="_blank" rel="noreferrer noopener" onClick={() => setMenu(false)}>
                    <span className="trips-up-pop-name">
                      {l.label}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </span>
                    <IconExternal size={14} />
                    <span className="trips-leg-pop-sub">Fills in {l.prefills}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="trips-leg-pop-note">Flight search needs an airport at both ends. Switch the mode, or pick a city with an airport.</p>
          )}
          <p className="trips-leg-pop-note">
            {date ? `Searches ${formatDay(date)}. ` : "No date yet, so the site will ask for one. "}
            You pay there, not here. Come back and record the booking.
          </p>
          {leg.bookable && !testBooked ? (
            <>
              <p className="trips-up-pop-title">Practice only</p>
              <button type="button" className="trips-up-pop-item" onClick={testBook}>
                <IconPlane size={16} />
                <span className="trips-up-pop-name">Make a test booking</span>
              </button>
              <p className="trips-leg-pop-note">Test mode: no ticket is issued and nothing is charged.</p>
            </>
          ) : null}
        </div>
      </Popover>

      {recording ? (
        <RecordBookingSheet
          leg={leg}
          onClose={() => setRecording(false)}
          onSave={(rec) => {
            savePlan({ booked: rec });
            setRecording(false);
            toast(rec ? "Booking recorded" : "Booking removed", { tone: rec ? "success" : undefined });
          }}
        />
      ) : null}
    </div>
  );
}

interface RecordDraft {
  carrier: string;
  number: string;
  reference: string;
  cost: MoneyDraftValue;
  departAt: string;
  arriveAt: string;
}

/** Write down a booking made somewhere else, so the trip shows the leg as booked. */
function RecordBookingSheet({
  leg,
  onClose,
  onSave,
}: {
  leg: TripLeg;
  onClose: () => void;
  onSave: (record: LegRecord | undefined) => void;
}) {
  const r = leg.record;
  const [d, setD] = useState<RecordDraft>(() => ({
    carrier: r?.carrier ?? "",
    number: r?.number ?? "",
    reference: r?.reference ?? "",
    cost: moneyDraft(r?.cost),
    departAt: r?.departAt ?? "",
    arriveAt: r?.arriveAt ?? "",
  }));
  const [error, setError] = useState("");
  const set = (p: Partial<RecordDraft>) => setD((x) => ({ ...x, ...p }));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => setError(""), [d]);

  const isFlight = leg.mode === "flight";
  const save = () => {
    const cost = moneyFromDraft(d.cost);
    if (cost === "invalid") return setError("Enter the price as a number, or leave it empty.");
    const rec = cleanLegRecord({ ...d, cost });
    if (!rec) return setError("Fill in at least one detail, such as the reference or the departure time.");
    onSave(rec);
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Record a booking"
      description={`${MODE_LABEL[leg.mode]} from ${leg.from.name} to ${leg.to.name}`}
      initialFocus={first}
      footer={
        <div className="trips-itin-foot">
          {r ? (
            <Button variant="danger-outline" onClick={() => onSave(undefined)}>
              Remove booking
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
      }
    >
      <p className="trips-itin-help">
        For a booking you made on an airline's or another site. Meridian only writes it down: nothing is bought or changed here.
      </p>
      <SectionHeader level={3} title="What you booked" />
      <div className="trips-itin-grid">
        <Field label={isFlight ? "Airline" : "Operator"} optional>
          <Input ref={first} value={d.carrier} maxLength={100} onChange={(e) => set({ carrier: e.target.value })} placeholder={isFlight ? "TAP Air Portugal" : "Renfe"} />
        </Field>
        <Field label={isFlight ? "Flight number" : "Service number"} optional>
          <Input value={d.number} maxLength={20} onChange={(e) => set({ number: e.target.value })} placeholder={isFlight ? "TP1023" : ""} />
        </Field>
        <Field label="Booking reference" optional hint="Kept in your trip. Never shown on a shared link or in the calendar feed.">
          <Input value={d.reference} maxLength={80} onChange={(e) => set({ reference: e.target.value })} autoCapitalize="characters" />
        </Field>
        <MoneyInput label="Price paid" value={d.cost} onChange={(cost) => set({ cost })} />
      </div>
      <SectionHeader level={3} title="Times" meta="local to each place" />
      <div className="trips-itin-grid">
        <Field label={`Departs ${leg.from.name}`} optional>
          <Input type="datetime-local" value={d.departAt} onChange={(e) => set({ departAt: e.target.value })} />
        </Field>
        <Field label={`Arrives ${leg.to.name}`} optional>
          <Input type="datetime-local" value={d.arriveAt} onChange={(e) => set({ arriveAt: e.target.value })} />
        </Field>
      </div>
      {error ? (
        <p className="ui-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
