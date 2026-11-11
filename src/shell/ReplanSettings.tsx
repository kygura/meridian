import { useEffect, useState } from "react";
import { Button, Disclosure, Field, Input, Select, toast, useJournalToken } from "../ui";
import { getSolverSettings, runReplanNow, saveSolverSettings } from "../lib/solverApi";
import type { ReplanSettings, SolverSettings } from "../lib/solver/settings";
import "./replan.css";

/** Settings › Re-planning: the thresholds the daily re-plan check uses (ADR 0015). */
export function ReplanSettingsSection() {
  const { unlocked } = useJournalToken();
  const [settings, setSettings] = useState<SolverSettings | null>(null);
  const [busy, setBusy] = useState<"save" | "run" | null>(null);

  useEffect(() => {
    if (unlocked) getSolverSettings().then(setSettings).catch(() => setSettings(null));
  }, [unlocked]);

  if (!unlocked || !settings) return null;
  const r = settings.replan;
  const set = (patch: Partial<ReplanSettings>) => setSettings({ ...settings, replan: { ...r, ...patch } });
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);

  const save = async () => {
    setBusy("save");
    try {
      setSettings(await saveSolverSettings(settings));
      toast("Re-planning thresholds saved", { tone: "success" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  const run = async () => {
    setBusy("run");
    try {
      const rep = await runReplanNow();
      toast(rep.proposals ? "A new plan B is waiting on the Rotation screen" : `Checked: nothing crossed a threshold${rep.notes.length ? `. ${rep.notes[0]}` : ""}`, { tone: rep.proposals ? "warning" : "neutral" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't run the check", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="shell-settings-section">
      <h3 className="shell-settings-heading">Re-planning</h3>
      <p className="shell-settings-hint">Each day Meridian watches where you are and your next stays, and proposes a plan B when something shifts. Nothing changes until you accept it.</p>
      <label className="shell-replan-check">
        <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>Check every day</span>
      </label>
      <Disclosure summary="Thresholds">
        <div className="shell-replan-grid">
          <Field label="Stays ahead">
            <Select size="sm" value={String(r.watchAhead)} onChange={(e) => set({ watchAhead: Number(e.target.value) })} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))} />
          </Field>
          <Field label="News from">
            <Select
              size="sm"
              value={r.newsMinLevel}
              onChange={(e) => set({ newsMinLevel: e.target.value as ReplanSettings["newsMinLevel"] })}
              options={[
                { value: "any", label: "Any issue or flag" },
                { value: "incident", label: "Incidents" },
                { value: "systemic", label: "Patterns only" },
              ]}
            />
          </Field>
          <Field label="Air, PM2.5 over normal" hint="µg/m³">
            <Input size="sm" inputMode="numeric" value={r.pm25Over} onChange={(e) => set({ pm25Over: num(e.target.value, r.pm25Over) })} />
          </Field>
          <Field label="Temperature, ±°C">
            <Input size="sm" inputMode="numeric" value={r.tempDeltaC} onChange={(e) => set({ tempDeltaC: num(e.target.value, r.tempDeltaC) })} />
          </Field>
          <Field label="Fare change, %">
            <Input size="sm" inputMode="numeric" value={r.flightChangePct} onChange={(e) => set({ flightChangePct: num(e.target.value, r.flightChangePct) })} />
          </Field>
          <Field label="Book-by notice, days">
            <Input size="sm" inputMode="numeric" value={r.bookByNoticeDays} onChange={(e) => set({ bookByNoticeDays: num(e.target.value, r.bookByNoticeDays) })} />
          </Field>
          <Field label="Hysteresis, %" hint="Margin past a threshold">
            <Input size="sm" inputMode="numeric" value={r.hysteresisPct} onChange={(e) => set({ hysteresisPct: num(e.target.value, r.hysteresisPct) })} />
          </Field>
          <Field label="Quiet for, days" hint="Before the same shift alerts again">
            <Input size="sm" inputMode="numeric" value={r.cooldownDays} onChange={(e) => set({ cooldownDays: num(e.target.value, r.cooldownDays) })} />
          </Field>
        </div>
      </Disclosure>
      <div className="shell-settings-row shell-settings-row--wrap">
        <Button size="sm" variant="primary" loading={busy === "save"} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" loading={busy === "run"} onClick={() => void run()}>
          Check now
        </Button>
      </div>
    </section>
  );
}
