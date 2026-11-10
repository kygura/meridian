import { useState } from "react";
import { Button, Field, IconButton, Input, Select, Sheet, Textarea } from "../../ui";
import { IconPlus, IconTrash } from "../../ui/icons";
import { WINDOW_KINDS, type PersonalWindow, type PlaceProfile, type RotationPlace, type WindowKind } from "../../lib/rotation";
import { WINDOW_LABEL } from "./format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthOptions = MONTHS.map((m, i) => ({ value: String(i + 1), label: m }));

interface Row {
  id: string;
  kind: WindowKind;
  start: string;
  end: string;
  reason: string;
  source?: PersonalWindow["source"];
}

export interface PlaceSheetProps {
  open: boolean;
  place: RotationPlace;
  profile?: PlaceProfile;
  onClose: () => void;
  onSave: (p: PlaceProfile) => Promise<boolean>;
  onDelete?: (cityId: string) => void;
}

/** The owner's own peak, shoulder and avoid months for a place, and how far ahead to book there. */
export function PlaceSheet({ open, place, profile, onClose, onSave, onDelete }: PlaceSheetProps) {
  const [rows, setRows] = useState<Row[]>(() =>
    (profile?.windows ?? []).map((w) => ({ id: w.id, kind: w.kind, start: String(w.months.start), end: String(w.months.end), reason: w.reason ?? "", source: w.source }))
  );
  const [leadMin, setLeadMin] = useState(profile?.leadTime ? String(profile.leadTime.min) : "");
  const [leadMax, setLeadMax] = useState(profile?.leadTime ? String(profile.leadTime.max) : "");
  const [notes, setNotes] = useState(profile?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const update = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const add = () =>
    setRows((r) => [...r, { id: `w-${Date.now().toString(36)}-${r.length}`, kind: "avoid", start: "1", end: "1", reason: "", source: { kind: "manual" } }]);

  const save = async () => {
    const num = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);
    const min = num(leadMin);
    const max = num(leadMax);
    if ((leadMin.trim() && min === undefined) || (leadMax.trim() && max === undefined)) return setError("Lead times are whole weeks.");
    const lo = min ?? max;
    const hi = max ?? min;
    if (lo !== undefined && hi !== undefined && lo > hi) return setError("The shorter lead time is longer than the longer one.");
    setError(null);
    setSaving(true);
    const ok = await onSave({
      cityId: place.cityId,
      name: place.name,
      country: place.country,
      windows: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        months: { start: Number(r.start), end: Number(r.end) },
        reason: r.reason.trim() || undefined,
        source: r.source ?? { kind: "manual" },
      })),
      leadTime: lo !== undefined && hi !== undefined ? { min: lo, max: hi } : undefined,
      notes: notes.trim() || undefined,
      updatedAt: profile?.updatedAt,
    });
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={place.name}
      description="Your own months for this place. They come before the Comfort Index wherever the rotation is scored."
      footer={
        <div className="rotation-sheet-footer">
          {profile && onDelete ? (
            <Button variant="danger-outline" icon={<IconTrash size={16} />} onClick={() => onDelete(place.cityId)}>
              Clear
            </Button>
          ) : (
            <span />
          )}
          <div className="rotation-sheet-footer-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving}>
              Save
            </Button>
          </div>
        </div>
      }
    >
      <div className="rotation-form">
        <section className="rotation-sheet-section" aria-labelledby="rot-windows">
          <h3 id="rot-windows" className="ui-section-title">
            Your windows
          </h3>
          {rows.length === 0 && <p className="rotation-p rotation-muted">None yet. Add the months you'd pick, or the ones you'd stay away, and why.</p>}
          {rows.map((r, i) => (
            <div key={r.id} className="rotation-window-row">
              <Field label="Kind" hideLabel>
                <Select value={r.kind} onChange={(e) => update(i, { kind: e.target.value as WindowKind })} options={WINDOW_KINDS.map((k) => ({ value: k, label: WINDOW_LABEL[k] }))} />
              </Field>
              <Field label="From" hideLabel>
                <Select value={r.start} onChange={(e) => update(i, { start: e.target.value })} options={monthOptions} />
              </Field>
              <Field label="To" hideLabel>
                <Select value={r.end} onChange={(e) => update(i, { end: e.target.value })} options={monthOptions} />
              </Field>
              <IconButton label="Remove window" icon={<IconTrash size={16} />} onClick={() => setRows((x) => x.filter((_, k) => k !== i))} />
              <Field label="Reason" hideLabel className="rotation-window-reason">
                <Input value={r.reason} onChange={(e) => update(i, { reason: e.target.value })} placeholder="Reason, e.g. burning season, air quality" />
              </Field>
              {r.source?.kind && r.source.kind !== "manual" && <p className="rotation-fine">Imported from {r.source.kind === "notion" ? "Notion" : "an import"}; a re-import replaces it.</p>}
            </div>
          ))}
          <Button size="sm" icon={<IconPlus size={16} />} onClick={add}>
            Add a window
          </Button>
        </section>

        <section className="rotation-sheet-section" aria-labelledby="rot-lead">
          <h3 id="rot-lead" className="ui-section-title">
            Book ahead
          </h3>
          <div className="rotation-form-row">
            <Field label="Weeks ahead (from)" optional hint="Azores 8–10 weeks; safari lodges 52.">
              <Input inputMode="numeric" value={leadMin} onChange={(e) => setLeadMin(e.target.value)} />
            </Field>
            <Field label="Weeks ahead (to)" optional>
              <Input inputMode="numeric" value={leadMax} onChange={(e) => setLeadMax(e.target.value)} />
            </Field>
          </div>
        </section>

        <Field label="Notes" optional>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </Field>
        {error && (
          <p className="rotation-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
