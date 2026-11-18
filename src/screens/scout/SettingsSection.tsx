import { useState } from "react";
import { Button, Card, Disclosure, ErrorState, Field, Input, SectionHeader, Skeleton, Textarea, toast } from "../../ui";
import { JournalApiError, JournalLockedError } from "../../lib/journalApi";
import { patchAtlasConfig, type AtlasConfig } from "../../lib/atlasApi";
import { buildConfigPatch, configToForm, issuesToErrors, type ConfigForm, type FormErrors } from "../../lib/atlasFormat";
import type { Resource } from "./useScout";

type Data = { config: AtlasConfig; updatedAt: string | null };

function Form({ data, onSaved }: { data: Data; onSaved: (next: Data) => void }) {
  const base = data.config;
  const [form, setForm] = useState<ConfigForm>(() => configToForm(base));
  const [errors, setErrors] = useState<FormErrors>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof ConfigForm) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setErrors((x) => ({ ...x, [k]: undefined }));
  };
  const dirty = Object.keys(buildConfigPatch(base, form).patch).length > 0;

  const save = async () => {
    const { patch, errors: local } = buildConfigPatch(base, form);
    setGeneral([]);
    if (Object.keys(local).length) return setErrors(local);
    if (!Object.keys(patch).length) return;
    setBusy(true);
    try {
      const next = await patchAtlasConfig(patch);
      setErrors({});
      setForm(configToForm(next.config));
      onSaved(next);
      toast("Settings saved", { tone: "success" });
    } catch (err) {
      if (err instanceof JournalLockedError) return;
      if (err instanceof JournalApiError && err.status === 400) {
        const { fields, general: rest } = issuesToErrors(err.issues);
        setErrors(fields);
        setGeneral(rest.length || Object.keys(fields).length ? rest : [err.message]);
      } else {
        setGeneral([err instanceof Error ? err.message : "The request failed."]);
      }
    } finally {
      setBusy(false);
    }
  };

  const num = (k: keyof ConfigForm, label: string, hint?: string) => (
    <Field label={label} hint={hint} error={errors[k]}>
      <Input type="number" inputMode="numeric" min={0} value={form[k]} onChange={set(k)} />
    </Field>
  );

  return (
    <form
      className="scout-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Persona" hint="The character Atlas thinks from. It guides taste, not filters." error={errors.persona}>
        <Textarea rows={4} value={form.persona} onChange={set("persona")} />
      </Field>
      <div className="scout-form-grid">
        <Field label="Intent tags" hint="Comma separated, for example surf, hiking." error={errors.intentTags}>
          <Input value={form.intentTags} onChange={set("intentTags")} />
        </Field>
        <Field label="Avoid" hint="Comma separated, for example resorts, bus tours." error={errors.avoid}>
          <Input value={form.avoid} onChange={set("avoid")} />
        </Field>
      </div>

      <h3 className="scout-h3">Fare limits</h3>
      <div className="scout-form-grid">
        {num("budgetMin", "Budget minimum (EUR)")}
        {num("budgetMax", "Budget maximum (EUR)")}
        {num("maxStops", "Maximum stops")}
        {num("maxTravelTimeHours", "Maximum travel time (hours)")}
        <Field label="Fallback airports" hint="IATA codes, comma separated. Used when no stay shows where you are." error={errors.fallbackOrigins}>
          <Input value={form.fallbackOrigins} onChange={set("fallbackOrigins")} autoCapitalize="characters" />
        </Field>
      </div>

      <h3 className="scout-h3">Search windows, in days from today</h3>
      <div className="scout-form-grid">
        {num("aMin", "Window A, earliest day", "Short notice")}
        {num("aMax", "Window A, latest day")}
        {num("bMin", "Window B, earliest day", "Planned ahead")}
        {num("bMax", "Window B, latest day")}
      </div>

      <h3 className="scout-h3">Trips</h3>
      <div className="scout-form-grid">{num("activityBudget", "Activity budget per day (EUR)")}</div>

      {general.length > 0 && (
        <ul className="scout-error-list" role="alert">
          {general.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}
      <div className="scout-form-actions">
        <Button type="submit" variant="secondary" loading={busy} disabled={!dirty}>
          Save settings
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy || !dirty}
          onClick={() => {
            setForm(configToForm(base));
            setErrors({});
            setGeneral([]);
          }}
        >
          Reset
        </Button>
        <span className="scout-muted">Only the fields you change are sent.</span>
      </div>
    </form>
  );
}

/** The config fields most worth editing by hand. Collapsed until opened. */
export function SettingsSection({ config }: { config: Resource<Data> }) {
  return (
    <section className="scout-section" aria-labelledby="scout-settings">
      <SectionHeader id="scout-settings" title="Settings" meta="How Atlas searches and what it avoids" />
      <Card padding="sm">
        <Disclosure summary="Edit Atlas settings">
          {config.error && !config.data ? (
            <ErrorState message={config.error} onRetry={() => void config.reload()} />
          ) : !config.data ? (
            <Skeleton lines={4} />
          ) : (
            <Form key={config.data.updatedAt ?? "default"} data={config.data} onSaved={(next) => config.set(next)} />
          )}
        </Disclosure>
      </Card>
    </section>
  );
}
