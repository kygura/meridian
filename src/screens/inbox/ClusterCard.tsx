import { useState } from "react";
import { Badge, Button, Card, Dialog } from "../../ui";
import { IconCheck } from "../../ui/icons";
import { isUnresolved } from "../../lib/inbox";
import type { CityIndex } from "../../lib/journal";
import type { ImportCandidate, ImportCluster, Journey } from "../../types";
import CandidateRow, { type CandidateActions } from "./CandidateRow";
import MergeMenu from "./MergeMenu";
import { count, dateRange } from "./inboxText";

/** One suggested trip: its items and the whole-card actions (accept, add to an existing trip, discard). */
export default function ClusterCard({
  cluster,
  members,
  cities,
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
  journeys: Journey[];
  busyIds: Set<string>;
  actions: CandidateActions;
  onAccept: () => void;
  onMerge: (journeyId: string) => void;
  onDiscardAll: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const busy = busyIds.has(cluster.id);
  const unresolved = members.filter(isUnresolved).length;
  const blocked = busy || unresolved > 0 || members.length === 0;
  const blockedWhy = unresolved > 0 ? `Pick the city for ${count(unresolved, "item")} first` : undefined;
  const titleId = `inbox-cl-${cluster.id}`;
  const suggestedId = members.find((m) => m.suggestedJourneyId)?.suggestedJourneyId;
  const chain = cluster.cityIds.map((id) => cities.get(id)?.name ?? id).join(" → ");

  return (
    <Card padding="none" className="inbox-cluster" aria-labelledby={titleId} aria-busy={busy || undefined} role="region">
      <header className="inbox-cluster-head">
        <div className="inbox-cluster-titles">
          <h2 className="inbox-cluster-title" id={titleId}>
            {cluster.title}
          </h2>
          <p className="inbox-cluster-meta">
            <span className="num">{dateRange(cluster.startDate, cluster.endDate)}</span>
            {chain && <span>{chain}</span>}
            <span>{count(members.length, "item")}</span>
          </p>
        </div>
        {cluster.lowConfidence && <Badge tone="warning">Low confidence</Badge>}
      </header>

      <ul className="inbox-cand-list">
        {members.map((c) => (
          <CandidateRow key={c.id} candidate={c} cities={cities} journeys={journeys} range={cluster} busy={!busy && busyIds.has(c.id)} disabled={busy} actions={actions} />
        ))}
      </ul>

      <footer className="inbox-cluster-foot">
        {blockedWhy && <p className="inbox-cluster-why">{blockedWhy}</p>}
        <div className="inbox-cluster-actions">
          <Button size="sm" variant="ghost" className="inbox-discard" disabled={busy || members.length === 0} onClick={() => setConfirm(true)}>
            Discard all
          </Button>
          <MergeMenu
            trigger="button"
            label="Add these items to an existing trip"
            journeys={journeys}
            cities={cities}
            range={cluster}
            suggestedId={suggestedId}
            items={members.length}
            disabled={blocked}
            disabledWhy={blockedWhy}
            onConfirm={onMerge}
          />
          <Button size="sm" icon={<IconCheck size={16} />} loading={busy} disabled={blocked} title={blockedWhy} onClick={onAccept}>
            Accept as trip
          </Button>
        </div>
      </footer>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        role="alertdialog"
        title={`Discard ${count(members.length, "item")}?`}
        description="They leave the inbox and won't be imported again."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false);
                onDiscardAll();
              }}
            >
              Discard
            </Button>
          </>
        }
      />
    </Card>
  );
}
