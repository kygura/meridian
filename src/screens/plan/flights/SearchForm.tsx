import { cloneElement, isValidElement, useMemo, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { todayIsoDate } from "../../../lib/bookingApi";
import { useMeridianStore } from "../../../store";
import type { City } from "../../../types";
import { CitySearch, Field, IconButton, Input, Select, cx } from "../../../ui";
import { IconRefresh } from "../../../ui/icons";
import { searchIssues, type RouteEnd, type SearchDraft } from "./search";

const PAX_OPTIONS = Array.from({ length: 9 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} ${i === 0 ? "adult" : "adults"}` }));

interface PickedProps {
  end: RouteEnd;
  onChange: () => void;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** A chosen airport city; click to search again. */
function PickedCity({ end, onChange, ...aria }: PickedProps) {
  return (
    <button type="button" className="plan-flights-picked" onClick={onChange} {...aria}>
      <span className="plan-flights-picked-name">{end.name}</span>
      <span className="iata muted">{end.iata}</span>
      <span className="plan-flights-picked-change">Change</span>
    </button>
  );
}

/** Read-only route end when the booking comes from a trip leg. */
function FixedCity({ end, id }: { end: RouteEnd; id?: string }) {
  return (
    <div id={id} className="plan-flights-fixed">
      <span className="plan-flights-picked-name">{end.name}</span>
      <span className="iata muted">{end.iata}</span>
    </div>
  );
}

export interface SearchFormProps {
  draft: SearchDraft;
  onChange: (patch: Partial<SearchDraft>) => void;
  /** Lock these ends (booking from a trip leg). */
  lockOrigin?: boolean;
  lockDest?: boolean;
  /** Page layout puts the submit button in the form; sheet layout leaves it to the footer. */
  layout: "page" | "sheet";
  onSubmit: () => void;
  submit?: ReactNode;
  /** Show validation messages (after a submit attempt). */
  showErrors?: boolean;
  idPrefix: string;
}

export function SearchForm({ draft, onChange, lockOrigin, lockDest, layout, onSubmit, submit, showErrors, idPrefix }: SearchFormProps) {
  const cities = useMeridianStore((s) => s.cities);
  const airports = useMemo(() => cities.filter((c) => !!c.iata), [cities]);
  const [editing, setEditing] = useState<{ origin: boolean; dest: boolean }>({ origin: false, dest: false });
  const issues = showErrors ? searchIssues(draft) : {};
  const today = todayIsoDate();

  const toEnd = (c: City): RouteEnd => ({ iata: c.iata ?? "", name: c.name, cityId: c.id });

  const endField = (which: "origin" | "dest", label: string, placeholder: string) => {
    const end = draft[which];
    const locked = which === "origin" ? lockOrigin : lockDest;
    const id = `${idPrefix}-${which}`;
    let control;
    if (end && locked) control = <FixedCity end={end} />;
    else if (end && !editing[which])
      control = <PickedCity end={end} onChange={() => setEditing((e) => ({ ...e, [which]: true }))} />;
    else
      control = (
        <CitySearch
          cities={airports}
          placeholder={placeholder}
          autoFocus={editing[which]}
          excludeIds={[which === "origin" ? draft.dest?.cityId : draft.origin?.cityId].filter((x): x is string => !!x)}
          onPick={(c) => {
            onChange({ [which]: toEnd(c) } as Partial<SearchDraft>);
            setEditing((e) => ({ ...e, [which]: false }));
          }}
        />
      );
    return (
      <Field label={label} error={issues[which]} className={`plan-flights-f-${which}`}>
        {/* Field wires the id onto its single child. */}
        <SingleChild id={id}>{control}</SingleChild>
      </Field>
    );
  };

  const canSwap = !lockOrigin && !lockDest && (draft.origin || draft.dest);

  const handle = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <form className={cx("plan-flights-form", `plan-flights-form--${layout}`)} onSubmit={handle} noValidate>
      <div className="plan-flights-route">
        {endField("origin", "From", "City or airport")}
        {canSwap ? (
          <IconButton
            className="plan-flights-swap"
            label="Swap from and to"
            icon={<IconRefresh size={18} />}
            onClick={() => onChange({ origin: draft.dest, dest: draft.origin })}
          />
        ) : null}
        {endField("dest", "To", "City or airport")}
      </div>
      <div className="plan-flights-when">
        <Field label="Depart" error={issues.departureDate} className="plan-flights-f-date">
          <Input type="date" min={today} value={draft.departureDate} onChange={(e) => onChange({ departureDate: e.target.value })} />
        </Field>
        <Field label="Return" optional error={issues.returnDate} className="plan-flights-f-date">
          <Input
            type="date"
            min={draft.departureDate || today}
            value={draft.returnDate}
            onChange={(e) => onChange({ returnDate: e.target.value })}
          />
        </Field>
        <Field label="Passengers" className="plan-flights-f-pax">
          <Select options={PAX_OPTIONS} value={String(draft.passengers)} onChange={(e) => onChange({ passengers: Number(e.target.value) })} />
        </Field>
        {layout === "page" && submit ? <div className="plan-flights-submit">{submit}</div> : null}
      </div>
      {/* Enter in a field submits; the sheet's footer button calls onSubmit directly. */}
      {layout === "sheet" ? <button type="submit" hidden aria-hidden="true" tabIndex={-1} /> : null}
    </form>
  );
}

/** Passes Field's id/aria props down to whichever control is rendered. */
function SingleChild({ children, ...props }: { children: ReactNode; id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) {
  if (!isValidElement(children)) return <>{children}</>;
  return cloneElement(children as ReactElement<Record<string, unknown>>, props);
}
