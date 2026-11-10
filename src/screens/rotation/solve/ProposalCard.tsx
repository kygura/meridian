import { Badge, Button, Card, Disclosure, IconButton, Select, cx } from "../../../ui";
import { IconLock, IconUnlock } from "../../../ui/icons";
import { FIT_LABEL, formatShortDate } from "../../../lib/rotation";
import { stayLevel } from "../../../lib/solver/view";
import type { ProposedRotation } from "../../../lib/solver/types";

const ROLE_LABEL = { base: "Base", "pass-through": "Pass-through", "border-run": "Border run", fixed: "Fixed" } as const;

export interface ProposalCardProps {
  index: number;
  proposal: ProposedRotation;
  selected: boolean;
  edited: boolean;
  busy: boolean;
  locked: Set<string>;
  onSelect: () => void;
  onToggleLock: (stayId: string) => void;
  onSwap: (stayId: string, cityId: string) => void;
  onAccept: () => void;
}

const signed = (n: number) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

/** One proposed rotation: the score and how it was made, the stays, and what can be changed. */
export function ProposalCard({ index, proposal: p, selected, edited, busy, locked, onSelect, onToggleLock, onSwap, onAccept }: ProposalCardProps) {
  const travelUsd = p.moves.reduce((a, m) => a + m.costUsd, 0);
  return (
    <Card className={cx("solve-card", selected && "solve-card--on")} padding="sm" aria-label={`Option ${index + 1}`}>
      <div className="solve-card-head">
        <button type="button" className="solve-card-title" onClick={onSelect} aria-pressed={selected}>
          Option {index + 1}
          {edited && <Badge tone="accent">Edited</Badge>}
        </button>
        <div className="solve-card-total">
          <span className="num">{p.total.toFixed(1)}</span>
          <span className="solve-fine">of 100</span>
        </div>
      </div>
      {index > 0 && <p className="solve-fine">{Math.round(p.differsFromBest * 100)}% of nights differ from option 1</p>}

      <ul className="solve-comps" aria-label="Score breakdown">
        {p.components.map((c) => (
          <li key={c.key} title={[c.detail, ...c.notes].join("\n")}>
            <span className="solve-comp-label">{c.label}</span>
            <span className="solve-comp-bar" aria-hidden="true">
              <span style={{ width: `${c.score}%` }} />
            </span>
            <span className="num solve-comp-val">{Math.round(c.score)}</span>
          </li>
        ))}
      </ul>
      <Disclosure summary="Why these scores">
        <ul className="solve-why">
          {p.components.map((c) => (
            <li key={c.key}>
              <strong>
                {c.label} {Math.round(c.score)}
              </strong>{" "}
              <span className="solve-fine">× weight {c.weight.toFixed(1)}</span>
              <div>{c.detail}</div>
              {c.notes.map((n, k) => (
                <div key={k} className="solve-fine">
                  {n}
                </div>
              ))}
            </li>
          ))}
          {p.floors.some((f) => f.unknown.length) &&
            p.floors
              .filter((f) => f.unknown.length)
              .map((f) => (
                <li key={f.label} className="solve-fine">
                  {f.label}: not measured for {f.unknown.join(", ")}, so allowed.
                </li>
              ))}
          {p.visa.notes.map((n, k) => (
            <li key={`v${k}`} className="solve-fine">
              {n}
            </li>
          ))}
        </ul>
      </Disclosure>

      <ol className="solve-stays">
        {p.stays.map((s) => {
          const level = stayLevel(s);
          const isLocked = locked.has(s.id) || s.role === "fixed";
          return (
            <li key={s.id} className="solve-stay">
              <span className={cx("rotation-swatch", `rotation-fit--${level}`)} aria-hidden="true" />
              <div className="solve-stay-main">
                <div className="solve-stay-name">
                  {s.name}
                  {s.role !== "base" && <Badge tone={s.role === "fixed" ? "success" : "neutral"}>{ROLE_LABEL[s.role]}</Badge>}
                </div>
                <div className="solve-fine num">
                  {formatShortDate(s.start)} – {formatShortDate(s.end)} · {s.nights} nights · {FIT_LABEL[level]}
                  {s.costMonthlyEur !== null ? ` · €${s.costMonthlyEur.toLocaleString("en-US")}/mo` : " · cost unknown"}
                </div>
                {s.costSource && <div className="solve-fine">{s.costSource}</div>}
                {s.notes.map((n, k) => (
                  <div key={k} className="solve-note">
                    {n}
                  </div>
                ))}
                {s.role === "base" && s.alternatives.length > 0 && (
                  <Select
                    size="sm"
                    aria-label={`Swap ${s.name} for`}
                    value=""
                    disabled={busy}
                    onChange={(e) => e.target.value && onSwap(s.id, e.target.value)}
                    options={[{ value: "", label: "Swap for…" }, ...s.alternatives.map((a) => ({ value: a.cityId, label: `${a.name} (${signed(a.delta)}: ${a.why})` }))]}
                  />
                )}
              </div>
              {(s.role === "base" || locked.has(s.id)) && (
                <IconButton
                  size="sm"
                  variant={isLocked ? "secondary" : "ghost"}
                  label={isLocked ? `Unlock ${s.name}` : `Lock ${s.name} and re-solve around it`}
                  icon={isLocked ? <IconLock size={14} /> : <IconUnlock size={14} />}
                  onClick={() => onToggleLock(s.id)}
                  disabled={busy}
                  aria-pressed={isLocked}
                />
              )}
            </li>
          );
        })}
      </ol>

      <p className="solve-fine num">
        {p.moves.length} moves · ≈ ${travelUsd.toLocaleString("en-US")} travel (estimate)
        {p.visa.schengen.enabled ? ` · Schengen peak ${p.visa.schengen.maxUsed}/90` : ""}
      </p>
      <Button variant={selected ? "primary" : "secondary"} block onClick={onAccept} disabled={busy}>
        Make this my rotation
      </Button>
    </Card>
  );
}
