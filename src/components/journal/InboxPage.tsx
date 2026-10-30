import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMeridianStore } from "../../store";
import { navigate } from "../../lib/router";
import {
  JournalLockedError,
  acceptCandidate,
  acceptCluster,
  discardCandidate,
  hasToken,
  mergeCandidate,
  mergeCluster,
  refreshJourneys,
  refreshQueue,
  resolveCandidate,
} from "../../lib/journalApi";
import { cityIndex } from "../../lib/journal";
import { clusterMembers, inboxErrorText, candidateDay, looseCandidates, queueMeta } from "../../lib/inbox";
import type { UploadReport } from "../../lib/importUpload";
import type { ImportQueue } from "../../types";
import UploadDock from "./UploadDock";
import ImportReportStrip from "./ImportReportStrip";
import ClusterCard from "./ClusterCard";
import CandidateRow, { type CandidateActions } from "./CandidateRow";

type Notice = { tone: "ok" | "err"; text: string; journeyId?: string };

/** #/journal/inbox: review what imports found before it joins the logbook (DESIGN-journal §8). */
export default function InboxPage() {
  const cities = useMeridianStore((s) => s.cities);
  const journeys = useMeridianStore((s) => s.journeys) ?? [];
  const cityIdx = useMemo(() => cityIndex(cities), [cities]);
  const [queue, setQueue] = useState<ImportQueue | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [report, setReport] = useState<{ report: UploadReport; label: string } | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    // No token, or already locked (a 401 earlier): nothing to ask the server.
    if (!hasToken() || useMeridianStore.getState().journalLocked) return;
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
    return () => {
      alive.current = false;
    };
  }, [load]);

  /** Run a mutation; always refetch afterwards (clusters are recomputed server-side), then clear the busy marks. */
  const act = async (ids: string[], fn: () => Promise<unknown>, ok?: (r: any) => Notice | null) => {
    setBusyIds((s) => new Set([...s, ...ids]));
    setNotice(null);
    try {
      const r = await fn();
      if (alive.current) setNotice(ok ? ok(r) : null);
      void refreshJourneys().catch(() => {});
    } catch (e) {
      if (e instanceof JournalLockedError) return;
      if (alive.current) setNotice({ tone: "err", text: inboxErrorText(e) });
    } finally {
      await load();
      if (alive.current) setBusyIds((s) => new Set([...s].filter((x) => !ids.includes(x))));
    }
  };

  const created = (r: { journey?: { id: string; title: string } }): Notice | null =>
    r?.journey ? { tone: "ok", text: `JOURNEY SAVED: “${r.journey.title}”`, journeyId: r.journey.id } : null;

  const actions: CandidateActions = {
    accept: (id) => void act([id], () => acceptCandidate(id), created),
    merge: (id, journeyId) => void act([id], () => mergeCandidate(id, journeyId), created),
    discard: (id) => void act([id], () => discardCandidate(id)),
    resolve: (id, fix) => void act([id], () => resolveCandidate(id, fix)),
  };

  const candidates = queue?.candidates ?? [];
  const clusters = queue?.clusters ?? [];
  const loose = queue ? looseCandidates(clusters, candidates) : [];
  const empty = queue !== null && candidates.length === 0;

  return (
    <div className="jr-inbox">
      <header className="jr-head">
        <div>
          <div className="jr-eyebrow">INBOX · REVIEW BEFORE IT JOINS THE LOGBOOK</div>
          <h1 className="jr-title">Inbox</h1>
          <div className="jr-sub" aria-live="polite">
            {queue ? queueMeta(candidates.length, clusters.length) : " "}
          </div>
        </div>
      </header>

      <UploadDock onReport={(r, label) => setReport({ report: r, label })} onUploaded={() => void load()} />
      {report && <ImportReportStrip report={report.report} label={report.label} onDismiss={() => setReport(null)} />}

      {notice && (
        <div className={notice.tone === "ok" ? "jr-notice" : "jr-err"} role={notice.tone === "ok" ? "status" : "alert"}>
          {notice.text}
          {notice.journeyId && (
            <>
              {" "}
              <button type="button" className="tp-link" onClick={() => navigate(`/journal/${encodeURIComponent(notice.journeyId!)}`)}>
                OPEN →
              </button>
            </>
          )}
        </div>
      )}

      {loadError && !queue && (
        <div className="jr-empty" role="alert">
          <div className="bk-error-title">⚠ COULDN'T LOAD THE INBOX</div>
          <button type="button" className="tm-action-btn" onClick={() => void load()}>
            ↻ RETRY
          </button>
        </div>
      )}

      {!queue && !loadError && (
        <div role="status" aria-busy="true" aria-label="Loading inbox">
          {[0, 1].map((i) => (
            <span key={i} className="jr-skel jr-skel-card" />
          ))}
        </div>
      )}

      {empty && (
        <div className="jr-empty">
          <div className="jr-empty-title">Inbox zero.</div>
          <div className="jr-empty-sub">IMPORTS LAND HERE FOR REVIEW. NOTHING JOINS YOUR LOGBOOK WITHOUT YOU.</div>
        </div>
      )}

      {clusters.map((cl) => (
        <ClusterCard
          key={cl.id}
          cluster={cl}
          members={clusterMembers(cl, candidates)}
          cities={cityIdx}
          cityList={cities}
          journeys={journeys}
          busyIds={busyIds}
          actions={actions}
          onAccept={() => void act([cl.id, ...cl.candidateIds], () => acceptCluster(cl.id), created)}
          onMerge={(jid) =>
            void act([cl.id, ...cl.candidateIds], () => mergeCluster(cl.id, jid), (r) =>
              r?.journey ? { tone: "ok", text: `MERGED ${r.merged?.length ?? cl.candidateIds.length} ITEMS INTO “${r.journey.title}”`, journeyId: r.journey.id } : null
            )
          }
          onDiscardAll={() =>
            void act([cl.id, ...cl.candidateIds], async () => {
              for (const id of cl.candidateIds) await discardCandidate(id);
            })
          }
        />
      ))}

      {loose.length > 0 && (
        <section className="jr-cluster" aria-label="Ungrouped items">
          <header className="jr-cluster-head">
            <h2 className="jr-cluster-title">Not part of a suggested journey</h2>
            <span className="jr-cluster-n">{loose.length} {loose.length === 1 ? "ITEM" : "ITEMS"}</span>
          </header>
          <ul className="jr-cand-list">
            {loose.map((c) => (
              <CandidateRow
                key={c.id}
                candidate={c}
                cities={cityIdx}
                cityList={cities}
                journeys={journeys}
                range={{ startDate: candidateDay(c), endDate: candidateDay(c) }}
                busy={busyIds.has(c.id)}
                actions={actions}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
