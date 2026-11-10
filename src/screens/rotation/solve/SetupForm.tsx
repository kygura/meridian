import { useEffect, useMemo, useState } from "react";
import { Button, Chip, CitySearch, Disclosure, Field, IconButton, Input, Segmented, Select, cx } from "../../../ui";
import { IconPlus, IconTrash } from "../../../ui/icons";
import { useMeridianStore } from "../../../store";
import { listJourneys } from "../../../lib/journalApi";
import { preferenceLabel, regionOptions } from "../../../lib/solver/prefs";
import type { PoolEntry, SolverSettings } from "../../../lib/solver/settings";
import type { Preference, Weights } from "../../../lib/solver/types";
import type { PlaceProfile, RotationStay } from "../../../lib/rotation";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthOptions = MONTHS.map((m, i) => ({ value: String(i + 1), label: m }));

const WEIGHT_LABEL: Record<keyof Weights, { label: string; hint: string }> = {
  fit: { label: "Fit", hint: "Your windows, else the Comfort Index" },
  cost: { label: "Cost", hint: "Against your monthly budget" },
  friction: { label: "Travel", hint: "Fewer, shorter, cheaper moves" },
  visa: { label: "Visa margin", hint: "Spare Schengen and tax days" },
  risk: { label: "Risk", hint: "Advisories, seasonal hazards, news" },
  preferences: { label: "Preferences", hint: "The wishes below" },
};

export interface SetupFormProps {
  settings: SolverSettings;
  onChange: (s: SolverSettings) => void;
  stays: RotationStay[];
  places: PlaceProfile[];
}

function Slider({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  const id = `sl-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="solve-slider">
      <div className="solve-slider-top">
        <label htmlFor={id}>{label}</label>
        <span className="num" aria-hidden="true">
          {value.toFixed(1)}
        </span>
      </div>
      <input id={id} type="range" min={0} max={1} step={0.1} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ ["--solve-fill" as string]: `${value * 100}%` }} />
      {hint && <p className="solve-fine">{hint}</p>}
    </div>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="solve-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
const numOrUndef = (v: string) => (v.trim() === "" ? undefined : Number(v));

let prefCounter = 0;
const newId = () => `p${Date.now().toString(36)}${prefCounter++}`;

/** Pool, budget, preferences with weights, and the hard rules. */
export function SetupForm({ settings, onChange, stays, places }: SetupFormProps) {
  const cities = useMeridianStore((s) => s.cities);
  const shortlist = useMeridianStore((s) => s.shortlist);
  const cityById = useMemo(() => new Map(cities.map((c) => [c.id, c])), [cities]);
  const [journeyIds, setJourneyIds] = useState<string[] | null>(null);
  const set = (patch: Partial<SolverSettings>) => onChange({ ...settings, ...patch });
  const inPool = new Set(settings.pool.map((p) => p.cityId));

  useEffect(() => {
    let live = true;
    listJourneys()
      .then((js) => live && setJourneyIds([...new Set(js.flatMap((j) => j.stops.map((s) => s.cityId)))]))
      .catch(() => live && setJourneyIds([]));
    return () => {
      live = false;
    };
  }, []);

  const sources: { label: string; ids: string[] }[] = [
    { label: "Your rotation", ids: [...new Set([...stays.map((s) => s.place.cityId), ...places.map((p) => p.cityId)])] },
    { label: "Shortlist", ids: shortlist.map((s) => s.cityId) },
    { label: "Past journeys", ids: journeyIds ?? [] },
  ];

  const addCity = (cityId: string) => {
    if (inPool.has(cityId) || settings.pool.length >= 40) return;
    set({ pool: [...settings.pool, { cityId, kind: "base" }] });
  };
  const updateEntry = (i: number, patch: Partial<PoolEntry>) => set({ pool: settings.pool.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const nameOf = (id: string) => cityById.get(id)?.name ?? places.find((p) => p.cityId === id)?.name ?? stays.find((s) => s.place.cityId === id)?.place.name ?? id;

  const setPref = (i: number, p: Preference) => set({ preferences: settings.preferences.map((x, k) => (k === i ? p : x)) });
  const k = settings.constraints;
  const setK = (patch: Partial<typeof k>) => set({ constraints: { ...k, ...patch } });

  return (
    <div className="solve-setup">
      <section className="solve-block" aria-labelledby="solve-pool">
        <h3 id="solve-pool" className="solve-h">
          Pool <span className="solve-fine num">{settings.pool.length} of 40</span>
        </h3>
        <CitySearch onPick={(c) => addCity(c.id)} placeholder="Add a place" excludeIds={[...inPool]} clearOnPick size="sm" />
        {sources.map((src) => {
          const extra = src.ids.filter((id) => !inPool.has(id) && cityById.has(id));
          if (!extra.length) return null;
          return (
            <div key={src.label} className="solve-source">
              <span className="solve-fine">{src.label}</span>
              <div className="solve-chips">
                {extra.slice(0, 12).map((id) => (
                  <Chip key={id} icon={<IconPlus size={12} />} onClick={() => addCity(id)}>
                    {nameOf(id)}
                  </Chip>
                ))}
              </div>
            </div>
          );
        })}
        {settings.pool.length === 0 ? (
          <p className="solve-fine">Add the places you'd consider living in. Pass-throughs are used as hubs on long moves and for border runs.</p>
        ) : (
          <ul className="solve-pool">
            {settings.pool.map((p, i) => (
              <li key={p.cityId} className="solve-pool-row">
                <span className="solve-pool-name">{nameOf(p.cityId)}</span>
                <Segmented
                  size="sm"
                  label={`${nameOf(p.cityId)} type`}
                  value={p.kind}
                  onChange={(v) => updateEntry(i, { kind: v })}
                  options={[
                    { value: "base", label: "Base" },
                    { value: "pass-through", label: "Pass" },
                  ]}
                />
                <IconButton label={`Remove ${nameOf(p.cityId)}`} size="sm" variant="ghost" icon={<IconTrash size={14} />} onClick={() => set({ pool: settings.pool.filter((_, k2) => k2 !== i) })} />
                <div className="solve-pool-more">
                  <Field label="Min nights" optional>
                    <Input size="sm" inputMode="numeric" value={p.minNights ?? ""} placeholder={p.kind === "base" ? "28" : "2"} onChange={(e) => updateEntry(i, { minNights: numOrUndef(e.target.value) })} />
                  </Field>
                  <Field label="Max nights" optional>
                    <Input size="sm" inputMode="numeric" value={p.maxNights ?? ""} placeholder={p.kind === "base" ? "92" : "5"} onChange={(e) => updateEntry(i, { maxNights: numOrUndef(e.target.value) })} />
                  </Field>
                  <Field label="Your € a month" optional hint="Instead of the estimate">
                    <Input size="sm" inputMode="numeric" value={p.budgetEur ?? ""} onChange={(e) => updateEntry(i, { budgetEur: numOrUndef(e.target.value) })} />
                  </Field>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="solve-block" aria-labelledby="solve-budget">
        <h3 id="solve-budget" className="solve-h">
          Budget and horizon
        </h3>
        <div className="solve-row">
          <Field label="Monthly budget, €" hint="All in: rent and living">
            <Input inputMode="numeric" value={settings.budgetMonthlyEur} onChange={(e) => set({ budgetMonthlyEur: Number(e.target.value) || 0 })} />
          </Field>
          <Field label="Months ahead">
            <Select value={String(settings.months)} onChange={(e) => set({ months: Number(e.target.value) })} options={[12, 13, 14, 15, 16, 17, 18].map((n) => ({ value: String(n), label: `${n} months` }))} />
          </Field>
          <Field label="Proposals">
            <Select value={String(settings.results)} onChange={(e) => set({ results: Number(e.target.value) })} options={[3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))} />
          </Field>
        </div>
      </section>

      <section className="solve-block" aria-labelledby="solve-prefs">
        <h3 id="solve-prefs" className="solve-h">
          Preferences
        </h3>
        {settings.preferences.map((p, i) => (
          <div key={p.id} className="solve-pref">
            <div className="solve-pref-head">
              <span className="solve-pref-title">{preferenceLabel(p)}</span>
              <IconButton label="Remove preference" size="sm" variant="ghost" icon={<IconTrash size={14} />} onClick={() => set({ preferences: settings.preferences.filter((_, k2) => k2 !== i) })} />
            </div>
            <div className="solve-row">
              {p.kind === "region" && (
                <Field label="Region">
                  <Select size="sm" value={p.region} onChange={(e) => setPref(i, { ...p, region: e.target.value })} options={regionOptions()} />
                </Field>
              )}
              {p.kind === "coast" && (
                <Field label="Within km of the sea">
                  <Input size="sm" inputMode="numeric" value={p.maxKm} onChange={(e) => setPref(i, { ...p, maxKm: Number(e.target.value) || 0 })} />
                </Field>
              )}
              {p.kind !== "long-haul" ? (
                <>
                  <Field label="From">
                    <Select size="sm" value={String(p.months.start)} onChange={(e) => setPref(i, { ...p, months: { ...p.months, start: Number(e.target.value) } })} options={monthOptions} />
                  </Field>
                  <Field label="To">
                    <Select size="sm" value={String(p.months.end)} onChange={(e) => setPref(i, { ...p, months: { ...p.months, end: Number(e.target.value) } })} options={monthOptions} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="At most per quarter">
                    <Input size="sm" inputMode="numeric" value={p.maxPerQuarter} onChange={(e) => setPref(i, { ...p, maxPerQuarter: Number(e.target.value) || 0 })} />
                  </Field>
                  <Field label="Long-haul from (hours)">
                    <Input size="sm" inputMode="numeric" value={p.minHours} onChange={(e) => setPref(i, { ...p, minHours: Number(e.target.value) || 1 })} />
                  </Field>
                </>
              )}
            </div>
            <Slider label="How much it matters" value={p.weight} onChange={(w) => setPref(i, { ...p, weight: w })} />
          </div>
        ))}
        <div className="solve-chips">
          <Chip icon={<IconPlus size={12} />} onClick={() => set({ preferences: [...settings.preferences, { id: newId(), kind: "region", region: "southeast-asia", months: { start: 11, end: 2 }, weight: 0.8 }] })}>
            Somewhere in a region
          </Chip>
          <Chip icon={<IconPlus size={12} />} onClick={() => set({ preferences: [...settings.preferences, { id: newId(), kind: "coast", maxKm: 10, months: { start: 6, end: 8 }, weight: 0.6 }] })}>
            By the sea
          </Chip>
          <Chip icon={<IconPlus size={12} />} onClick={() => set({ preferences: [...settings.preferences, { id: newId(), kind: "long-haul", maxPerQuarter: 1, minHours: 6, weight: 0.6 }] })}>
            Limit long-haul
          </Chip>
        </div>
      </section>

      <Disclosure summary="Weights">
        <div className="solve-weights">
          {(Object.keys(WEIGHT_LABEL) as (keyof Weights)[]).map((key) => (
            <Slider key={key} label={WEIGHT_LABEL[key].label} hint={WEIGHT_LABEL[key].hint} value={settings.weights[key]} onChange={(v) => set({ weights: { ...settings.weights, [key]: v } })} />
          ))}
        </div>
      </Disclosure>

      <Disclosure summary="Rules">
        <div className="solve-rules">
          <Check checked={k.schengen} onChange={(v) => setK({ schengen: v })}>
            Schengen 90 days in any 180 <span className="solve-fine">(off if you hold an EU, EEA or Swiss passport)</span>
          </Check>
          <Check checked={k.avoidIsHard} onChange={(v) => setK({ avoidIsHard: v })}>
            Never place a stay in months you avoid
          </Check>
          <Check checked={k.allowBorderRuns} onChange={(v) => setK({ allowBorderRuns: v })}>
            Allow border runs to restart a per-entry limit
          </Check>
          <div className="solve-row">
            <Field label="Tax days a year" optional hint="Blank to ignore">
              <Input size="sm" inputMode="numeric" value={k.taxDays ?? ""} onChange={(e) => setK({ taxDays: numOrNull(e.target.value) })} />
            </Field>
            <Field label="Internet floor, Mbps" optional>
              <Input size="sm" inputMode="numeric" value={k.minInternetMbps ?? ""} onChange={(e) => setK({ minInternetMbps: numOrNull(e.target.value) })} />
            </Field>
            <Field label="Healthcare floor, 0–100" optional hint="WHO coverage index">
              <Input size="sm" inputMode="numeric" value={k.minHealthUhc ?? ""} onChange={(e) => setK({ minHealthUhc: numOrNull(e.target.value) })} />
            </Field>
          </div>
          <p className="solve-fine">Country limits you know of for your passport. Meridian has no visa database: enter the rule as you have it.</p>
          {k.countryRules.map((r, i) => (
            <div key={i} className={cx("solve-row", "solve-rule")}>
              <Field label="Country">
                <Input size="sm" value={r.country} onChange={(e) => setK({ countryRules: k.countryRules.map((x, j) => (j === i ? { ...x, country: e.target.value } : x)) })} />
              </Field>
              <Field label="Days per entry" optional>
                <Input size="sm" inputMode="numeric" value={r.maxDaysPerEntry ?? ""} onChange={(e) => setK({ countryRules: k.countryRules.map((x, j) => (j === i ? { ...x, maxDaysPerEntry: numOrUndef(e.target.value) } : x)) })} />
              </Field>
              <Field label="Days in window" optional hint="e.g. 90 in 180">
                <Input
                  size="sm"
                  value={r.maxDaysIn ? `${r.maxDaysIn.days} in ${r.maxDaysIn.windowDays}` : ""}
                  placeholder="90 in 180"
                  onChange={(e) => {
                    const m = e.target.value.match(/(\d+)\D+(\d+)/);
                    setK({ countryRules: k.countryRules.map((x, j) => (j === i ? { ...x, maxDaysIn: m ? { days: Number(m[1]), windowDays: Number(m[2]) } : undefined } : x)) });
                  }}
                />
              </Field>
              <IconButton label="Remove rule" size="sm" variant="ghost" icon={<IconTrash size={14} />} onClick={() => setK({ countryRules: k.countryRules.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<IconPlus size={14} />} onClick={() => setK({ countryRules: [...k.countryRules, { country: "", maxDaysPerEntry: 60 }] })}>
            Add a country limit
          </Button>
        </div>
      </Disclosure>
    </div>
  );
}
