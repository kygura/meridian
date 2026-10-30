import { useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../store";
import { navigate } from "../../lib/router";
import {
  getJourney,
  saveJourney,
  JournalApiError,
  JournalLockedError,
} from "../../lib/journalApi";
import { cityIndex, formatDay, journalTags } from "../../lib/journal";
import {
  emptyForm,
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
} from "../../lib/journalForm";
import type { ExperienceKind } from "../../types";
import StopEditor from "./StopEditor";
import SegmentEditor from "./SegmentEditor";
import MoneyInput from "./MoneyInput";
import RatingPips from "./RatingPips";
import "../../styles/journal.css";

const EXP_KINDS: ExperienceKind[] = ["food", "tour", "nature", "event", "culture", "nightlife", "other"];
const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

function focusKey(key: string) {
  const el = document.getElementById(`jr-f-${key}`);
  const target = el && (el.matches("input,select,button,textarea") ? el : el.querySelector<HTMLElement>("input,select,button,textarea"));
  (target as HTMLElement | null)?.focus();
}

/** Mounted once in App; renders only while store.quickLog.open. Create and edit share the sheet. */
export default function QuickLogSheet() {
  const quickLog = useMeridianStore((s) => s.quickLog);
  if (!quickLog.open) return null;
  return <Sheet journeyId={quickLog.journeyId} prefillStops={quickLog.prefillStops} />;
}

function Sheet({ journeyId, prefillStops }: { journeyId?: string; prefillStops?: string[] }) {
  const cities = useMeridianStore((s) => s.cities);
  const journeys = useMeridianStore((s) => s.journeys);
  const closeQuickLog = useMeridianStore((s) => s.closeQuickLog);
  const upsertJourney = useMeridianStore((s) => s.upsertJourney);
  const cityIdx = useMemo(() => cityIndex(cities), [cities]);
  const tagSuggestions = useMemo(() => journalTags(journeys ?? []), [journeys]);

  const cardRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(document.activeElement);
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
  const [errors, setErrors] = useState<LogErrors>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [guard, setGuard] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const edit = !!journeyId;

  // Editing a journey that is not in the store yet (deep link): fetch it once.
  useEffect(() => {
    if (initial || !journeyId) return;
    let live = true;
    getJourney(journeyId)
      .then((j) => {
        if (!live) return;
        if (!j) return setLoadFailed(true);
        const f = fromJourney(j);
        setInitial(f);
        setForm(f);
      })
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [initial, journeyId]);

  // Focus: title, or the first ARRIVE when stops were prefilled from the globe.
  useEffect(() => {
    if (!form) return;
    const card = cardRef.current;
    const first = prefillStops?.length ? card?.querySelector<HTMLElement>('input[type="date"]') : card?.querySelector<HTMLElement>("#jr-f-title");
    first?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!form]);

  // Return focus to whatever opened the sheet.
  useEffect(() => {
    const opener = openerRef.current;
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  const dirty = !!form && !!initial && isDirty(form, initial);
  const attemptClose = () => {
    if (dirty) setGuard(true);
    else closeQuickLog();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      attemptClose();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = [...(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((n) => n.offsetParent !== null);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
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

  const patchStop = (key: string, p: Partial<StopDraft>) =>
    setStops((ss) => ss.map((s) => (s.key === key ? { ...s, ...p } : s)));

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

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (t && form && !form.tags.includes(t)) patch({ tags: [...form.tags, t] });
    setTagDraft("");
  };

  // ── Save ───────────────────────────────────────────────────────────

  const save = async () => {
    if (!form || saving) return;
    const errs = validateLog(form);
    setErrors(errs);
    setGeneral(null);
    const firstKey = Object.keys(errs)[0];
    if (firstKey) {
      focusKey(firstKey);
      return;
    }
    setSaving(true);
    try {
      const input = toJourneyInput(form, (id) => cityIdx.get(id)?.name ?? id);
      const saved = await saveJourney(input, journeyId, form.base?.updatedAt);
      upsertJourney(saved);
      closeQuickLog();
      // From the globe the user stays on the globe, with the journeys layer forced on.
      if (!prefillStops?.length) navigate(`/journal/${encodeURIComponent(saved.id)}`);
      else useMeridianStore.setState((s) => ({ layers: { ...s.layers, journeys: true } }));
    } catch (err) {
      setSaving(false);
      if (err instanceof JournalApiError && err.fxUnavailable) {
        const hit = findMoneyKey(form, err.currency);
        const when = err.date ? ` ON ${formatDay(err.date)} ${err.date.slice(0, 4)}` : "";
        const msg = `⚠ NO EXCHANGE RATE FOR ${err.currency ?? "THAT CURRENCY"}${when} — TRY AGAIN LATER OR ENTER IN EUR`;
        if (hit) {
          setErrors({ [hit]: msg });
          focusKey(hit);
        } else setGeneral(msg);
      } else if (err instanceof JournalApiError && err.status === 400) {
        const first = Array.isArray(err.issues) ? (err.issues[0] as { message?: string; path?: unknown[] } | undefined) : undefined;
        setGeneral(`⚠ COULDN'T SAVE — ${first?.message ?? "CHECK THE FIELDS"}${first?.path?.length ? ` (${first.path.join(".")})` : ""}`.toUpperCase());
      } else if (err instanceof JournalApiError && err.status === 409) {
        setGeneral("⚠ THAT JOURNEY CHANGED MEANWHILE — CLOSE THIS SHEET AND REOPEN IT");
        if (journeyId) getJourney(journeyId).then((j) => j && upsertJourney(j)).catch(() => {});
      } else if (err instanceof JournalLockedError) {
        setGeneral("⚠ JOURNAL LOCKED — CLOSE THIS SHEET AND UNLOCK FIRST");
      } else {
        setGeneral("⚠ COULDN'T SAVE — CHECK YOUR CONNECTION AND TRY AGAIN");
      }
    }
  };

  const title = edit ? `EDIT · ${(form?.base?.title ?? "").toUpperCase()}` : "+ LOG JOURNEY";

  return (
    <div className="cmd-overlay" role="presentation">
      <div
        ref={cardRef}
        className="jr-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="jr-sheet-title"
        onKeyDown={onKeyDown}
      >
        <div className="booking-head">
          <div className="booking-head-title-row">
            <span className="booking-head-title" id="jr-sheet-title">
              {title}
            </span>
            <button type="button" className="tm-action-btn booking-close" aria-label="Close" onClick={attemptClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="booking-body jr-sheet-body">
          {!form && (
            <div className="jr-empty" role={loadFailed ? "alert" : "status"}>
              {loadFailed ? "⚠ COULDN'T LOAD THIS JOURNEY" : <span className="agent-brief-loading"><span /><span /><span /></span>}
            </div>
          )}
          {form && (
            <>
              <section>
                <label className="jr-label" htmlFor="jr-f-title">
                  TITLE
                </label>
                <input
                  id="jr-f-title"
                  className="jr-input jr-input-sans jr-input-wide"
                  placeholder="e.g. Lisbon & Porto, slow week"
                  value={form.title}
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </section>

              <section>
                <div className="jr-label">STOPS</div>
                {form.stops.map((s, i) => (
                  <StopEditor
                    key={s.key}
                    stop={s}
                    index={i}
                    count={form.stops.length}
                    errors={errors}
                    cities={cities}
                    cityIdx={cityIdx}
                    onChange={(p) => patchStop(s.key, p)}
                    onMove={(dir) => moveStop(i, dir)}
                    onRemove={() => setStops((ss) => ss.filter((x) => x.key !== s.key))}
                  />
                ))}
                {errors.stops && <div className="jr-err">{errors.stops}</div>}
                <button
                  id="jr-f-stops"
                  type="button"
                  className="tm-add-btn"
                  onClick={() => setStops((ss) => [...ss, newStop("", ss[ss.length - 1]?.depart ?? "")])}
                >
                  + ADD STOP
                </button>
              </section>

              <section>
                <div className="jr-label">SEGMENTS</div>
                {form.segments.length === 0 && <div className="jr-hint">Segments appear between stops once two cities are picked.</div>}
                {form.segments.map((g) => (
                  <SegmentEditor
                    key={g.key}
                    seg={g}
                    errors={errors}
                    cities={cities}
                    cityIdx={cityIdx}
                    onChange={(p) => patchSeg(g.key, p)}
                    onRemove={g.extra || form.base ? () => patch({ segments: form.segments.filter((x) => x.key !== g.key) }) : undefined}
                  />
                ))}
                <button
                  type="button"
                  className="tm-action-btn"
                  onClick={() => patch({ segments: [...form.segments, newExtraSegment()] })}
                >
                  + OTHER SEGMENT
                </button>
              </section>

              <section>
                <button type="button" className="jr-disclose" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                  {showDone ? "▾" : "▸"} DONE ({form.experiences.length})
                </button>
                {showDone && (
                  <>
                    {form.experiences.map((x) => (
                      <div key={x.key} className="jr-seg" role="group" aria-label={`Experience ${x.title || "untitled"}`}>
                        <div className="jr-row jr-row-top">
                          <label className="jr-field">
                            <span className="jr-label">CITY</span>
                            <select
                              id={`jr-f-exp-${x.key}-city`}
                              className="jr-input"
                              value={x.cityId}
                              aria-invalid={!!errors[`exp-${x.key}-city`]}
                              onChange={(e) => patchExp(x.key, { cityId: e.target.value })}
                            >
                              <option value="">—</option>
                              {[...new Set(form.stops.map((s) => s.cityId).filter(Boolean))].map((id) => (
                                <option key={id} value={id}>
                                  {cityIdx.get(id)?.name ?? id}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="jr-field">
                            <span className="jr-label">DATE</span>
                            <input
                              id={`jr-f-exp-${x.key}-date`}
                              type="date"
                              className="jr-input"
                              value={x.date}
                              aria-invalid={!!errors[`exp-${x.key}-date`]}
                              onChange={(e) => patchExp(x.key, { date: e.target.value })}
                            />
                          </label>
                          <label className="jr-field jr-grow">
                            <span className="jr-label">TITLE</span>
                            <input
                              id={`jr-f-exp-${x.key}-title`}
                              className="jr-input jr-input-sans"
                              value={x.title}
                              aria-invalid={!!errors[`exp-${x.key}-title`]}
                              onChange={(e) => patchExp(x.key, { title: e.target.value })}
                            />
                          </label>
                          <label className="jr-field">
                            <span className="jr-label">KIND</span>
                            <select
                              className="jr-input"
                              value={x.kind}
                              onChange={(e) => patchExp(x.key, { kind: e.target.value as ExperienceKind | "" })}
                            >
                              <option value="">—</option>
                              {EXP_KINDS.map((k) => (
                                <option key={k} value={k}>
                                  {k.toUpperCase()}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="jr-field">
                            <span className="jr-label">COST</span>
                            <MoneyInput
                              id={`jr-f-money-${x.key}-exp`}
                              label="Experience cost"
                              value={x.cost}
                              error={errors[`money-${x.key}-exp`]}
                              onChange={(cost) => patchExp(x.key, { cost })}
                            />
                          </div>
                          <div className="jr-field">
                            <span className="jr-label">RATING</span>
                            <RatingPips value={x.rating} onChange={(rating) => patchExp(x.key, { rating })} label="Experience rating" />
                          </div>
                          <button
                            type="button"
                            className="jr-x"
                            aria-label="Remove experience"
                            onClick={() => patch({ experiences: form.experiences.filter((e) => e.key !== x.key) })}
                          >
                            ✕
                          </button>
                        </div>
                        {(["city", "date", "title"] as const).map(
                          (f) => errors[`exp-${x.key}-${f}`] && <div key={f} className="jr-err">{errors[`exp-${x.key}-${f}`]}</div>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="tm-action-btn"
                      onClick={() => {
                        const s = form.stops.find((x) => x.cityId);
                        patch({ experiences: [...form.experiences, newExperience(s?.cityId ?? "", s?.arrive ?? "")] });
                      }}
                    >
                      + ADD
                    </button>
                  </>
                )}
              </section>

              <section>
                <div className="jr-label">JOURNEY</div>
                <div className="jr-row jr-row-top">
                  <div className="jr-field">
                    <span className="jr-label">RATING</span>
                    <RatingPips value={form.rating} onChange={(rating) => patch({ rating })} label="Journey rating" />
                  </div>
                  <div className="jr-field">
                    <span className="jr-label">TRAVELLERS</span>
                    <span className="bk-pax-stepper" role="group" aria-label="Travellers">
                      <button
                        type="button"
                        aria-label="Fewer travellers"
                        disabled={(form.travellers ?? 1) <= 1}
                        onClick={() => patch({ travellers: Math.max(1, (form.travellers ?? 1) - 1) })}
                      >
                        −
                      </button>
                      <span className="bk-pax-count" aria-live="polite">
                        {form.travellers ?? 1}
                      </span>
                      <button
                        type="button"
                        aria-label="More travellers"
                        disabled={(form.travellers ?? 1) >= 9}
                        onClick={() => patch({ travellers: Math.min(9, (form.travellers ?? 1) + 1) })}
                      >
                        +
                      </button>
                    </span>
                  </div>
                  <div className="jr-field jr-grow">
                    <label className="jr-label" htmlFor="jr-tag-input">
                      TAGS
                    </label>
                    <div className="jr-tags">
                      {form.tags.map((t) => (
                        <span key={t} className="jr-pill on">
                          {t}
                          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => patch({ tags: form.tags.filter((x) => x !== t) })}>
                            ×
                          </button>
                        </span>
                      ))}
                      <input
                        id="jr-tag-input"
                        className="jr-input jr-input-sans jr-tag-input"
                        list="jr-tag-suggest"
                        placeholder="type, then Enter"
                        value={tagDraft}
                        onChange={(e) => setTagDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addTag(tagDraft);
                          }
                        }}
                        onBlur={() => addTag(tagDraft)}
                      />
                      <datalist id="jr-tag-suggest">
                        {tagSuggestions.filter((t) => !form.tags.includes(t)).map((t) => (
                          <option key={t} value={t} />
                        ))}
                      </datalist>
                    </div>
                  </div>
                </div>
                <label className="jr-label" htmlFor="jr-notes">
                  NOTES
                </label>
                <textarea
                  id="jr-notes"
                  className="jr-input jr-input-sans jr-input-wide"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => patch({ notes: e.target.value })}
                />
              </section>
            </>
          )}
        </div>

        {general && (
          <div className="jr-general-err" role="alert">
            {general}
          </div>
        )}

        {guard && (
          <div className="bk-discard-guard" role="alertdialog" aria-label="Discard this log">
            <span className="bk-discard-title">DISCARD THIS LOG?</span>
            <span className="bk-discard-sub">Details will be lost.</span>
            <button type="button" className="tm-action-btn" autoFocus onClick={() => setGuard(false)}>
              KEEP
            </button>
            <button type="button" className="tm-action-btn tm-delete-btn" onClick={closeQuickLog}>
              DISCARD
            </button>
          </div>
        )}

        <div className="booking-foot">
          <button type="button" className="tm-action-btn" onClick={attemptClose}>
            CANCEL
          </button>
          <button type="button" className="booking-primary-btn" disabled={!form || saving} onClick={() => void save()}>
            {saving ? "SAVING…" : edit ? "SAVE CHANGES" : "SAVE JOURNEY"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Which money field holds `currency` (first non-empty match) so an FX error lands under it. */
function findMoneyKey(form: LogForm, currency?: string): string | undefined {
  if (!currency) return undefined;
  const hit = (m: { amount: string; currency: string }) => m.amount.trim() !== "" && m.currency === currency;
  for (const s of form.stops) if (s.lodging && hit(s.lodging.cost)) return `money-${s.key}-stay`;
  for (const g of form.segments) if (hit(g.cost)) return `money-${g.key}-seg`;
  for (const x of form.experiences) if (hit(x.cost)) return `money-${x.key}-exp`;
  return undefined;
}
