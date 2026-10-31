import { useEffect } from "react";
import { useMeridianStore } from "../store";
import { refreshBadges } from "../lib/journalApi";
import { useJournalToken } from "../ui/journalToken";

const BADGE_REFRESH_MS = 15 * 60 * 1000;

/**
 * Shell only (polls). Inbox pending count and unseen alerts for the nav. Polls only while a token exists
 * (refreshBadges itself skips when there is no token or the journal is locked), and
 * refreshes immediately when the token changes. Counts are 0 while locked.
 */
export function useNavBadges(): { inbox: number; alerts: number } {
  const { token } = useJournalToken();

  useEffect(() => {
    if (!token) return;
    void refreshBadges();
    const id = window.setInterval(() => void refreshBadges(), BADGE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshBadges();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token]);

  return useBadgeCounts();
}

/** Read-only badge counts (no polling). Use this in screens; the shell does the polling. */
export function useBadgeCounts(): { inbox: number; alerts: number } {
  const { unlocked } = useJournalToken();
  const importPending = useMeridianStore((s) => s.importPending);
  const alertsUnseen = useMeridianStore((s) => s.alertsUnseen);
  return unlocked ? { inbox: importPending, alerts: alertsUnseen } : { inbox: 0, alerts: 0 };
}

/** "99+" style label for count badges. */
export function badgeLabel(n: number): string {
  return n > 99 ? "99+" : String(n);
}
