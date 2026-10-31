import { CitySearch, Field, IconButton, Spinner } from "../../ui";
import { IconAlert, IconCalendar, IconCheck, IconPin, IconPlane, IconStar, IconTrash } from "../../ui/icons";
import { cityFixes, isUnresolved } from "../../lib/inbox";
import type { CityIndex } from "../../lib/journal";
import type { ImportCandidate, Journey } from "../../types";
import MergeMenu from "./MergeMenu";
import { candidateTitle, candidateWhen, fixLabel, flagNotes, kindWord, sourceWord } from "./inboxText";

export interface CandidateActions {
  accept: (id: string) => void;
  merge: (id: string, journeyId: string) => void;
  discard: (id: string) => void;
  resolve: (id: string, fix: { cityId?: string; fromCityId?: string; toCityId?: string }) => void;
}

function KindIcon({ c }: { c: ImportCandidate }) {
  if (c.kind === "segment") return <IconPlane size={18} />;
  if (c.kind === "lodging") return <IconCalendar size={18} />;
  if (c.kind === "experience") return <IconStar size={18} />;
  return <IconPin size={18} />;
}

/** One pending item: what it is, when, where it came from, review notes, actions and the inline city picker. */
export default function CandidateRow({
  candidate: c,
  cities,
  journeys,
  range,
  busy,
  disabled = false,
  actions,
}: {
  candidate: ImportCandidate;
  cities: CityIndex;
  journeys: Journey[];
  range: { startDate: string; endDate: string };
  busy: boolean;
  /** The whole card is working: keep the row calm (no spinner) but not clickable. */
  disabled?: boolean;
  actions: CandidateActions;
}) {
  const title = candidateTitle(c, cities);
  const when = candidateWhen(c);
  const unresolved = isUnresolved(c);
  const fixes = unresolved ? cityFixes(c, cities) : [];
  const notes = flagNotes(c, cities);
  const why = unresolved ? "Pick the city first" : undefined;
  const meta = [kindWord(c), when, sourceWord(c.provenance)].filter(Boolean).join(" · ");

  return (
    <li className="inbox-cand" aria-busy={busy || undefined}>
      <div className="inbox-cand-row">
        <span className="inbox-cand-icon" aria-hidden="true">
          <KindIcon c={c} />
        </span>
        <div className="inbox-cand-main">
          <p className="inbox-cand-title">{title}</p>
          <p className="inbox-cand-meta">{meta}</p>
          {notes.length > 0 && (
            <ul className="inbox-cand-notes">
              {notes.map((t) => (
                <li key={t}>
                  <IconAlert size={14} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="inbox-cand-actions">
          {busy ? (
            <Spinner size={18} label="Working" />
          ) : (
            <>
              <IconButton size="sm" label={`Accept ${title} as its own trip`} title={why ?? "Accept as its own trip"} icon={<IconCheck size={18} />} disabled={disabled || unresolved} onClick={() => actions.accept(c.id)} />
              <MergeMenu
                trigger="icon"
                label={`Add ${title} to an existing trip`}
                journeys={journeys}
                cities={cities}
                range={range}
                suggestedId={c.suggestedJourneyId}
                items={1}
                disabled={disabled || unresolved}
                disabledWhy={why}
                onConfirm={(jid) => actions.merge(c.id, jid)}
              />
              <IconButton size="sm" label={`Discard ${title}`} title="Discard" icon={<IconTrash size={18} />} disabled={disabled} onClick={() => actions.discard(c.id)} />
            </>
          )}
        </div>
      </div>
      {fixes.length > 0 && !busy && !disabled && (
        <div className="inbox-cand-fix">
          {fixes.map((f) => (
            <Field key={f.field} label={fixLabel(f.field, f.hint)}>
              <CitySearch size="sm" placeholder="Search for the city" onPick={(city) => actions.resolve(c.id, { [f.field]: city.id })} />
            </Field>
          ))}
        </div>
      )}
    </li>
  );
}
