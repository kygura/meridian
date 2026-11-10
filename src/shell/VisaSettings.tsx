import { useEffect, useMemo, useState } from "react";
import { Button, Chip, Field, IconButton, Input, Select, toast, useJournalToken } from "../ui";
import { IconPlus, IconTrash } from "../ui/icons";
import { getVisaData, saveVisaSettings } from "../lib/visaApi";
import { refreshVisa } from "../lib/useVisa";
import { VISA_DISCLAIMER, type VisaData } from "../lib/visa/data";
import type { VisaSettings } from "../lib/visa/settings";
import "./visa.css";

/** Settings › Visas: passports held, legal residency, countries watched for tax days (ADR 0012). */
export function VisaSettingsSection() {
  const { unlocked } = useJournalToken();
  const [settings, setSettings] = useState<VisaSettings | null>(null);
  const [data, setData] = useState<VisaData | null>(null);
  const [busy, setBusy] = useState(false);
  const [watchPick, setWatchPick] = useState("");

  useEffect(() => {
    if (!unlocked) return;
    getVisaData()
      .then((r) => {
        setData(r.data);
        setSettings(r.settings);
      })
      .catch(() => setSettings(null));
  }, [unlocked]);

  const options = useMemo(
    () =>
      data
        ? Object.entries(data.countries)
            .map(([value, c]) => ({ value, label: c.name }))
            .sort((a, b) => a.label.localeCompare(b.label))
        : [],
    [data]
  );
  if (!unlocked || !settings || !data) return null;
  const nameOf = (c: string) => data.countries[c]?.name ?? c;

  const save = async () => {
    setBusy(true);
    try {
      setSettings(await saveVisaSettings(settings));
      void refreshVisa();
      toast("Visa settings saved", { tone: "success" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save", { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  const setPassport = (i: number, patch: Partial<VisaSettings["passports"][number]>) =>
    setSettings({ ...settings, passports: settings.passports.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  return (
    <section className="shell-settings-section">
      <h3 className="shell-settings-heading">Visas</h3>
      <p className="shell-settings-hint">Your passports decide the entry rules and day limits checked on trips, the rotation and the solver. They stay on your server. An expiry date lets Meridian check each destination's passport-validity rule.</p>
      {settings.passports.map((p, i) => (
        <div className="shell-visa-passport" key={i}>
          <Field label={i === 0 ? "Passport" : "Also a passport of"}>
            <Select size="sm" value={p.country} onChange={(e) => setPassport(i, { country: e.target.value })} options={options} />
          </Field>
          <div className="shell-visa-expiry">
            <Field label="Expires" optional>
              <Input size="sm" type="date" value={p.expires ?? ""} onChange={(e) => setPassport(i, { expires: e.target.value || undefined })} />
            </Field>
            <IconButton label={`Remove ${nameOf(p.country)} passport`} icon={<IconTrash size={16} />} size="sm" onClick={() => setSettings({ ...settings, passports: settings.passports.filter((_, j) => j !== i) })} />
          </div>
        </div>
      ))}
      {settings.passports.length < 5 && (
        <Button size="sm" icon={<IconPlus size={16} />} onClick={() => setSettings({ ...settings, passports: [...settings.passports, { country: options[0]?.value ?? "US" }] })}>
          Add a passport
        </Button>
      )}
      <Field label="Legal residency" hint="The country you want to stay tax-resident in">
        <Select size="sm" value={settings.residency ?? ""} onChange={(e) => setSettings({ ...settings, residency: e.target.value || null })} options={[{ value: "", label: "Not set" }, ...options]} />
      </Field>
      <Field label="Watch for tax days" hint="Listed on the Days page even before you go">
        <Select
          size="sm"
          value={watchPick}
          onChange={(e) => {
            const v = e.target.value;
            setWatchPick("");
            if (v && !settings.taxWatch.includes(v)) setSettings({ ...settings, taxWatch: [...settings.taxWatch, v] });
          }}
          options={[{ value: "", label: "Add a country…" }, ...options]}
        />
      </Field>
      {settings.taxWatch.length > 0 && (
        <div className="shell-visa-chips">
          {settings.taxWatch.map((c) => (
            <Chip key={c} onRemove={() => setSettings({ ...settings, taxWatch: settings.taxWatch.filter((x) => x !== c) })}>
              {nameOf(c)}
            </Chip>
          ))}
        </div>
      )}
      <p className="shell-settings-hint">{VISA_DISCLAIMER}</p>
      <div className="shell-settings-row">
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </section>
  );
}
