import "./inbox.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, EmptyState, ErrorState, Page, PageHeader, Skeleton, UnlockCard, toast, useJournalToken } from "../../ui";
import { IconInbox, IconUpload } from "../../ui/icons";
import { useMeridianStore } from "../../store";
import { navigate } from "../../lib/router";
import {
  JournalLockedError,
  acceptCandidate,
  acceptCluster,
  discardCandidate,
  mergeCandidate,
  mergeCluster,
  refreshJourneys,
  refreshQueue,
  resolveCandidate,
} from "../../lib/journalApi";
import { cityIndex } from "../../lib/journal";
import { candidateDay, clusterMembers, looseCandidates } from "../../lib/inbox";
import type { ImportQueue } from "../../types";
import UploadPanel from "./UploadPanel";
import ClusterCard from "./ClusterCard";
import CandidateRow, { type CandidateActions } from "./CandidateRow";
import { useUploads } from "./useUploads";
import { count, errorText, queueSummary } from "./inboxText";

type Saved = { journey?: { id: string; title: string }; merged?: unknown[] };

/** #/inbox: upload imports, review what they found, accept it into the journal (DESIGN-v3 §6 Inbox). */
export default function InboxScreen() {
  const { token, unlocked } = useJournalToken();
  const picker = useRef<HTMLInputElement>(null);

  if (!unlocked) {
    return (
      <Page>
        <PageHeader kicker="Imports · review queue" title="Inbox" subtitle="Imports wait here until you review them." />
        <UnlockCard title="Sign in to review imports" />
      </Page>
    );
  }
  return <InboxBody key={token ?? ""} picker={picker} />;
}

function InboxBody({ picker }: { picker: React.RefObject<HTMLInputElement | null> }) {
  const cities = useMeridianStore((s) => s.cities);
  const journeysOrNull = useMeridianStore((s) => s.journeys);
  const journeys = useMemo(() => journeysOrNull ?? [], [journeysOrNull]);
  const cityIdx = useMemo(() => cityIndex(cities), [cities]);
  const [queue, setQueue] = useState<ImportQueue | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const q = await refreshQueue();
      if (!alive.current) return;
      setQueue(q);
      setLoadError(false);
    } catch (e) {
      if (alive.current && !(e instanceof JournalLockedError)) setLoadError(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    // The merge picker needs the journal; load it once if nobody has yet.
    if (useMeridianStore.getState().journeys === null) void refreshJourneys().catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [load]);

  const uploads = useUploads(load);

  const openJourney = (id: string) => navigate({ view: "trips", tab: "past", journeyId: id });

  /** Run a mutation, then always refetch (clusters are recomputed server-side) and clear the busy marks. */
  const act = async (ids: string[], fn: () => Promise<unknown>, ok?: (r: Saved) => void) => {
    setBusyIds((s) => new Set([...s, ...ids]));
    try {
      const r = (await fn()) as Saved;
      ok?.(r);
      void refreshJourneys().catch(() => {});
    } catch (e) {
      if (!(e instanceof JournalLockedError)) toast(errorText(e), { tone: "danger" });
    } finally {
      await load();
      if (alive.current) setBusyIds((s) => new Set([...s].filter((x) => !ids.includes(x))));
    }
  };

  const saved = (verb: string) => (r: Saved) => {
    if (!r?.journey) return;
    const { id, title } = r.journey;
    toast(`${verb} “${title}”`, { tone: "success", action: { label: "Open", onClick: () => openJourney(id) } });
  };

  const actions: CandidateActions = {
    accept: (id) => void act([id], () => acceptCandidate(id), saved("Saved as")),
    merge: (id, jid) => void act([id], () => mergeCandidate(id, jid), saved("Added to")),
    discard: (id) => void act([id], () => discardCandidate(id), () => toast("Discarded")),
    resolve: (id, fix) => void act([id], () => resolveCandidate(id, fix)),
  };

  const candidates = useMemo(() => (queue?.candidates ?? []).filter((c) => c.state === "pending"), [queue]);
  const clusters = queue?.clusters ?? [];
  const loose = queue ? looseCandidates(clusters, candidates) : [];
  const empty = queue !== null && candidates.length === 0;

  return (
    <Page>
      <PageHeader
        kicker="Imports · review queue"
        title="Inbox"
        subtitle={queue && candidates.length ? queueSummary(candidates.length, clusters.length) : "Imports wait here until you review them."}
        actions={
          <Button variant="primary" icon={<IconUpload size={18} />} disabled={uploads.busy} onClick={() => picker.current?.click()}>
            Upload files
          </Button>
        }
      />

      <div className="inbox-body">
        <UploadPanel jobs={uploads.jobs} busy={uploads.busy} onFiles={(f) => void uploads.start(f)} onCancel={uploads.cancel} onDismiss={uploads.dismiss} pickerRef={picker} />

        {loadError && !queue && <ErrorState message="Couldn't load the inbox." onRetry={() => void load()} />}

        {!queue && !loadError && (
          <div className="inbox-list" role="status" aria-label="Loading inbox">
            {[0, 1].map((i) => (
              <Card key={i} className="inbox-skel">
                <Skeleton width="40%" height={18} />
                <Skeleton width="60%" />
                <Skeleton lines={3} height={40} radius={8} />
              </Card>
            ))}
          </div>
        )}

        {empty && (
          <EmptyState
            size="page"
            icon={<IconInbox />}
            title="Nothing to review"
            description="Upload booking emails, a location history export or photos, and what they find shows up here."
            action={
              <Button onClick={() => useMeridianStore.getState().openQuickLog()}>
                Log a trip by hand
              </Button>
            }
          />
        )}

        {queue && !empty && (
          <div className="inbox-list">
            {clusters.map((cl) => {
              const members = clusterMembers(cl, candidates);
              if (!members.length) return null;
              const ids = [cl.id, ...cl.candidateIds];
              return (
                <ClusterCard
                  key={cl.id}
                  cluster={cl}
                  members={members}
                  cities={cityIdx}
                  journeys={journeys}
                  busyIds={busyIds}
                  actions={actions}
                  onAccept={() => void act(ids, () => acceptCluster(cl.id), saved("Saved as"))}
                  onMerge={(jid) => void act(ids, () => mergeCluster(cl.id, jid), saved("Added to"))}
                  onDiscardAll={() =>
                    void act(
                      ids,
                      async () => {
                        for (const id of cl.candidateIds) await discardCandidate(id);
                      },
                      () => toast(`Discarded ${count(members.length, "item")}`)
                    )
                  }
                />
              );
            })}

            {loose.length > 0 && (
              <Card padding="none" className="inbox-cluster" role="region" aria-labelledby="inbox-loose">
                <header className="inbox-cluster-head">
                  <div className="inbox-cluster-titles">
                    <h2 className="inbox-cluster-title" id="inbox-loose">
                      Not part of a suggested trip
                    </h2>
                    <p className="inbox-cluster-meta">
                      <span>{count(loose.length, "item")}</span>
                    </p>
                  </div>
                </header>
                <ul className="inbox-cand-list">
                  {loose.map((c) => (
                    <CandidateRow
                      key={c.id}
                      candidate={c}
                      cities={cityIdx}
                      journeys={journeys}
                      range={{ startDate: candidateDay(c), endDate: candidateDay(c) }}
                      busy={busyIds.has(c.id)}
                      actions={actions}
                    />
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
