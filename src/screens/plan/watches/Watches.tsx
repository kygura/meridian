import { useEffect, useMemo, useState } from "react";
import { JournalLockedError, deleteWatch, listAlerts, listWatches, markAlertSeen, refreshJourneys } from "../../../lib/journalApi";
import { navigate } from "../../../lib/router";
import { onWatchPrefill, takeWatchPrefill, type WatchPrefill } from "../../../lib/watchPrefill";
import { useMeridianStore } from "../../../store";
import type { Alert, City, Watch } from "../../../types";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  IconButton,
  PageActions,
  Skeleton,
  UnlockCard,
  cx,
  toast,
  useJournalToken,
  SectionHeader,
} from "../../../ui";
import { IconBell, IconPlus, IconRefresh, IconTrash } from "../../../ui/icons";
import WatchSheet from "./WatchSheet";
import { runWatchesNow } from "./watchApi";
import {
  alertCompareText,
  alertTitle,
  agoText,
  checkedText,
  eur,
  isMockSource,
  leadSentence,
  monthName,
  querySentence,
  ruleSentence,
  runReportText,
  sortAlerts,
} from "./watchText";
import "./watches.css";

type Status = "loading" | "ready" | "error";

/** #/plan/watches: alerts feed on top, then the watch list. Needs the owner signed in. */
export default function Watches() {
  const { token, unlocked } = useJournalToken();
  const alerts = useMeridianStore((s) => s.alerts);
  const watches = useMeridianStore((s) => s.watches);
  const journeys = useMeridianStore((s) => s.journeys);
  const cities = useMeridianStore((s) => s.cities);
  const cityIdx = useMemo(() => new Map(cities.map((c) => [c.id, c])), [cities]);
  const byId = useMemo(() => new Map(watches.map((w) => [w.id, w])), [watches]);

  const [status, setStatus] = useState<Status>("loading");
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Watch | null>(null);
  const [prefill, setPrefill] = useState<WatchPrefill | null>(null);

  // Hand-off from the city panel ("Watch prices") or a past trip ("Watch similar"):
  // open "Add watch" with it filled in. Taken on mount, and live while mounted.
  useEffect(() => {
    const open = (p: WatchPrefill | null) => {
      if (!p) return;
      takeWatchPrefill();
      setPrefill(p);
      setAdding(true);
    };
    open(takeWatchPrefill());
    return onWatchPrefill(open);
  }, []);

  const load = async () => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const [a, w] = await Promise.all([listAlerts(), listWatches()]);
      const s = useMeridianStore.getState();
      s.setAlerts(a);
      s.setWatches(w);
      setStatus("ready");
    } catch (e) {
      if (e instanceof JournalLockedError) return; // the lock state takes over
      setStatus("error");
    }
  };

  useEffect(() => {
    if (!unlocked) return;
    void load();
    // Watch summaries name the trip they match.
    if (useMeridianStore.getState().journeys === null) refreshJourneys().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, unlocked]);

  const sorted = useMemo(() => sortAlerts(alerts), [alerts]);
  const fresh = sorted.filter((a) => !a.seen);
  const earlier = sorted.filter((a) => a.seen);

  if (!unlocked) {
    return (
      <div className="plan-watches">
        <UnlockCard title="Unlock to see your watches" />
      </div>
    );
  }

  const dismiss = async (a: Alert) => {
    setBusy(a.id);
    try {
      const updated = await markAlertSeen(a.id);
      const s = useMeridianStore.getState();
      s.setAlerts(s.alerts.map((x) => (x.id === a.id ? { ...x, ...updated, seen: true } : x)));
    } catch (e) {
      if (!(e instanceof JournalLockedError)) toast("Couldn't dismiss that alert. Try again.", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const view = (a: Alert) => {
    const w = byId.get(a.watchId);
    if (w) useMeridianStore.getState().setReplayPrefill({ query: w.query, cityId: a.cityId, month: a.month });
    navigate({ view: "plan", tab: "repeat" });
  };

  const planTrip = (a: Alert) => {
    const c = cityIdx.get(a.cityId);
    if (!c) return;
    const s = useMeridianStore.getState();
    const node = (x: City) => ({ cityId: x.id, name: x.name, iata: x.iata, lat: x.lat, lng: x.lng });
    const id = s.createTrip(`${c.name} in ${monthName(a.month)}`);
    // The fare was priced from the watch's origin, so start the trip there.
    const fromId = byId.get(a.watchId)?.query.constraints?.fromCityId;
    const from = fromId ? cityIdx.get(fromId) : undefined;
    if (from) s.addCityToTrip(id, node(from));
    s.addCityToTrip(id, node(c));
    toast(`Trip created: ${c.name} in ${monthName(a.month)}`, { tone: "success" });
    navigate({ view: "trips", tab: "upcoming", tripId: id });
  };

  const remove = async (w: Watch) => {
    setBusy(w.id);
    try {
      await deleteWatch(w.id);
      const s = useMeridianStore.getState();
      s.setWatches(s.watches.filter((x) => x.id !== w.id));
      s.setAlerts(s.alerts.filter((a) => a.watchId !== w.id));
      setToDelete(null);
      toast("Watch deleted");
    } catch (e) {
      if (!(e instanceof JournalLockedError)) toast("Couldn't delete the watch. Try again.", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const report = await runWatchesNow();
      toast(runReportText(report), { tone: report.alerts?.length ? "success" : "neutral" });
      await load();
    } catch (e) {
      if (!(e instanceof JournalLockedError)) toast("Couldn't check your watches. Try again.", { tone: "danger" });
    } finally {
      setRunning(false);
    }
  };

  const addAction = (
    <PageActions>
      <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setAdding(true)}>
        Add watch
      </Button>
    </PageActions>
  );

  const sheet = (
    <WatchSheet
      key={prefill ? JSON.stringify(prefill) : "blank"}
      open={adding}
      prefill={prefill}
      onClose={() => {
        setAdding(false);
        setPrefill(null);
      }}
      onSaved={(w) => {
        const s = useMeridianStore.getState();
        s.setWatches([...s.watches, w]);
        setAdding(false);
        setPrefill(null);
        toast("Watch added. It checks fares every day.", { tone: "success" });
      }}
    />
  );

  if (status === "loading") {
    return (
      <div className="plan-watches" aria-busy="true">
        {addAction}
        <section className="plan-watches-section">
          <Skeleton width={96} height={20} />
          <Card padding="md">
            <Skeleton lines={3} />
          </Card>
        </section>
        <section className="plan-watches-section">
          <Skeleton width={96} height={20} />
          {[0, 1].map((i) => (
            <Card key={i} padding="md">
              <Skeleton lines={2} />
            </Card>
          ))}
        </section>
        {sheet}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="plan-watches">
        {addAction}
        <ErrorState message="Couldn't load your watches and alerts." onRetry={() => void load()} />
        {sheet}
      </div>
    );
  }

  const renderAlert = (a: Alert) => {
    const w = byId.get(a.watchId);
    const cmp = alertCompareText(a, w);
    return (
      <li key={a.id}>
        <Card padding="md" className={cx("plan-watches-alert", a.seen && "is-seen")}>
          <div className="plan-watches-alert-top">
            <div className="plan-watches-alert-text">
              <h3 className="plan-watches-h3">
                {alertTitle(a, cityIdx)}
                {!a.seen ? (
                  <Badge tone="accent" className="plan-watches-new">
                    New
                  </Badge>
                ) : null}
              </h3>
              <p className="plan-watches-meta muted">
                {w ? `From “${w.label}”` : "From a deleted watch"} · {agoText(a.createdAt)}
              </p>
            </div>
            <div className="plan-watches-alert-price">
              <span className="plan-watches-price num">{eur(a.priceEur)}</span>
              {isMockSource(a.source) ? (
                <Badge tone="warning" title="Sample price, not a real fare">
                  Mock
                </Badge>
              ) : null}
            </div>
          </div>
          {cmp ? <p className="plan-watches-compare">{cmp}</p> : null}
          <div className="plan-watches-actions">
            <Button size="sm" onClick={() => view(a)}>
              View
            </Button>
            <Button size="sm" variant="ghost" disabled={!cityIdx.has(a.cityId)} onClick={() => planTrip(a)}>
              Plan a trip
            </Button>
            {!a.seen ? (
              <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => void dismiss(a)} className="plan-watches-dismiss">
                Dismiss
              </Button>
            ) : null}
          </div>
        </Card>
      </li>
    );
  };

  return (
    <div className="plan-watches">
      {addAction}

      <section className="plan-watches-section" aria-labelledby="plan-watches-alerts-h">
        <SectionHeader id="plan-watches-alerts-h" title="Alerts" meta={fresh.length ? `${fresh.length} new` : null} />
        {fresh.length === 0 ? (
          <Card padding="none">
            <EmptyState
              icon={<IconBell />}
              title={earlier.length ? "You're all caught up" : "No alerts yet"}
              description={watches.length ? "Watches check fares every day. Good ones show up here." : "Add a watch and good fares will show up here."}
            />
          </Card>
        ) : (
          <ul className="plan-watches-list">{fresh.map(renderAlert)}</ul>
        )}
        {earlier.length ? (
          <Disclosure summary={`Earlier alerts (${earlier.length})`}>
            <ul className="plan-watches-list">{earlier.map(renderAlert)}</ul>
          </Disclosure>
        ) : null}
      </section>

      <section className="plan-watches-section" aria-labelledby="plan-watches-list-h">
        <SectionHeader
          id="plan-watches-list-h"
          title="Watches"
          actions={
            watches.length ? (
              <Button size="sm" variant="ghost" icon={<IconRefresh size={16} />} loading={running} onClick={() => void runNow()}>
                Check now
              </Button>
            ) : null
          }
        />
        {watches.length === 0 ? (
          <Card padding="none">
            <EmptyState
              icon={<IconBell />}
              title="No watches yet"
              description="A watch looks for cheap fares to places like ones you've loved."
              action={<Button onClick={() => setAdding(true)}>Add watch</Button>}
            />
          </Card>
        ) : (
          <ul className="plan-watches-list">
            {watches.map((w) => (
              <li key={w.id}>
                <Card padding="md" className="plan-watches-watch">
                  <div className="plan-watches-watch-text">
                    <h3 className="plan-watches-h3">
                      {w.label}
                      {!w.active ? <Badge>Paused</Badge> : null}
                    </h3>
                    <p className="plan-watches-line">{querySentence(w.query, cityIdx, journeys)}</p>
                    <p className="plan-watches-line">
                      {ruleSentence(w.priceRule)} {leadSentence(w.leadWeeks)}
                    </p>
                    <p className="plan-watches-meta muted">{checkedText(w.lastRunAt)}</p>
                  </div>
                  <IconButton label={`Delete watch ${w.label}`} icon={<IconTrash size={18} />} onClick={() => setToDelete(w)} />
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sheet}

      <Dialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        role="alertdialog"
        title="Delete this watch?"
        description={toDelete ? `“${toDelete.label}” stops checking fares, and its alerts are removed too.` : undefined}
        footer={
          <>
            <Button onClick={() => setToDelete(null)} data-autofocus>
              Keep
            </Button>
            <Button variant="danger" loading={!!toDelete && busy === toDelete.id} onClick={() => toDelete && void remove(toDelete)}>
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}
