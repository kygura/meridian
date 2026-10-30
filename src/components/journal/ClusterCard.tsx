import { useState } from "react";
import CandidateRow, { type CandidateActions } from "./CandidateRow";
import MergePicker from "./MergePicker";
import { clusterChain, clusterDates, isUnresolved } from "../../lib/inbox";
import { plural, type CityIndex } from "../../lib/journal";
import type { City, ImportCandidate, ImportCluster, Journey } from "../../types";

/** One suggested journey with its candidates and the whole-card actions (DESIGN-journal §8). */
export default function ClusterCard({
  cluster,
  members,
  cities,
  cityList,
  journeys,
  busyIds,
  actions,
  onAccept,
  onMerge,
  onDiscardAll,
}: {
  cluster: ImportCluster;
  members: ImportCandidate[];
  cities: CityIndex;
  cityList: City[];
  journeys: Journey[];
  busyIds: Set<string>;
  actions: CandidateActions;
  onAccept: () => void;
  onMerge: (journeyId: string) => void;
  onDiscardAll: () => void;
}) {
  const [merging, setMerging] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const busy = busyIds.has(cluster.id);
  const unresolved = members.filter(isUnresolved).length;
  const blocked = busy || unresolved > 0 || members.length === 0;
  const blockedWhy = unresolved > 0 ? `Pick the ${unresolved === 1 ? "city" : "cities"} for the ${unresolved === 1 ? "flagged item" : `${unresolved} flagged items`} first` : undefined;
  const titleId = `jr-cl-${cluster.id}`;
  const suggestedId = members.find((m) => m.suggestedJourneyId)?.suggestedJourneyId;

  return (
    <section className={`jr-cluster${cluster.lowConfidence ? " low" : ""}`} aria-labelledby={titleId} aria-busy={busy}>
      <header className="jr-cluster-head">
        <span className="jr-cluster-dates">{clusterDates(cluster.startDate, cluster.endDate)}</span>
        <h2 className="jr-cluster-title" id={titleId}>
          {cluster.title}
        </h2>
        {cluster.cityIds.length > 0 && <span className="jr-cluster-chain">{clusterChain(cluster, cities)}</span>}
        <span className="jr-cluster-n">{plural(members.length, "ITEM")}</span>
        {cluster.lowConfidence && (
          <span className="bk-badge jr-chip low" role="img" aria-label="Low confidence suggestion">
            LOW CONFIDENCE
          </span>
        )}
      </header>

      <ul className="jr-cand-list">
        {members.map((c) => (
          <CandidateRow key={c.id} candidate={c} cities={cities} cityList={cityList} journeys={journeys} range={cluster} busy={busyIds.has(c.id)} actions={actions} />
        ))}
      </ul>

      <footer className="jr-cluster-foot">
        <button type="button" className="booking-primary-btn" disabled={blocked} title={blockedWhy} onClick={onAccept}>
          {busy ? "WORKING…" : "ACCEPT AS JOURNEY"}
        </button>
        <span className="jr-merge-anchor">
          <button type="button" className="tm-action-btn" aria-expanded={merging} disabled={blocked} title={blockedWhy} onClick={() => setMerging((v) => !v)}>
            MERGE INTO…
          </button>
          {merging && (
            <MergePicker
              journeys={journeys}
              cities={cities}
              range={cluster}
              suggestedId={suggestedId}
              count={members.length}
              onClose={() => setMerging(false)}
              onConfirm={(id) => {
                setMerging(false);
                onMerge(id);
              }}
            />
          )}
        </span>
        {confirmDiscard ? (
          <>
            <button
              type="button"
              className="tm-action-btn tm-delete-btn tm-delete-confirm"
              disabled={busy}
              autoFocus
              onClick={() => {
                setConfirmDiscard(false);
                onDiscardAll();
              }}
            >
              CONFIRM DISCARD
            </button>
            <button type="button" className="tm-action-btn" onClick={() => setConfirmDiscard(false)}>
              KEEP
            </button>
          </>
        ) : (
          <button type="button" className="tm-action-btn tm-delete-btn" disabled={busy || members.length === 0} onClick={() => setConfirmDiscard(true)}>
            DISCARD ALL
          </button>
        )}
        {unresolved > 0 && <span className="jr-flag">⚠ PICK {unresolved === 1 ? "THE CITY" : "THE CITIES"} FOR {plural(unresolved, "FLAGGED ITEM")} FIRST</span>}
      </footer>
    </section>
  );
}
