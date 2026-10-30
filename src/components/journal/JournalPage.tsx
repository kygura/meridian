import { useCallback, useEffect, useState } from "react";
import { useMeridianStore } from "../../store";
import { navigate, type Route } from "../../lib/router";
import { JournalLockedError, refreshBadges, refreshJourneys, tokenNotPersisted } from "../../lib/journalApi";
import UnlockPrompt from "./UnlockPrompt";
import Timeline from "./Timeline";
import JourneyDetail from "./JourneyDetail";
import "../../styles/journal.css";

type JournalRoute = Extract<Route, { view: "journal" }>;

/** Shell for #/journal/*: sub-nav strip plus the sub-view, or UnlockPrompt while locked (§1.2). */
export default function JournalPage({ route }: { route: JournalRoute }) {
  const locked = useMeridianStore((s) => s.journalLocked);
  const journeys = useMeridianStore((s) => s.journeys);
  const importPending = useMeridianStore((s) => s.importPending);
  const alertsUnseen = useMeridianStore((s) => s.alertsUnseen);
  const setAlertsPanelOpen = useMeridianStore((s) => s.setAlertsPanelOpen);
  const openQuickLog = useMeridianStore((s) => s.openQuickLog);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await refreshJourneys();
      void refreshBadges();
    } catch (e) {
      // A 401 is already in the store (journalLocked); anything else is a retryable error.
      if (!(e instanceof JournalLockedError)) setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tab = route.sub === "detail" ? "timeline" : route.sub;
  const link = (key: "timeline" | "replay" | "inbox", label: string, path: string, count?: number) => (
    <button
      type="button"
      className={`jr-subnav-link${tab === key ? " active" : ""}`}
      aria-current={tab === key ? "page" : undefined}
      aria-label={count ? `${label}, ${count} to review` : label}
      onClick={() => navigate(path)}
    >
      {label}
      {!locked && count ? <span className="jr-subnav-count">{count > 99 ? "99+" : count}</span> : null}
    </button>
  );

  return (
    <div className="jr-page">
      <nav className={`jr-subnav${locked ? " locked" : ""}`} aria-label="Journal">
        {link("timeline", "TIMELINE", "/journal")}
        {link("replay", "REPLAY", "/journal/replay")}
        {link("inbox", "INBOX", "/journal/inbox", importPending)}
        <span className="jr-subnav-spacer" />
        <button
          type="button"
          className="jr-subnav-link"
          disabled={locked}
          aria-label={alertsUnseen > 0 ? `Alerts, ${alertsUnseen} new` : "Alerts"}
          onClick={() => setAlertsPanelOpen(true)}
        >
          ALERTS
          <span className={`jr-alert-dot${!locked && alertsUnseen > 0 ? " on" : ""}`} aria-hidden="true">●</span>
        </button>
        <button type="button" className="jr-subnav-link" disabled={locked} onClick={() => openQuickLog()}>
          + LOG JOURNEY
        </button>
      </nav>

      <div className="jr-body">
        {!locked && tokenNotPersisted() && <div className="jr-hint">NOT SAVED · PRIVATE WINDOW</div>}
        {locked ? (
          <UnlockPrompt onUnlocked={() => void load()} />
        ) : route.sub === "timeline" ? (
          <Timeline journeys={journeys} loading={loading} error={error} onRetry={() => void load()} />
        ) : route.sub === "detail" && route.journeyId ? (
          <JourneyDetail key={route.journeyId} journeyId={route.journeyId} />
        ) : (
          // Replay (task b) and Inbox (task d) mount here.
          <div className="jr-empty">
            <div className="cmd-empty-title">{route.sub.toUpperCase()} · NOT BUILT YET</div>
          </div>
        )}
      </div>
    </div>
  );
}
