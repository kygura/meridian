import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CitySearch, Dialog, ErrorState, Field, Input, SectionHeader, Spinner, toast } from "../../../ui";
import { IconSparkle } from "../../../ui/icons";
import { useMeridianStore } from "../../../store";
import { hubsFromCities, landmassFromCities } from "../../../lib/tripPlan";
import { formatShortDate, rotationLegs, type PlaceProfile, type RotationStay } from "../../../lib/rotation";
import { acceptRotation, evaluateRotation, getSolverSettings, saveSolverSettings, solveRotation, type SolveResponse } from "../../../lib/solverApi";
import { planOf, proposalAsStays, replacedByAccept, runId, swapStay } from "../../../lib/solver/view";
import type { ProposedRotation } from "../../../lib/solver/types";
import type { SolverSettings } from "../../../lib/solver/settings";
import { RotationMap } from "../RotationMap";
import { SetupForm } from "./SetupForm";
import { CompareTimeline } from "./CompareTimeline";
import { ProposalCard } from "./ProposalCard";
import "./solve.css";

export interface SolvePanelProps {
  stays: RotationStay[];
  places: PlaceProfile[];
  today: string;
  /** The rotation knows where the owner is on the start day (or a home airport). */
  hasStart: boolean;
  onAccepted: () => void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The Solve flow (ADR 0015): pick a pool, budget, preferences and weights; see 3–5
 * proposed rotations side by side with their score breakdown; lock a stay and re-solve,
 * swap a stay for an alternative, and make one the rotation.
 */
export function SolvePanel({ stays, places, today, hasStart, onAccepted }: SolvePanelProps) {
  const cities = useMeridianStore((s) => s.cities);
  const [settings, setSettings] = useState<SolverSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [start, setStart] = useState(today);
  const [fromCityId, setFromCityId] = useState<string | undefined>();
  const [news, setNews] = useState(false);
  const [result, setResult] = useState<SolveResponse | null>(null);
  const [proposals, setProposals] = useState<ProposedRotation[]>([]);
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [pins, setPins] = useState<Map<string, { id: string; cityId: string; start: string; end: string; kind: "base" | "pass-through" }>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSolverSettings()
      .then(setSettings)
      .catch((e) => setLoadError(errorText(e)));
  }, []);

  const hubs = useMemo(() => hubsFromCities(cities), [cities]);
  const landmassOf = useMemo(() => landmassFromCities(cities), [cities]);
  const placeMap = useMemo(() => new Map((result?.places ?? []).map((p) => [p.cityId, p])), [result]);
  const shown = proposals[selected];
  const mapStays = useMemo(() => (shown ? proposalAsStays(shown, placeMap) : []), [shown, placeMap]);
  const mapLegs = useMemo(() => rotationLegs(mapStays, hubs, landmassOf), [mapStays, hubs, landmassOf]);

  if (loadError) return <ErrorState message={loadError} onRetry={() => location.reload()} />;
  if (!settings) return <Spinner label="Loading the solver" />;

  const request = (pinList = [...pins.values()]) => ({ settings, start, fromCityId, pins: pinList, news });

  const runSolve = async (pinList = [...pins.values()]) => {
    setBusy(true);
    setError(null);
    try {
      void saveSolverSettings(settings).catch(() => {});
      const r = await solveRotation(request(pinList));
      setResult(r);
      if (!r.ok) {
        setProposals([]);
        setError(r.error ?? "No legal rotation found.");
      } else {
        setProposals(r.proposals);
        setEdited(new Set());
        setSelected(0);
        // Below the one-column breakpoint the results sit under a long form.
        if (window.matchMedia("(max-width: 1099px)").matches) requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleLock = (stayId: string) => {
    const next = new Map(pins);
    if (next.has(stayId)) next.delete(stayId);
    else {
      const s = shown?.stays.find((x) => x.id === stayId) ?? proposals.flatMap((p) => p.stays).find((x) => x.id === stayId);
      if (!s) return;
      next.set(stayId, { id: stayId, cityId: s.cityId, start: s.start, end: s.end, kind: s.kind });
    }
    setPins(next);
    void runSolve([...next.values()]);
  };

  const swap = async (i: number, stayId: string, cityId: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await evaluateRotation({ ...request(), plan: swapStay(proposals[i], stayId, cityId) });
      if (r.rotation.violations.length) {
        toast(`That swap breaks a rule: ${r.rotation.violations[0]}`, { tone: "danger" });
        return;
      }
      const next = proposals.slice();
      next[i] = { ...r.rotation, id: proposals[i].id, rank: proposals[i].rank, differsFromBest: proposals[i].differsFromBest };
      setProposals(next);
      setEdited(new Set(edited).add(proposals[i].id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const accept = async (i: number) => {
    setBusy(true);
    try {
      const r = await acceptRotation(planOf(proposals[i]), runId());
      toast(`Rotation updated: ${r.added.length} ${r.added.length === 1 ? "stay" : "stays"} planned${r.removed.length ? `, ${r.removed.length} replaced` : ""}`, { tone: "success" });
      setConfirm(null);
      onAccepted();
    } catch (e) {
      toast(errorText(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const replaced = confirm !== null ? replacedByAccept(stays, planOf(proposals[confirm]), today) : [];
  const horizon = result?.horizon;

  return (
    <div className="solve">
      <Card className="solve-config" padding="md">
        <div className="solve-row">
          <Field label="Start">
            <Input type="date" value={start} min={today} onChange={(e) => setStart(e.target.value || today)} />
          </Field>
          {!hasStart && (
            <Field label="Where you'll be" hint="Your rotation doesn't say yet">
              <CitySearch size="sm" onPick={(c) => setFromCityId(c.id)} placeholder="City" clearOnPick={false} />
            </Field>
          )}
        </div>
        <SetupForm settings={settings} onChange={setSettings} stays={stays} places={places} />
        <label className="solve-check">
          <input type="checkbox" checked={news} onChange={(e) => setNews(e.target.checked)} />
          <span>
            Check each place's news for issues <span className="solve-fine">(slower; places that can't be checked use the curated list only)</span>
          </span>
        </label>
        <div className="solve-actions">
          <Button variant="primary" icon={<IconSparkle size={16} />} loading={busy} disabled={!settings.pool.length || (!hasStart && !fromCityId)} onClick={() => void runSolve()}>
            {proposals.length ? "Solve again" : "Solve"}
          </Button>
          {pins.size > 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                setPins(new Map());
                void runSolve([]);
              }}
            >
              Clear {pins.size} {pins.size === 1 ? "lock" : "locks"}
            </Button>
          )}
        </div>
      </Card>

      <div className="solve-results" aria-live="polite" ref={resultsRef}>
        {error && <p className="rotation-error">{error}</p>}
        {busy && !proposals.length && <Spinner label="Solving" />}
        {!busy && !proposals.length && !error && (
          <p className="rotation-p rotation-muted">
            Proposals appear here. Locked, booked and current stays stay where they are; everything else is placed around them. Nothing changes in your rotation until you pick one.
          </p>
        )}
        {proposals.length > 0 && horizon && (
          <>
            <SectionHeader
              id="solve-cmp"
              title="Side by side"
              meta={`${formatShortDate(horizon.start)} – ${formatShortDate(horizon.end)}${result ? ` · solved in ${Math.max(1, Math.round(result.stats.ms))} ms` : ""}`}
            />
            <CompareTimeline from={horizon.start} to={horizon.end} proposals={proposals} selected={selected} onSelect={setSelected} />
            {result && result.notes.length > 0 && (
              <ul className="solve-notes" aria-label="Data notes">
                {result.notes.map((n, k) => (
                  <li key={k}>{n}</li>
                ))}
              </ul>
            )}
            <Card padding="none" className="rotation-map-card solve-map">
              <RotationMap stays={mapStays} legs={mapLegs} hubs={hubs} currentId={null} />
            </Card>
            <div className="solve-cards">
              {proposals.map((p, i) => (
                <ProposalCard
                  key={p.id}
                  index={i}
                  proposal={p}
                  selected={i === selected}
                  edited={edited.has(p.id)}
                  busy={busy}
                  locked={new Set(pins.keys())}
                  onSelect={() => setSelected(i)}
                  onToggleLock={toggleLock}
                  onSwap={(stayId, cityId) => void swap(i, stayId, cityId)}
                  onAccept={() => setConfirm(i)}
                />
              ))}
            </div>
            {result && <p className="solve-fine">{result.method}</p>}
          </>
        )}
      </div>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={`Make option ${(confirm ?? 0) + 1} your rotation?`}
        description="Its stays are added as planned. Locked, booked and current stays are not touched."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => confirm !== null && void accept(confirm)}>
              Make it my rotation
            </Button>
          </>
        }
      >
        {replaced.length ? (
          <>
            <p className="rotation-p">These stays are replaced:</p>
            <ul className="solve-replaced">
              {replaced.map((s) => (
                <li key={s.id}>
                  {s.place.name}
                  {s.start && s.end ? ` · ${formatShortDate(s.start)} – ${formatShortDate(s.end)}` : ""}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="rotation-p">No existing stay is replaced.</p>
        )}
      </Dialog>
    </div>
  );
}
