import { useState } from "react";
import CitySearchInput from "../seasonality/CitySearchInput";
import ProvenanceChip from "./ProvenanceChip";
import MergePicker from "./MergePicker";
import { candidateSummary, cityFixes, flagTexts, isUnresolved, kindGlyph, kindLabel } from "../../lib/inbox";
import type { CityIndex } from "../../lib/journal";
import type { City, ImportCandidate, Journey } from "../../types";

export interface CandidateActions {
  accept: (id: string) => void;
  merge: (id: string, journeyId: string) => void;
  discard: (id: string) => void;
  resolve: (id: string, fix: { cityId?: string; fromCityId?: string; toCityId?: string }) => void;
}

/** One pending item: kind, summary, provenance, flags, row actions, and the inline city resolver (DESIGN-journal §8). */
export default function CandidateRow({
  candidate: c,
  cities,
  cityList,
  journeys,
  range,
  busy,
  actions,
}: {
  candidate: ImportCandidate;
  cities: CityIndex;
  cityList: City[];
  journeys: Journey[];
  range: { startDate: string; endDate: string };
  busy: boolean;
  actions: CandidateActions;
}) {
  const [merging, setMerging] = useState(false);
  const summary = candidateSummary(c, cities);
  const unresolved = isUnresolved(c);
  const fixes = unresolved ? cityFixes(c) : [];
  const low = c.provenance.confidence === "low";
  const why = unresolved ? "Pick the city first" : undefined;

  return (
    <li className={`jr-cand${busy ? " busy" : ""}`} aria-busy={busy}>
      <div className="jr-cand-main">
        <span className="jr-cand-kind">
          <span aria-hidden="true">{kindGlyph(c)} </span>
          {kindLabel(c)}
        </span>
        <span className="jr-cand-sum">{summary}</span>
        <ProvenanceChip provenance={c.provenance} />
        {busy && (
          <span className="agent-brief-loading" role="status" aria-label="Working">
            <span />
            <span />
            <span />
          </span>
        )}
        <span className="jr-cand-actions">
          <span className="jr-merge-anchor">
            <button type="button" className="jr-icon-btn" aria-label={`Accept ${summary}`} title={why ?? "Accept as its own journey"} disabled={busy || unresolved} onClick={() => actions.accept(c.id)}>
              ✓
            </button>
            <button type="button" className="jr-icon-btn" aria-label={`Merge ${summary} into a journey`} aria-expanded={merging} title={why ?? "Merge into an existing journey"} disabled={busy || unresolved} onClick={() => setMerging((v) => !v)}>
              ⇢
            </button>
            {merging && (
              <MergePicker
                journeys={journeys}
                cities={cities}
                range={range}
                suggestedId={c.suggestedJourneyId}
                count={1}
                onClose={() => setMerging(false)}
                onConfirm={(id) => {
                  setMerging(false);
                  actions.merge(c.id, id);
                }}
              />
            )}
          </span>
          <button type="button" className="jr-icon-btn jr-icon-warn" aria-label={`Discard ${summary}`} title="Discard" disabled={busy} onClick={() => actions.discard(c.id)}>
            ✕
          </button>
        </span>
      </div>
      {(c.flags?.length || low) && (
        <div className="jr-cand-flags">
          {flagTexts(c).map((t) => (
            <span key={t} className="jr-flag">
              ⚠ {t}
            </span>
          ))}
          {low && !unresolved && <span className="jr-flag">⚠ LOW CONFIDENCE</span>}
        </div>
      )}
      {fixes.length > 0 && (
        <div className="jr-cand-fix">
          {fixes.map((f) => (
            <div key={f.field} className="jr-fix-row">
              <span className="jr-hint label">
                {f.field === "fromCityId" ? "FROM" : f.field === "toCityId" ? "TO" : "CITY"} “{f.hint}”
              </span>
              <CitySearchInput cities={cityList} placeholder={`Pick the city for “${f.hint}”`} onPick={(city) => actions.resolve(c.id, { [f.field]: city.id })} />
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
