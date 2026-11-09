import { useEffect, useMemo, useState } from "react";
import { useMapPrefs } from "../../../shell/mapPrefs";
import { useMeridianStore } from "../../../store";
import { navigate } from "../../../lib/router";
import { JournalApiError, JournalLockedError, getJourney, saveJourney } from "../../../lib/journalApi";
import { cityIndex, journalTags } from "../../../lib/journal";
import {
  emptyForm,
  emptyMoney,
  fromJourney,
  isDirty,
  newExperience,
  newExtraSegment,
  newStop,
  syncSegments,
  toJourneyInput,
  validateLog,
  type ExperienceDraft,
  type LogErrors,
  type LogForm,
  type SegmentDraft,
  type StopDraft,
} from "../../../lib/journalForm";
import type { City, ExperienceKind, Lodging, SegmentMode } from "../../../types";
import {
  Button,
  Chip,
  Dialog,
  Disclosure,
  ErrorState,
  Field,
  IconButton,
  Input,
  Select,
  Sheet,
  Skeleton,
  Textarea,
  UnlockCard,
  toast,
  useJournalToken,
  SectionHeader,
} from "../../../ui";
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash } from "../../../ui/icons";
import { CityPicker, FieldError, Group, MoneyField } from "./FormParts";
import { RatingInput } from "./Rating";
import { EXPERIENCE_KIND, LODGING_KIND } from "./Conditions";
import { crowdWord, dayYear } from "./format";
import "./past.css";

const MODES: { value: SegmentMode; label: string }[] = [
  { value: "flight", label: "Flight" },
  { value: "train", label: "Train" },
  { value: "bus", label: "Bus" },
  { value: "car", label: "Car" },
  { value: "ferry", label: "Ferry" },
  { value: "other", label: "Other" },
];
const CROWD_STEPS = [15, 40, 65, 90];

const fieldId = (key: string) => `ql-${key}`;
/** Error keys whose field lives under "More details". */
const inDetails = (key: string) => /^(money-|seg-|exp-)/.test(key) || /^stop-.*-stay$/.test(key);

function focusField(key: string) {
  const el = document.getElementById(fieldId(key));
  const target = el && (el.matches("input,select,button,textarea") ? el : el.querySelector<HTMLElement>("input,select,button,textarea"));
  (target as HTMLElement | null)?.focus();
}

/**
 * Global quick-log sheet. Opens from anywhere with
 * useMeridianStore.getState().openQuickLog({ journeyId?, prefillStops? }); edit mode when journeyId is set.
 */
export default function QuickLogSheet() {
  const quickLog = useMeridianStore((s) => s.quickLog);
  if (!quickLog.open) return null;
  return <QuickLog journeyId={quickLog.journeyId} prefillStops={quickLog.prefillStops} />;
}

function QuickLog({ journeyId, prefillStops }: { journeyId?: string; prefillStops?: string[] }) {
  const { token, unlocked } = useJournalToken();
  const cities = useMeridianStore((s) => s.cities);
  const journeys = useMeridianStore((s) => s.journeys);
  const closeQuickLog = useMeridianStore((s) => s.closeQuickLog);
  const upsertJourney = useMeridianStore((s) => s.upsertJourney);
  const cityIdx = useMemo(() => cityIndex(cities), [cities]);
  const tagSuggestions = useMemo(() => journalTags(journeys ?? []), [journeys]);
  const edit = !!journeyId;

  const [initial, setInitial] = useState<LogForm | null>(() => {
    if (!journeyId) {
      const f = emptyForm(prefillStops);
      return { ...f, segments: syncSegments(f.stops, []) };
    }
    const j = journeys?.find((x) => x.id === journeyId);
    return j ? fromJourney(j) : null;
  });
  const [form, setForm] = useState<LogForm | null>(initial);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadTick, setLoadTick] = useState(0);
  const [errors, setErrors] = useState<LogErrors>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [guard, setGuard] = useState(false);

  // Editing a journey that is not in the store yet (deep link): fetch it.
  useEffect(() => {
    if (initial || !journeyId || !unlocked) return;
    let live = true;
    setLoadFailed(false);
    getJourney(journeyId)
      .then((j) => {
        if (!live) return;
        if (!j) return setLoadFailed(true);
        const f = fromJourney(j);
        setInitial(f);
        setForm(f);
      })
      .catch((e) => live && !(e instanceof JournalLockedError) && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [initial, journeyId, unlocked, token, loadTick]);

  const dirty = !!form && !!initial && isDirty(form, initial);
  const attemptClose = () => {
    if (dirty && !saving) setGuard(true);
    else if (!saving) closeQuickLog();
  };

  // ── Form updates ───────────────────────────────────────────────────
  const patch = (p: Partial<LogForm>) => setForm((f) => (f ? { ...f, ...p } : f));
  const setStops = (fn: (stops: StopDraft[]) => StopDraft[]) =>
    setForm((f) => {
      if (!f) return f;
      const stops = fn(f.stops);
      const chain = (ss: StopDraft[]) => ss.map((s) => s.cityId).join(">");
      const create = !f.base || chain(stops) !== chain(f.stops);
      return { ...f, stops, segments: syncSegments(stops, f.segments, create) };
    });
  const patchStop = (key: string, p: Partial<StopDraft>) => setStops((ss) => ss.map((s) => (s.key === key ? { ...s, ...p } : s)));
  const moveStop = (i: number, dir: -1 | 1) =>
    setStops((ss) => {
      const next = [...ss];
      [next[i], next[i + dir]] = [next[i + dir], next[i]];
      return next;
    });
  const patchSeg = (key: string, p: Partial<SegmentDraft>) =>
    setForm((f) => (f ? { ...f, segments: f.segments.map((s) => (s.key === key ? { ...s, ...p } : s)) } : f));
  const patchExp = (key: string, p: Partial<ExperienceDraft>) =>
    setForm((f) => (f ? { ...f, experiences: f.experiences.map((x) => (x.key === key ? { ...x, ...p } : x)) } : f));

  // ── Save ───────────────────────────────────────────────────────────
  const showError = (key: string) => {
    const details = document.querySelector<HTMLDetailsElement>("details.trips-ql-more");
    if (inDetails(key) && details && !details.open) {
      details.open = true;
      window.setTimeout(() => focusField(key), 30);
    } else focusField(key);
  };

  const reloadLatest = async () => {
    if (!journeyId) return;
    try {
      const j = await getJourney(journeyId);
      if (!j) return;
      upsertJourney(j);
      const f = fromJourney(j);
      setInitial(f);
      setForm(f);
      setErrors({});
    } catch {
      /* the toast already told the user */
    }
  };

  const save = async () => {
    if (!form || saving) return;
    const errs = validateLog(form);
    setErrors(errs);
    setGeneral(null);
    const firstKey = Object.keys(errs)[0];
    if (firstKey) {
      showError(firstKey);
      return;
    }
    setSaving(true);
    try {
      const input = toJourneyInput(form, (id) => cityIdx.get(id)?.name ?? id);
      const saved = await saveJourney(input, journeyId, form.base?.updatedAt);
      upsertJourney(saved);
      closeQuickLog();
      const detail = () => navigate({ view: "trips", tab: "past", journeyId: saved.id });
      if (prefillStops?.length) {
        // Logged from the map: stay there, with past trips visible.
        useMapPrefs.getState().setLayer("past", true);
        toast("Trip saved", { tone: "success", action: { label: "View", onClick: detail } });
      } else {
        toast(edit ? "Changes saved" : "Trip saved", { tone: "success" });
        detail();
      }
    } catch (err) {
      setSaving(false);
      if (err instanceof JournalApiError && err.fxUnavailable) {
        const hit = findMoneyKey(form, err.currency);
        const on = err.date ? ` on ${dayYear(err.date)}` : "";
        const msg = `No exchange rate for ${err.currency ?? "that currency"}${on}. Try again later, or enter the amount in EUR.`;
        if (hit) {
          setErrors({ [hit]: msg });
          showError(hit);
        } else setGeneral(msg);
      } else if (err instanceof JournalApiError && err.status === 409) {
        toast("This trip was changed somewhere else. The latest version is loaded — make your edits again.", { tone: "warning", duration: 8000 });
        void reloadLatest();
      } else if (err instanceof JournalApiError && err.status === 400) {
        setGeneral("Couldn't save. Some details weren't accepted — check the dates and amounts.");
      } else if (err instanceof JournalLockedError) {
        setGeneral("Your journal is locked. Unlock it in settings, then save again.");
      } else {
        setGeneral("Couldn't save. Check your connection and try again.");
      }
    }
  };

  const title = edit ? "Edit trip" : "Log a trip";

  if (!unlocked) {
    return (
      <Sheet open onClose={closeQuickLog} title={title} desktop="center">
        <UnlockCard compact title="Unlock your journal to log trips" />
      </Sheet>
    );
  }

  const detailKeys = Object.keys(errors).filter(inDetails);
  const usedStops = form ? form.stops.filter((s) => s.cityId) : [];

  return (
    <>
      <Sheet
        open
        onClose={attemptClose}
        title={title}
        description={edit && form?.base ? form.base.title : undefined}
        desktop="center"
        size="md"
        footer={
          <div className="trips-ql-footer">
            <Button variant="ghost" onClick={attemptClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} disabled={!form} onClick={() => void save()}>
              {edit ? "Save changes" : "Save trip"}
            </Button>
          </div>
        }
      >
        {!form ? (
          loadFailed ? (
            <ErrorState message="Couldn't load this trip." onRetry={() => setLoadTick((t) => t + 1)} />
          ) : (
            <div role="status" aria-busy="true" aria-label="Loading trip" className="trips-ql">
              <Skeleton height={36} />
              <Skeleton lines={3} height={36} />
            </div>
          )
        ) : (
          <form
            className="trips-ql"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label="Title" optional hint="Leave it blank to name the trip after its cities.">
              <Input
                id="ql-title"
                data-autofocus={prefillStops?.length ? undefined : true}
                placeholder="Lisbon and Porto, slow week"
                value={form.title}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </Field>

            <fieldset className="trips-ql-fieldset">
              <legend className="trips-ql-label">Stops</legend>
              <ol className="trips-ql-stops">
                {form.stops.map((s, i) => (
                  <StopRow
                    key={s.key}
                    stop={s}
                    index={i}
                    count={form.stops.length}
                    errors={errors}
                    cityIdx={cityIdx}
                    autoFocusDate={!!prefillStops?.length && i === 0}
                    onChange={(p) => patchStop(s.key, p)}
                    onMove={(dir) => moveStop(i, dir)}
                    onRemove={() => setStops((ss) => ss.filter((x) => x.key !== s.key))}
                  />
                ))}
              </ol>
              <FieldError>{errors.stops}</FieldError>
              <div>
                <Button
                  id="ql-stops"
                  size="sm"
                  icon={<IconPlus size={16} />}
                  onClick={() => setStops((ss) => [...ss, newStop("", ss[ss.length - 1]?.depart ?? "")])}
                >
                  Add stop
                </Button>
              </div>
            </fieldset>

            <Group label="How was it?" optional>
              <RatingInput value={form.rating} onChange={(rating) => patch({ rating })} label="Trip rating" />
            </Group>

            <Field label="Note" optional>
              <Textarea id="ql-notes" rows={3} value={form.notes} onChange={(e) => patch({ notes: e.target.value })} />
            </Field>

            <Disclosure
              summary={detailKeys.length ? `More details (${detailKeys.length} to fix)` : "More details"}
              className="trips-ql-more"
            >
              <p className="trips-ql-hint">Where you stayed, travel between stops, things you did, tags and costs.</p>

              <section className="trips-ql-section" aria-labelledby="ql-sec-about">
                <SectionHeader level={3} id="ql-sec-about" title="About the trip" />
                <div className="trips-ql-grid">
                  <Field label="Travellers">
                    <Select
                      id="ql-travellers"
                      value={String(form.travellers ?? 1)}
                      onChange={(e) => patch({ travellers: Number(e.target.value) })}
                      options={Array.from({ length: 9 }, (_, i) => ({ value: String(i + 1), label: i === 0 ? "Just me" : `${i + 1} people` }))}
                    />
                  </Field>
                  <TagsField tags={form.tags} suggestions={tagSuggestions} onChange={(tags) => patch({ tags })} />
                </div>
              </section>

              {usedStops.length > 0 ? (
                <section className="trips-ql-section" aria-labelledby="ql-sec-stays">
                  <SectionHeader level={3} id="ql-sec-stays" title="Stays" />
                  {usedStops.map((s) => (
                    <StayEditor key={s.key} stop={s} city={cityIdx.get(s.cityId)} errors={errors} onChange={(p) => patchStop(s.key, p)} />
                  ))}
                </section>
              ) : null}

              <section className="trips-ql-section" aria-labelledby="ql-sec-segs">
                <SectionHeader level={3} id="ql-sec-segs" title="Travel between stops" />
                {form.segments.length === 0 ? (
                  <p className="trips-ql-hint">Pick two or more cities and the legs between them appear here.</p>
                ) : null}
                {form.segments.map((g) => (
                  <SegmentEditor
                    key={g.key}
                    seg={g}
                    errors={errors}
                    cityIdx={cityIdx}
                    onChange={(p) => patchSeg(g.key, p)}
                    onRemove={g.extra || form.base ? () => patch({ segments: form.segments.filter((x) => x.key !== g.key) }) : undefined}
                  />
                ))}
                <div>
                  <Button size="sm" variant="ghost" icon={<IconPlus size={16} />} onClick={() => patch({ segments: [...form.segments, newExtraSegment()] })}>
                    Add another leg
                  </Button>
                </div>
              </section>

              <section className="trips-ql-section" aria-labelledby="ql-sec-exp">
                <SectionHeader level={3} id="ql-sec-exp" title="Things you did" />
                {form.experiences.map((x) => (
                  <ExperienceEditor
                    key={x.key}
                    x={x}
                    errors={errors}
                    stopCities={[...new Set(usedStops.map((s) => s.cityId))].map((id) => ({ id, name: cityIdx.get(id)?.name ?? id }))}
                    onChange={(p) => patchExp(x.key, p)}
                    onRemove={() => patch({ experiences: form.experiences.filter((e) => e.key !== x.key) })}
                  />
                ))}
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconPlus size={16} />}
                    onClick={() => {
                      const s = form.stops.find((x) => x.cityId);
                      patch({ experiences: [...form.experiences, newExperience(s?.cityId ?? "", s?.arrive ?? "")] });
                    }}
                  >
                    Add something you did
                  </Button>
                </div>
              </section>
            </Disclosure>

            {general ? (
              <p className="trips-ql-banner" role="alert">
                {general}
              </p>
            ) : null}
          </form>
        )}
      </Sheet>

      <Dialog
        open={guard}
        onClose={() => setGuard(false)}
        role="alertdialog"
        title={edit ? "Discard your changes?" : "Discard this trip?"}
        description="What you've entered will be lost."
        footer={
          <>
            <Button variant="ghost" onClick={() => setGuard(false)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setGuard(false);
                closeQuickLog();
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

// ── Stops ────────────────────────────────────────────────────────────

function StopRow({
  stop: s,
  index,
  count,
  errors,
  cityIdx,
  autoFocusDate,
  onChange,
  onMove,
  onRemove,
}: {
  stop: StopDraft;
  index: number;
  count: number;
  errors: LogErrors;
  cityIdx: Map<string, City>;
  autoFocusDate: boolean;
  onChange: (p: Partial<StopDraft>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const k = s.key;
  const eCity = errors[`stop-${k}-city`];
  const eDates = errors[`stop-${k}-dates`];
  return (
    <li className="trips-ql-stop" aria-label={`Stop ${index + 1}`}>
      <div className="trips-ql-stop-head">
        <span className="trips-ql-stop-n num" aria-hidden="true">
          {index + 1}
        </span>
        <div className="trips-ql-stop-city">
          <CityPicker
            id={fieldId(`stop-${k}-city`)}
            cityId={s.cityId}
            cityIdx={cityIdx}
            label={`city for stop ${index + 1}`}
            invalid={!!eCity}
            onChange={(cityId) => onChange({ cityId })}
          />
        </div>
        {count > 1 ? (
          <div className="trips-ql-stop-tools">
            <IconButton size="sm" label="Move stop up" icon={<IconChevronUp size={16} />} disabled={index === 0} onClick={() => onMove(-1)} />
            <IconButton size="sm" label="Move stop down" icon={<IconChevronDown size={16} />} disabled={index === count - 1} onClick={() => onMove(1)} />
            <IconButton size="sm" label="Remove stop" icon={<IconTrash size={16} />} onClick={onRemove} />
          </div>
        ) : null}
      </div>
      <FieldError>{eCity}</FieldError>
      <div className="trips-ql-dates">
        <Field label="Arrived">
          <Input
            id={fieldId(`stop-${k}-dates`)}
            type="date"
            data-autofocus={autoFocusDate || undefined}
            value={s.arrive}
            aria-invalid={eDates ? true : undefined}
            onChange={(e) => onChange({ arrive: e.target.value })}
          />
        </Field>
        <Field label="Left">
          <Input
            type="date"
            value={s.depart}
            min={s.arrive || undefined}
            aria-invalid={eDates ? true : undefined}
            onChange={(e) => onChange({ depart: e.target.value })}
          />
        </Field>
      </div>
      <FieldError>{eDates}</FieldError>
    </li>
  );
}

function StayEditor({ stop: s, city, errors, onChange }: { stop: StopDraft; city?: City; errors: LogErrors; onChange: (p: Partial<StopDraft>) => void }) {
  const k = s.key;
  const lodging = s.lodging ?? { name: "", kind: "" as const, cost: emptyMoney() };
  const setLodging = (p: Partial<NonNullable<StopDraft["lodging"]>>) => onChange({ lodging: { ...lodging, ...p } });
  const crowdOptions = [
    { value: "", label: "Not rated" },
    ...CROWD_STEPS.map((n) => ({ value: String(n), label: crowdWord(n) })),
    ...(s.crowd !== undefined && !CROWD_STEPS.includes(s.crowd) ? [{ value: String(s.crowd), label: `${crowdWord(s.crowd)} (as logged)` }] : []),
  ];
  return (
    <div className="trips-ql-card" role="group" aria-label={`Stay in ${city?.name ?? "this stop"}`}>
      <div className="trips-ql-card-head">
        <span className="trips-ql-card-title">{city?.name ?? s.cityId}</span>
        <RatingInput value={s.rating} onChange={(rating) => onChange({ rating })} label={`Rating for ${city?.name ?? "this stop"}`} />
      </div>
      <div className="trips-ql-grid">
        <Field label="Where you stayed" optional error={errors[`stop-${k}-stay`] ? "Add the name of the place" : undefined}>
          <Input id={fieldId(`stop-${k}-stay`)} placeholder="Hotel or address" value={lodging.name} onChange={(e) => setLodging({ name: e.target.value })} />
        </Field>
        <Field label="Kind of stay" optional>
          <Select
            value={lodging.kind ?? ""}
            onChange={(e) => setLodging({ kind: e.target.value as Lodging["kind"] | "" })}
            options={[{ value: "", label: "Not set" }, ...Object.entries(LODGING_KIND).map(([value, label]) => ({ value, label }))]}
          />
        </Field>
        <MoneyField id={fieldId(`money-${k}-stay`)} label="Cost of the stay" value={lodging.cost} error={errors[`money-${k}-stay`]} onChange={(cost) => setLodging({ cost })} />
        <Field label="How busy was it?" optional>
          <Select
            value={s.crowd === undefined ? "" : String(s.crowd)}
            onChange={(e) => onChange({ crowd: e.target.value === "" ? undefined : Number(e.target.value) })}
            options={crowdOptions}
          />
        </Field>
      </div>
    </div>
  );
}

// ── Segments ─────────────────────────────────────────────────────────

function SegmentEditor({
  seg: g,
  errors,
  cityIdx,
  onChange,
  onRemove,
}: {
  seg: SegmentDraft;
  errors: LogErrors;
  cityIdx: Map<string, City>;
  onChange: (p: Partial<SegmentDraft>) => void;
  onRemove?: () => void;
}) {
  const k = g.key;
  const name = (id: string) => cityIdx.get(id)?.name ?? (id || "…");
  // The date input shows the day only; a time from an import is kept.
  const dayPart = g.date.slice(0, 10);
  const timePart = g.date.slice(10);
  return (
    <div className="trips-ql-card" role="group" aria-label={`Leg from ${name(g.fromCityId)} to ${name(g.toCityId)}`}>
      <div className="trips-ql-card-head">
        <span className="trips-ql-card-title">
          {g.extra ? "Another leg" : `${name(g.fromCityId)} → ${name(g.toCityId)}`}
        </span>
        {onRemove ? <IconButton size="sm" label="Remove this leg" icon={<IconTrash size={16} />} onClick={onRemove} /> : null}
      </div>
      {g.extra ? (
        <div className="trips-ql-grid">
          <Group label="From" htmlFor={fieldId(`seg-${k}-from`)}>
            <CityPicker id={fieldId(`seg-${k}-from`)} cityId={g.fromCityId} cityIdx={cityIdx} label="starting city" invalid={!!errors[`seg-${k}-from`]} onChange={(fromCityId) => onChange({ fromCityId })} />
            <FieldError>{errors[`seg-${k}-from`]}</FieldError>
          </Group>
          <Group label="To" htmlFor={fieldId(`seg-${k}-to`)}>
            <CityPicker id={fieldId(`seg-${k}-to`)} cityId={g.toCityId} cityIdx={cityIdx} label="destination city" invalid={!!errors[`seg-${k}-to`]} onChange={(toCityId) => onChange({ toCityId })} />
            <FieldError>{errors[`seg-${k}-to`]}</FieldError>
          </Group>
        </div>
      ) : null}
      <div className="trips-ql-grid">
        <Field label="How">
          <Select value={g.mode} onChange={(e) => onChange({ mode: e.target.value as SegmentMode })} options={MODES} />
        </Field>
        <Field label="Date" optional>
          <Input type="date" value={dayPart} onChange={(e) => onChange({ date: e.target.value ? e.target.value + timePart : "", dateAuto: false })} />
        </Field>
        <Field label="Company" optional>
          <Input value={g.carrier} placeholder="TAP Air Portugal" onChange={(e) => onChange({ carrier: e.target.value })} />
        </Field>
        <Field label="Flight or train number" optional>
          <Input value={g.number} placeholder="TP1023" onChange={(e) => onChange({ number: e.target.value })} />
        </Field>
        <MoneyField id={fieldId(`money-${k}-seg`)} label="Cost" value={g.cost} error={errors[`money-${k}-seg`]} onChange={(cost) => onChange({ cost })} />
      </div>
    </div>
  );
}

// ── Experiences ──────────────────────────────────────────────────────

function ExperienceEditor({
  x,
  errors,
  stopCities,
  onChange,
  onRemove,
}: {
  x: ExperienceDraft;
  errors: LogErrors;
  stopCities: { id: string; name: string }[];
  onChange: (p: Partial<ExperienceDraft>) => void;
  onRemove: () => void;
}) {
  const k = x.key;
  const cityOptions = stopCities.some((c) => c.id === x.cityId) || !x.cityId ? stopCities : [{ id: x.cityId, name: x.cityId }, ...stopCities];
  return (
    <div className="trips-ql-card" role="group" aria-label={x.title || "New experience"}>
      <div className="trips-ql-card-head">
        <span className="trips-ql-card-title">{x.title || "Something you did"}</span>
        <IconButton size="sm" label="Remove" icon={<IconTrash size={16} />} onClick={onRemove} />
      </div>
      <div className="trips-ql-grid">
        <Field label="What" error={errors[`exp-${k}-title`] ? "Add a short title" : undefined} className="trips-ql-span">
          <Input id={fieldId(`exp-${k}-title`)} placeholder="Dinner at the market" value={x.title} onChange={(e) => onChange({ title: e.target.value })} />
        </Field>
        <Field label="Where" error={errors[`exp-${k}-city`] ? "Pick a city" : undefined}>
          <Select
            id={fieldId(`exp-${k}-city`)}
            value={x.cityId}
            onChange={(e) => onChange({ cityId: e.target.value })}
            options={[{ value: "", label: "Pick a city" }, ...cityOptions.map((c) => ({ value: c.id, label: c.name }))]}
          />
        </Field>
        <Field label="When" error={errors[`exp-${k}-date`] ? "Add a date" : undefined}>
          <Input id={fieldId(`exp-${k}-date`)} type="date" value={x.date} onChange={(e) => onChange({ date: e.target.value })} />
        </Field>
        <Field label="Kind" optional>
          <Select
            value={x.kind}
            onChange={(e) => onChange({ kind: e.target.value as ExperienceKind | "" })}
            options={[{ value: "", label: "Not set" }, ...Object.entries(EXPERIENCE_KIND).map(([value, label]) => ({ value, label }))]}
          />
        </Field>
        <MoneyField id={fieldId(`money-${k}-exp`)} label="Cost" value={x.cost} error={errors[`money-${k}-exp`]} onChange={(cost) => onChange({ cost })} />
        <Group label="Rating" optional>
          <RatingInput value={x.rating} onChange={(rating) => onChange({ rating })} label="Rating" />
        </Group>
      </div>
    </div>
  );
}

// ── Tags ─────────────────────────────────────────────────────────────

function TagsField({ tags, suggestions, onChange }: { tags: string[]; suggestions: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const t = raw.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft("");
  };
  return (
    <Group label="Tags" htmlFor="ql-tags" optional>
      {tags.length ? (
        <div className="trips-ql-tags">
          {tags.map((t) => (
            <Chip key={t} onRemove={() => onChange(tags.filter((x) => x !== t))}>
              {t}
            </Chip>
          ))}
        </div>
      ) : null}
      <Input
        id="ql-tags"
        list="ql-tag-suggest"
        placeholder="Type a tag, then press Enter"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => add(draft)}
      />
      <datalist id="ql-tag-suggest">
        {suggestions
          .filter((t) => !tags.includes(t))
          .map((t) => (
            <option key={t} value={t} />
          ))}
      </datalist>
    </Group>
  );
}

/** Which money field holds `currency` (first non-empty match) so an exchange-rate error lands under it. */
function findMoneyKey(form: LogForm, currency?: string): string | undefined {
  if (!currency) return undefined;
  const hit = (m: { amount: string; currency: string }) => m.amount.trim() !== "" && m.currency === currency;
  for (const s of form.stops) if (s.lodging && hit(s.lodging.cost)) return `money-${s.key}-stay`;
  for (const g of form.segments) if (hit(g.cost)) return `money-${g.key}-seg`;
  for (const x of form.experiences) if (hit(x.cost)) return `money-${x.key}-exp`;
  return undefined;
}
