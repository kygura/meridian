import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Disclosure, SectionHeader, Stat, toast } from "../../../ui";
import { IconExternal, IconRefresh } from "../../../ui/icons";
import { formatShortDate } from "../../../lib/rotation";
import { decideProposal, listProposals, runReplanNow } from "../../../lib/solverApi";
import type { Proposal, StayChange } from "../../../lib/solver/settings";
import "./solve.css";

const CHANGE_LABEL: Record<StayChange["kind"], string> = { added: "Add", removed: "Drop", moved: "Move", unchanged: "Keep" };

const fmt = (n: number | null, unit: "€" | "$" | "" = "") => (n === null ? "—" : `${unit}${Math.round(n).toLocaleString("en-US")}`);
const range = (r?: { start: string; end: string }) => (r ? `${formatShortDate(r.start)} – ${formatShortDate(r.end)}` : "");

function Impact({ label, before, after, unit, hint }: { label: string; before: number | null; after: number | null; unit?: "€" | "$" | ""; hint?: string }) {
  return <Stat label={label} value={`${fmt(before, unit)} → ${fmt(after, unit)}`} hint={hint} />;
}

/**
 * Re-plan Proposals (ADR 0015): what shifted, the evidence and its sources, and plan B as
 * a diff against the active rotation. Accept applies it; dismiss and snooze change nothing.
 */
export function ReplanProposals({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    listProposals()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  const open = (items ?? []).filter((p) => p.status === "open");
  const snoozed = (items ?? []).filter((p) => p.status === "snoozed");

  const act = async (p: Proposal, action: "accept" | "dismiss" | "snooze") => {
    setBusy(`${p.id}:${action}`);
    try {
      await decideProposal(p.id, action, action === "snooze" ? 7 : undefined);
      toast(action === "accept" ? "Plan B is now your rotation" : action === "dismiss" ? "Dismissed" : "Snoozed for a week", { tone: action === "accept" ? "success" : "neutral" });
      load();
      if (action === "accept") onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't do that", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    try {
      const r = await runReplanNow();
      toast(r.proposals ? "Something shifted: plan B below" : `Nothing crossed a threshold${r.notes[0] ? `. ${r.notes[0]}` : ""}`, { tone: r.proposals ? "warning" : "neutral" });
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't run the check", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  if (items === null) return null;

  return (
    <section className="rotation-section replan" aria-labelledby="rot-replan">
      <SectionHeader
        id="rot-replan"
        title="Re-plan"
        meta={open.length ? `${open.length} waiting` : snoozed.length ? `${snoozed.length} snoozed` : "Nothing waiting"}
        actions={
          <Button size="sm" variant="ghost" icon={<IconRefresh size={14} />} loading={busy === "check"} onClick={() => void check()}>
            Check now
          </Button>
        }
      />
      {!open.length ? (
        <p className="rotation-p rotation-muted">Each day Meridian watches where you are and your next stays for news, fares, air and weather against normal, day counts and booking deadlines. A plan B shows up here when something crosses a threshold.</p>
      ) : (
        <ul className="replan-list">
          {open.map((p) => (
            <li key={p.id}>
              <Card padding="sm" className="replan-item">
                <div className="replan-head">
                  <span className="replan-title">{p.shifts.map((s) => s.title).join(" · ")}</span>
                  <span className="rotation-fine num">{formatShortDate(p.createdAt.slice(0, 10))}</span>
                </div>
                <Disclosure summary={`Evidence (${p.shifts.reduce((a, s) => a + s.evidence.length, 0)})`}>
                  <ul className="replan-evidence">
                    {p.shifts.flatMap((s) =>
                      s.evidence.map((e, k) => (
                        <li key={`${s.key}-${k}`}>
                          {e.label}
                          {e.value ? <span className="num">: {e.value}</span> : null} <span className="rotation-muted">({e.source})</span>{" "}
                          {e.url && (
                            <a href={e.url} target="_blank" rel="noopener noreferrer" aria-label="Open the source">
                              <IconExternal size={12} />
                            </a>
                          )}
                        </li>
                      ))
                    )}
                  </ul>
                </Disclosure>
                {p.planB && p.diff ? (
                  <>
                    <ul className="replan-diff" aria-label="Plan B against your rotation">
                      {p.diff.stays
                        .filter((c) => c.kind !== "unchanged")
                        .map((c, k) => (
                          <li key={k}>
                            <Badge tone={c.kind === "added" ? "success" : c.kind === "removed" ? "danger" : "warning"}>{CHANGE_LABEL[c.kind]}</Badge> {c.name}{" "}
                            <span className="num rotation-muted">
                              {c.kind === "moved" ? `${range(c.before)} → ${range(c.after)}` : range(c.after ?? c.before)}
                            </span>
                          </li>
                        ))}
                      {!p.diff.stays.some((c) => c.kind !== "unchanged") && <li>Plan B keeps your stays as they are.</li>}
                    </ul>
                    <div className="replan-impact">
                      <Impact label="Score" before={p.diff.scoreBefore} after={p.diff.scoreAfter} />
                      <Impact label="Cost a month" before={p.diff.costBefore} after={p.diff.costAfter} unit="€" hint="Place estimates" />
                      <Impact label="Schengen peak" before={p.diff.schengenBefore} after={p.diff.schengenAfter} hint="Days in any 180" />
                      <Impact label="Travel" before={p.diff.travelBefore} after={p.diff.travelAfter} unit="$" hint="Estimate" />
                    </div>
                  </>
                ) : (
                  <p className="rotation-p">No plan B: {p.note ?? "nothing legal fits."}</p>
                )}
                {p.planB && p.note && <p className="rotation-fine">{p.note}</p>}
                <div className="replan-actions">
                  {p.planB && (
                    <Button size="sm" variant="primary" loading={busy === `${p.id}:accept`} onClick={() => void act(p, "accept")}>
                      Accept plan B
                    </Button>
                  )}
                  <Button size="sm" loading={busy === `${p.id}:snooze`} onClick={() => void act(p, "snooze")}>
                    Snooze a week
                  </Button>
                  <Button size="sm" variant="ghost" loading={busy === `${p.id}:dismiss`} onClick={() => void act(p, "dismiss")}>
                    Dismiss
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
