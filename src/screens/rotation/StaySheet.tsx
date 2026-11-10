import { useMemo, useState } from "react";
import { Badge, Button, CitySearch, Disclosure, Field, Input, Segmented, Select, Sheet, Textarea, cx } from "../../ui";
import { IconExternal, IconTrash } from "../../ui/icons";
import { useMeridianStore } from "../../store";
import {
  FIT_LABEL,
  LEAD_TIME_METHOD,
  STAY_STATUSES,
  bookBy,
  formatShortDate,
  leadTimeFor,
  newStayId,
  placeFromCity,
  rentalLinks,
  type PlaceProfile,
  type RotationPlace,
  type RotationStay,
  type StayFit,
  type StayKind,
  type StayStatus,
} from "../../lib/rotation";
import { moneyDraft, moneyFromDraft, type MoneyDraftValue } from "../trips/upcoming/moneyInput";
import { KIND_LABEL, STATUS_LABEL, monthYear } from "./format";
import { MoneyField } from "./MoneyField";

interface Draft {
  place: RotationPlace | null;
  kind: StayKind;
  status: StayStatus;
  when: "dates" | "months";
  start: string;
  end: string;
  from: string;
  to: string;
  minNights: string;
  maxNights: string;
  budget: MoneyDraftValue;
  rent: MoneyDraftValue;
  lodgingName: string;
  lodgingAddress: string;
  lodgingLink: string;
  bookingRef: string;
  leadMin: string;
  leadMax: string;
  locked: boolean;
  notes: string;
}

function toDraft(s: RotationStay | null): Draft {
  return {
    place: s?.place ?? null,
    kind: s?.kind ?? "base",
    status: s?.status === "current" || s?.status === "done" ? s.status : (s?.status ?? "idea"),
    when: s && !s.start && s.window ? "months" : "dates",
    start: s?.start ?? "",
    end: s?.end ?? "",
    from: s?.window?.from ?? "",
    to: s?.window?.to ?? "",
    minNights: s?.minNights ? String(s.minNights) : "",
    maxNights: s?.maxNights ? String(s.maxNights) : "",
    budget: moneyDraft(s?.budgetMonthly),
    rent: moneyDraft(s?.rentMonthly),
    lodgingName: s?.lodging?.name ?? "",
    lodgingAddress: s?.lodging?.address ?? "",
    lodgingLink: s?.lodging?.link ?? "",
    bookingRef: s?.lodging?.bookingRef ?? "",
    leadMin: s?.leadTime ? String(s.leadTime.min) : "",
    leadMax: s?.leadTime ? String(s.leadTime.max) : "",
    locked: !!s?.locked,
    notes: s?.notes ?? "",
  };
}

const int = (v: string) => (v.trim() && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

/** The stay a draft describes, or the first problem with it. */
export function fromDraft(d: Draft, base: RotationStay | null): RotationStay | string {
  if (!d.place) return "Pick a city.";
  const stay: RotationStay = {
    ...(base ?? { origin: { kind: "manual" as const } }),
    id: base?.id ?? newStayId(),
    place: d.place,
    kind: d.kind,
    status: d.status,
    start: undefined,
    end: undefined,
    window: undefined,
    minNights: int(d.minNights),
    maxNights: int(d.maxNights),
    notes: d.notes.trim() || undefined,
    locked: d.locked || undefined,
  };
  if (d.when === "dates") {
    if (d.start || d.end) {
      if (!d.start || !d.end) return "Give both a move-in and a move-out day, or neither.";
      if (d.end <= d.start) return "Move-out must be after move-in.";
      stay.start = d.start;
      stay.end = d.end;
    }
  } else if (d.from || d.to) {
    if (!d.from || !d.to) return "Give both the first and the last month.";
    if (d.to < d.from) return "The last month is before the first.";
    stay.window = { from: d.from, to: d.to };
  }
  if (stay.minNights && stay.maxNights && stay.minNights > stay.maxNights) return "The minimum is longer than the maximum.";
  const budget = moneyFromDraft(d.budget);
  const rent = moneyFromDraft(d.rent);
  if (budget === "invalid" || rent === "invalid") return "Amounts must be numbers.";
  stay.budgetMonthly = budget;
  stay.rentMonthly = rent;
  const link = d.lodgingLink.trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) return "The lodging link must start with http:// or https://.";
  if (d.lodgingName.trim()) {
    stay.lodging = {
      ...base?.lodging,
      name: d.lodgingName.trim(),
      address: d.lodgingAddress.trim() || undefined,
      link: link || undefined,
      bookingRef: d.bookingRef.trim() || undefined,
    };
  } else if (d.lodgingAddress.trim() || link || d.bookingRef.trim()) {
    return "Give the lodging a name to keep its other details.";
  } else stay.lodging = undefined;
  const lmin = int(d.leadMin);
  const lmax = int(d.leadMax);
  if (lmin !== undefined || lmax !== undefined) {
    const min = lmin ?? lmax!;
    const max = lmax ?? lmin!;
    if (min > max) return "The shorter lead time is longer than the longer one.";
    stay.leadTime = { min, max };
  } else stay.leadTime = undefined;
  return stay;
}

export interface StaySheetProps {
  open: boolean;
  stay: RotationStay | null;
  /** A new stay prefilled from a template (a past journey's stop). */
  template?: RotationStay | null;
  profile?: PlaceProfile;
  fit?: StayFit;
  onClose: () => void;
  onSave: (stay: RotationStay) => Promise<boolean>;
  onDelete?: (id: string) => void;
  onEditPlace?: (place: RotationPlace) => void;
}

export function StaySheet({ open, stay, template, profile, fit, onClose, onSave, onDelete, onEditPlace }: StaySheetProps) {
  const cities = useMeridianStore((s) => s.cities);
  const [d, setD] = useState<Draft>(() => toDraft(stay ?? template ?? null));
  const base = stay ?? template ?? null;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const preview = useMemo(() => {
    const r = fromDraft(d, base);
    return typeof r === "string" ? null : r;
  }, [d, base]);
  const by = preview ? bookBy(preview, profile) : null;
  const lead = preview ? leadTimeFor(preview, profile) : null;
  const links = preview && (preview.start || preview.window) ? rentalLinks(preview) : [];

  const save = async () => {
    const r = fromDraft(d, base);
    if (typeof r === "string") return setError(r);
    setError(null);
    setSaving(true);
    const ok = await onSave(r);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={stay ? stay.place.name : "Add a stay"}
      description={stay ? `${KIND_LABEL[stay.kind]} · ${STATUS_LABEL[stay.status]}` : "A base for weeks or months, or a few days passing through."}
      size="md"
      footer={
        <div className="rotation-sheet-footer">
          {stay && onDelete ? (
            <Button variant="danger-outline" icon={<IconTrash size={16} />} onClick={() => onDelete(stay.id)}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="rotation-sheet-footer-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving}>
              Save stay
            </Button>
          </div>
        </div>
      }
    >
      <div className="rotation-form">
        {!stay && (
          <Field label="City">
            <CitySearch
              cities={cities}
              onPick={(c) => set("place", placeFromCity(c))}
              clearOnPick={false}
              defaultValue={d.place?.name}
              placeholder="Search a city"
              autoFocus
            />
          </Field>
        )}
        <div className="rotation-form-row">
          <Field label="Type">
            <Segmented<StayKind>
              label="Type"
              value={d.kind}
              onChange={(v) => set("kind", v)}
              options={[
                { value: "base", label: "Base" },
                { value: "pass-through", label: "Pass-through" },
              ]}
            />
          </Field>
          <Field label="Status">
            <Select value={d.status} onChange={(e) => set("status", e.target.value as StayStatus)} options={STAY_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
          </Field>
        </div>

        <Field label="When" hint={d.when === "months" ? "Months it should fall in, before you fix the dates." : "Move-in and move-out days. A move-out day can be the next stay's move-in day."}>
          <Segmented<"dates" | "months">
            label="When"
            value={d.when}
            onChange={(v) => set("when", v)}
            options={[
              { value: "dates", label: "Dates" },
              { value: "months", label: "Months only" },
            ]}
          />
        </Field>
        {d.when === "dates" ? (
          <div className="rotation-form-row">
            <Field label="Move in" optional>
              <Input type="date" value={d.start} onChange={(e) => set("start", e.target.value)} />
            </Field>
            <Field label="Move out" optional>
              <Input type="date" value={d.end} min={d.start || undefined} onChange={(e) => set("end", e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="rotation-form-row">
            <Field label="First month" optional>
              <Input type="month" value={d.from} onChange={(e) => set("from", e.target.value)} />
            </Field>
            <Field label="Last month" optional>
              <Input type="month" value={d.to} min={d.from || undefined} onChange={(e) => set("to", e.target.value)} />
            </Field>
          </div>
        )}
        <div className="rotation-form-row">
          <Field label="Shortest stay (nights)" optional>
            <Input inputMode="numeric" value={d.minNights} onChange={(e) => set("minNights", e.target.value)} />
          </Field>
          <Field label="Longest stay (nights)" optional>
            <Input inputMode="numeric" value={d.maxNights} onChange={(e) => set("maxNights", e.target.value)} />
          </Field>
        </div>

        <div className="rotation-form-row">
          <MoneyField label="Monthly budget" value={d.budget} onChange={(v) => set("budget", v)} />
          <MoneyField label="Actual rent, monthly" value={d.rent} onChange={(v) => set("rent", v)} />
        </div>

        <label className="rotation-check">
          <input type="checkbox" checked={d.locked} onChange={(e) => set("locked", e.target.checked)} />
          <span>
            Locked
            <span className="rotation-muted"> — keep this stay where it is when the rotation is re-planned.</span>
          </span>
        </label>

        <Disclosure summary="Where you're staying" defaultOpen={!!stay?.lodging}>
          <div className="rotation-form">
            <Field label="Name" optional>
              <Input value={d.lodgingName} onChange={(e) => set("lodgingName", e.target.value)} placeholder="Flat in Graça" />
            </Field>
            <Field label="Address" optional>
              <Input value={d.lodgingAddress} onChange={(e) => set("lodgingAddress", e.target.value)} />
            </Field>
            <div className="rotation-form-row">
              <Field label="Link" optional>
                <Input value={d.lodgingLink} onChange={(e) => set("lodgingLink", e.target.value)} placeholder="https://" />
              </Field>
              <Field label="Booking reference" optional>
                <Input value={d.bookingRef} onChange={(e) => set("bookingRef", e.target.value)} />
              </Field>
            </div>
          </div>
        </Disclosure>

        <Field label="Notes" optional>
          <Textarea value={d.notes} onChange={(e) => set("notes", e.target.value)} rows={3} />
        </Field>

        <section className="rotation-sheet-section" aria-labelledby="rot-book">
          <h3 id="rot-book" className="ui-section-title">
            Booking
          </h3>
          {by && lead ? (
            <p className="rotation-p">
              Book by <strong className="num">{formatShortDate(by)}</strong>: {lead.lead.min === lead.lead.max ? lead.lead.max : `${lead.lead.min}–${lead.lead.max}`} weeks ahead
              {lead.basis === "default" ? " (the default for this type and length)" : lead.basis === "place" ? ` (your lead time for ${profile?.name})` : " (this stay's own lead time)"}.
            </p>
          ) : (
            <p className="rotation-p rotation-muted">Give dates or months to get a book-by date.</p>
          )}
          <div className="rotation-form-row">
            <Field label="Lead time, weeks (from)" optional hint="Overrides the place and the default.">
              <Input inputMode="numeric" value={d.leadMin} onChange={(e) => set("leadMin", e.target.value)} />
            </Field>
            <Field label="Lead time, weeks (to)" optional>
              <Input inputMode="numeric" value={d.leadMax} onChange={(e) => set("leadMax", e.target.value)} />
            </Field>
          </div>
          <p className="rotation-fine">{LEAD_TIME_METHOD}</p>
          {links.length > 0 && (
            <ul className="rotation-links">
              {links.map((l) => (
                <li key={l.site}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer">
                    {l.label} <IconExternal size={14} />
                  </a>
                  <span className="rotation-fine"> {l.prefills}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {stay && fit && (
          <section className="rotation-sheet-section" aria-labelledby="rot-fit">
            <h3 id="rot-fit" className="ui-section-title">
              Fit
            </h3>
            <p className="rotation-p">
              <Badge tone={fit.level === "avoid" || fit.level === "poor" ? "danger" : fit.level === "great" || fit.level === "good" ? "success" : "neutral"}>{FIT_LABEL[fit.level]}</Badge>{" "}
              {fit.source === "personal" ? "From your own windows for this place, then the Comfort Index." : fit.source === "comfort" ? "From the Comfort Index; you have no windows for these months." : ""}
            </p>
            <ul className="rotation-fit-months">
              {fit.months.map((m) => (
                <li key={m.month}>
                  <span className={cx("rotation-swatch", `rotation-fit--${m.level}`)} aria-hidden="true" />
                  <span className="num">{monthYear(m.month)}</span>
                  <span className="rotation-muted"> · {m.nights} nights · {m.why}</span>
                </li>
              ))}
            </ul>
            {onEditPlace && (
              <Button size="sm" variant="ghost" onClick={() => onEditPlace(stay.place)}>
                Edit your windows for {stay.place.name}
              </Button>
            )}
          </section>
        )}

        {error && (
          <p className="rotation-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
