import { useEffect, useRef } from "react";
import { todayIsoDate, type Offer, type PassengerDraft, type PassengerErrors } from "../../../lib/bookingApi";
import { Card, Field, Input, Select, cx } from "../../../ui";
import { Countdown } from "./Countdown";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { PASSENGER_TITLES, durationText, passengerErrorText, priceText, stopsText } from "./flightText";

const ORDER: (keyof PassengerDraft)[] = ["title", "givenName", "familyName", "bornOn", "gender", "email", "phoneNumber"];

/** Compact summary of the chosen offer with its live countdown. */
export function SelectedOffer({ offer, onExpire, route }: { offer: Offer; onExpire?: () => void; route?: string }) {
  return (
    <Card padding="sm" className="plan-flights-selected">
      <div className="plan-flights-selected-main">
        <div className="plan-flights-selected-line1">
          <span className="plan-flights-price num">{priceText(offer.priceAmount, offer.currency)}</span>
          <ProvenanceBadge source={offer.source} />
        </div>
        <p className="plan-flights-selected-line2 muted">
          {[route, offer.carrier, stopsText(offer.stops), offer.durationMinutes != null ? durationText(offer.durationMinutes) : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <Countdown expiresAt={offer.expiresAt} onExpire={onExpire} />
    </Card>
  );
}

export interface PassengerFormProps {
  offer: Offer;
  route: string;
  draft: PassengerDraft;
  errors: PassengerErrors;
  passengerCount: number;
  onChange: (patch: Partial<PassengerDraft>) => void;
  onOfferExpire: () => void;
  idPrefix: string;
}

export function PassengerForm({ offer, route, draft, errors, passengerCount, onChange, onOfferExpire, idPrefix }: PassengerFormProps) {
  const root = useRef<HTMLDivElement>(null);
  const err = (k: keyof PassengerDraft) => passengerErrorText(k, errors[k]);

  // Focus the first invalid field whenever a review attempt fails.
  useEffect(() => {
    const first = ORDER.find((k) => errors[k]);
    if (first) root.current?.querySelector<HTMLElement>(`[data-pf="${first}"]`)?.focus();
  }, [errors]);

  return (
    <div ref={root} className="plan-flights-pax">
      <SelectedOffer offer={offer} onExpire={onOfferExpire} route={route} />
      <div>
        <h3 className="plan-flights-h3">Lead passenger</h3>
        <p className="plan-flights-sub muted">
          {passengerCount > 1
            ? `You're booking for ${passengerCount} adults. Only the lead passenger's details are needed here.`
            : "Enter the details exactly as they appear on the passport."}
        </p>
      </div>
      <div className="plan-flights-pax-grid">
        <Field label="Title" error={err("title")} className="plan-flights-f-title">
          <Select data-pf="title" data-autofocus options={PASSENGER_TITLES} value={draft.title} onChange={(e) => onChange({ title: e.target.value })} />
        </Field>
        <Field label="Given name" error={err("givenName")}>
          <Input data-pf="givenName" autoComplete="given-name" value={draft.givenName} onChange={(e) => onChange({ givenName: e.target.value })} />
        </Field>
        <Field label="Family name" error={err("familyName")}>
          <Input data-pf="familyName" autoComplete="family-name" value={draft.familyName} onChange={(e) => onChange({ familyName: e.target.value })} />
        </Field>
        <Field label="Date of birth" error={err("bornOn")}>
          <Input data-pf="bornOn" type="date" max={todayIsoDate()} autoComplete="bday" value={draft.bornOn} onChange={(e) => onChange({ bornOn: e.target.value })} />
        </Field>
        <fieldset className={cx("plan-flights-radios", errors.gender && "is-invalid")} aria-describedby={errors.gender ? `${idPrefix}-gender-err` : undefined}>
          <legend className="ui-field-label">Gender</legend>
          <div className="plan-flights-radio-row">
            {(["female", "male"] as const).map((g, i) => (
              <label key={g} className={cx("plan-flights-radio", draft.gender === g && "is-checked")}>
                <input
                  type="radio"
                  name={`${idPrefix}-gender`}
                  data-pf={i === 0 ? "gender" : undefined}
                  checked={draft.gender === g}
                  onChange={() => onChange({ gender: g })}
                />
                {g === "female" ? "Female" : "Male"}
              </label>
            ))}
          </div>
          {errors.gender ? (
            <p id={`${idPrefix}-gender-err`} className="ui-field-error" role="alert">
              {err("gender")}
            </p>
          ) : null}
        </fieldset>
        <Field label="Email" error={err("email")}>
          <Input data-pf="email" type="email" autoComplete="email" inputMode="email" value={draft.email} onChange={(e) => onChange({ email: e.target.value })} />
        </Field>
        <Field label="Phone" hint={errors.phoneNumber ? undefined : "Include the country code, for example +44 20 7946 0000"} error={err("phoneNumber")}>
          <Input data-pf="phoneNumber" type="tel" autoComplete="tel" inputMode="tel" value={draft.phoneNumber} onChange={(e) => onChange({ phoneNumber: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}
