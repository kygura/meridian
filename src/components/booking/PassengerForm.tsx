import { useEffect, useRef } from "react";
import {
  formatDurationMinutes,
  formatStops,
  todayIsoDate,
  type Offer,
  type PassengerDraft,
  type PassengerErrors,
} from "../../lib/bookingApi";
import ProvenanceBadge from "./ProvenanceBadge";
import OfferExpiryCountdown from "./OfferExpiryCountdown";

const TITLES = ["MR", "MRS", "MS", "MISS", "DR"];

/** PASSENGER step (DESIGN-booking.md §3.4) — the 7 Duffel fields + inline
 *  validation, with the selected-offer summary strip + live countdown pinned
 *  on top so the user always sees the clock while typing. */
export default function PassengerForm({
  offer,
  draft,
  errors,
  passengerCount,
  onChange,
  onOfferExpire,
}: {
  offer: Offer;
  draft: PassengerDraft;
  errors: PassengerErrors;
  passengerCount: number;
  onChange: (patch: Partial<PassengerDraft>) => void;
  onOfferExpire: () => void;
}) {
  const titleRef = useRef<HTMLSelectElement>(null);
  const firstErrorRef = useRef<string | null>(null);

  // §10: PASSENGER step focuses TITLE on entry.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // §4.3: focus the first invalid field when errors land.
  useEffect(() => {
    const order: (keyof PassengerDraft)[] = [
      "title",
      "givenName",
      "familyName",
      "bornOn",
      "gender",
      "email",
      "phoneNumber",
    ];
    const first = order.find((k) => errors[k]);
    if (first && first !== firstErrorRef.current) {
      firstErrorRef.current = first;
      document
        .querySelector<HTMLElement>(`[data-bk-field="${first}"]`)
        ?.focus();
    }
    if (!first) firstErrorRef.current = null;
  }, [errors]);

  return (
    <div className="bk-passenger">
      <div className="bk-selected-strip">
        <span className="bk-selected-summary">
          SELECTED · {offer.carrierIata ?? offer.carrier.slice(0, 2).toUpperCase()} $
          {offer.priceAmount.toLocaleString()}
          {offer.durationMinutes != null
            ? ` · ${formatDurationMinutes(offer.durationMinutes)}`
            : ""}
          {` · ${formatStops(offer.stops)} · `}
          <ProvenanceBadge source={offer.source} />
        </span>
        <OfferExpiryCountdown
          expiresAt={offer.expiresAt}
          onExpire={onOfferExpire}
          prefix="EXPIRES"
        />
      </div>

      {passengerCount > 1 && (
        <div className="bk-multi-note">
          BOOKING 1 OF {passengerCount} · ADDITIONAL PASSENGERS NOT COLLECTED IN
          V1
        </div>
      )}

      <div className="bk-field-label bk-passenger-heading">PASSENGER 1</div>

      <div className="bk-form-grid">
        <div className="bk-field bk-field-title">
          <label className="bk-field-label" htmlFor="bk-title">
            TITLE *
          </label>
          <select
            id="bk-title"
            ref={titleRef}
            data-bk-field="title"
            className="bk-input bk-select"
            value={draft.title}
            onChange={(e) => onChange({ title: e.target.value })}
          >
            {TITLES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <FieldError message={errors.title} />
        </div>

        <div className="bk-field">
          <label className="bk-field-label" htmlFor="bk-given">
            GIVEN NAME *
          </label>
          <input
            id="bk-given"
            data-bk-field="givenName"
            className="bk-input bk-input-sans"
            type="text"
            autoComplete="given-name"
            value={draft.givenName}
            onChange={(e) => onChange({ givenName: e.target.value })}
          />
          <FieldError message={errors.givenName} />
        </div>

        <div className="bk-field">
          <label className="bk-field-label" htmlFor="bk-family">
            FAMILY NAME *
          </label>
          <input
            id="bk-family"
            data-bk-field="familyName"
            className="bk-input bk-input-sans"
            type="text"
            autoComplete="family-name"
            value={draft.familyName}
            onChange={(e) => onChange({ familyName: e.target.value })}
          />
          <FieldError message={errors.familyName} />
        </div>

        <div className="bk-field">
          <label className="bk-field-label" htmlFor="bk-born">
            BORN ON *
          </label>
          <input
            id="bk-born"
            data-bk-field="bornOn"
            className="bk-input"
            type="date"
            max={todayIsoDate()}
            value={draft.bornOn}
            onChange={(e) => onChange({ bornOn: e.target.value })}
          />
          <FieldError message={errors.bornOn} />
        </div>

        <div className="bk-field">
          <span className="bk-field-label">GENDER *</span>
          <div className="bk-radio-row" role="radiogroup" aria-label="Gender">
            <label className="bk-radio">
              <input
                type="radio"
                name="bk-gender"
                data-bk-field="gender"
                checked={draft.gender === "female"}
                onChange={() => onChange({ gender: "female" })}
              />
              FEMALE
            </label>
            <label className="bk-radio">
              <input
                type="radio"
                name="bk-gender"
                checked={draft.gender === "male"}
                onChange={() => onChange({ gender: "male" })}
              />
              MALE
            </label>
          </div>
          <FieldError message={errors.gender} />
        </div>

        <div className="bk-field">
          <label className="bk-field-label" htmlFor="bk-email">
            EMAIL *
          </label>
          <input
            id="bk-email"
            data-bk-field="email"
            className="bk-input bk-input-sans"
            type="email"
            autoComplete="email"
            value={draft.email}
            onChange={(e) => onChange({ email: e.target.value })}
          />
          <FieldError message={errors.email} />
        </div>

        <div className="bk-field">
          <label className="bk-field-label" htmlFor="bk-phone">
            PHONE *
          </label>
          <input
            id="bk-phone"
            data-bk-field="phoneNumber"
            className="bk-input bk-input-sans"
            type="tel"
            autoComplete="tel"
            value={draft.phoneNumber}
            onChange={(e) => onChange({ phoneNumber: e.target.value })}
          />
          {!errors.phoneNumber && (
            <span className="bk-field-hint">INCLUDE COUNTRY CODE</span>
          )}
          <FieldError message={errors.phoneNumber} />
        </div>
      </div>
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <span className="bk-field-error">{message}</span>;
}
