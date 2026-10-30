import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMeridianStore } from "../../store";
import { navigate } from "../../lib/router";
import { JournalLockedError, clearToken, deleteWatch, listAlerts, listWatches, markAlertSeen } from "../../lib/journalApi";
import { MONTHS, cityIndex, formatEur } from "../../lib/journal";
import { agoText, alertComparison, alertWhere, isMockSource, replayPath, ruleText, sortAlerts } from "../../lib/inbox";
import type { Alert, City, Watch } from "../../types";
import "../../styles/journal.css";

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** Alerts + watches (DESIGN-journal §9). Modal; opened from the sub-nav ALERTS item and from a ticker click. */
export default function AlertsPanel() {
  const open = useMeridianStore((s) => s.alertsPanelOpen);
  if (!open) return null;
  return <Panel />;
}

function Panel() {
  const alerts = useMeridianStore((s) => s.alerts);
  const watches = useMeridianStore((s) => s.watches);
  const cities = useMeridianStore((s) => s.cities);
  const setAlertsPanelOpen = useMeridianStore((s) => s.setAlertsPanelOpen);
  const cardRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(document.activeElement);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const idx = useMemo(() => cityIndex(cities), [cities]);
  const byId = useMemo(() => new Map(watches.map((w) => [w.id, w])), [watches]);
  const list = useMemo(() => sortAlerts(alerts), [alerts]);
  const close = () => setAlertsPanelOpen(false);

  // Refresh on open; nothing is marked seen by opening.
  useEffect(() => {
    const s = useMeridianStore.getState();
    Promise.all([listAlerts(), listWatches()])
      .then(([a, w]) => {
        s.setAlerts(a);
        s.setWatches(w);
      })
      .catch((e) => {
        if (!(e instanceof JournalLockedError)) setError("⚠ COULDN'T REFRESH — SHOWING WHAT WAS LOADED");
      });
    cardRef.current?.querySelector<HTMLElement>("button")?.focus();
    const opener = openerRef.current;
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  const seen = async (a: Alert) => {
    setBusy(a.id);
    setError(null);
    try {
      const s = useMeridianStore.getState();
      const updated = await markAlertSeen(a.id);
      s.setAlerts(s.alerts.map((x) => (x.id === a.id ? { ...x, ...updated, seen: true } : x)));
    } catch (e) {
      if (!(e instanceof JournalLockedError)) setError("⚠ COULDN'T MARK THAT AS SEEN — TRY AGAIN");
    } finally {
      setBusy(null);
    }
  };

  const openReplay = (a: Alert) => {
    const w = byId.get(a.watchId);
    const s = useMeridianStore.getState();
    if (w) s.setReplayPrefill({ query: w.query, cityId: a.cityId, month: a.month });
    close();
    navigate(replayPath(w));
  };

  const repeat = (a: Alert) => {
    const c = idx.get(a.cityId);
    if (!c) return;
    const s = useMeridianStore.getState();
    const node = (x: City) => ({ cityId: x.id, name: x.name, iata: x.iata, lat: x.lat, lng: x.lng });
    const id = s.createTrip(`${c.name} · ${MONTHS[a.month - 1]}`);
    s.addCityToTrip(id, node(c));
    close();
    navigate(`/trips/${id}`);
  };

  const remove = async (w: Watch) => {
    setBusy(w.id);
    setError(null);
    try {
      await deleteWatch(w.id);
      const s = useMeridianStore.getState();
      s.setWatches(s.watches.filter((x) => x.id !== w.id));
      setConfirmDelete(null);
    } catch (e) {
      if (!(e instanceof JournalLockedError)) setError("⚠ COULDN'T DELETE THAT WATCH — TRY AGAIN");
    } finally {
      setBusy(null);
    }
  };

  const forget = () => {
    clearToken();
    const s = useMeridianStore.getState();
    s.setAlerts([]);
    s.setWatches([]);
    s.setImportPending(0);
    s.setJournalLocked(true);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = [...(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((n) => n.offsetParent !== null);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="cmd-overlay" onMouseDown={close}>
      <div ref={cardRef} className="bookings-panel jr-alerts" role="dialog" aria-modal="true" aria-labelledby="jr-al-title" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="bookings-panel-head">
          <span className="bookings-panel-title" id="jr-al-title">
            ALERTS
          </span>
          <span className="bookings-panel-meta">
            <span className="bookings-panel-count">{list.filter((a) => !a.seen).length} NEW</span>
            <button type="button" className="tm-action-btn booking-close" aria-label="Close" onClick={close}>
              ✕
            </button>
          </span>
        </div>

        <div className="bookings-panel-body">
          {error && (
            <div className="jr-err" role="alert">
              {error}
            </div>
          )}
          {list.length === 0 ? (
            <div className="cmd-empty">
              <div className="cmd-empty-title">NO ALERTS YET</div>
              <div className="cmd-empty-sub">Watches check daily. You'll see a window here when it's bookable and cheap.</div>
            </div>
          ) : (
            <ul className="jr-alert-list">
              {list.map((a) => {
                const w = byId.get(a.watchId);
                const cmp = alertComparison(a, w);
                return (
                  <li key={a.id} className={`jr-alert${a.seen ? " seen" : ""}`}>
                    <div className="jr-alert-line">
                      <span className="jr-alert-sq" aria-hidden="true" />
                      <span className="jr-alert-where">{alertWhere(a, idx)}</span>
                      <span className="jr-alert-price">
                        {formatEur(a.priceEur)}
                        {cmp && <span className="jr-alert-base"> {cmp.vs}</span>}
                        {cmp?.delta && <span className="jr-alert-delta"> {cmp.delta}</span>}
                      </span>
                      {isMockSource(a.source) && (
                        <span className="bk-badge bk-badge-mock" role="img" aria-label="Mock price, not used for scoring">
                          MOCK
                        </span>
                      )}
                      <span className="jr-alert-from">from “{w?.label ?? "a deleted watch"}”</span>
                      <span className="jr-alert-ago">{agoText(a.createdAt)}</span>
                      <span className="jr-sr-only">{a.seen ? "Seen" : "New"}</span>
                    </div>
                    <div className="jr-alert-actions">
                      <button type="button" className="tp-link" onClick={() => openReplay(a)}>
                        OPEN IN REPLAY
                      </button>
                      <button type="button" className="tp-link" disabled={!idx.has(a.cityId)} onClick={() => repeat(a)}>
                        ↻ REPEAT
                      </button>
                      {!a.seen && (
                        <button type="button" className="tp-link" disabled={busy === a.id} onClick={() => void seen(a)}>
                          MARK SEEN
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="jr-label jr-alerts-h">WATCHES</div>
          {watches.length === 0 ? (
            <div className="jr-hint">NO WATCHES — SAVE ONE FROM A REPLAY RESULT</div>
          ) : (
            <ul className="jr-watch-list">
              {watches.map((w) => (
                <li key={w.id} className="jr-watch-row">
                  <span className="jr-watch-label">{w.label}</span>
                  <span className="jr-watch-meta">
                    {w.leadWeeks[0]}–{w.leadWeeks[1]} WK · {ruleText(w.priceRule)} · {w.lastRunAt ? `LAST RUN ${agoText(w.lastRunAt)}` : "NEVER RUN"}
                  </span>
                  <span className={`sr-pill jr-watch-state${w.active ? " on" : ""}`}>{w.active ? "ACTIVE" : "PAUSED"}</span>
                  {confirmDelete === w.id ? (
                    <span className="jr-watch-del">
                      <button type="button" className="tm-action-btn tm-delete-btn tm-delete-confirm" disabled={busy === w.id} autoFocus onClick={() => void remove(w)}>
                        CONFIRM DELETE
                      </button>
                      <button type="button" className="tm-action-btn" onClick={() => setConfirmDelete(null)}>
                        KEEP
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="tm-action-btn tm-delete-btn" aria-label={`Delete watch ${w.label}`} onClick={() => setConfirmDelete(w.id)}>
                      DELETE
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="jr-alerts-foot">
          <button type="button" className="tp-link" onClick={forget}>
            FORGET TOKEN
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
