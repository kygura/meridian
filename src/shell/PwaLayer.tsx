import { useEffect } from "react";
import { Button, EmptyState, Sheet, UnlockCard, cx, toast, useIsDesktop, useJournalToken } from "../ui";
import { onJournalTokenChange } from "../ui/journalToken";
import { IconBell, IconRefresh } from "../ui/icons";
import { hasToken, jfetch } from "../lib/journalApi";
import { applyUpdate, purgePrivateCache, startPwa, useConnectivity, useOffline } from "../lib/pwa";
import {
  clearNotices,
  closeNotices,
  markAllNoticesSeen,
  noticeAge,
  noticeHash,
  noticeKindLabel,
  refreshNotices,
  useNotices,
} from "../lib/notices";
import { useMeridianStore } from "../store";
import type { Notice } from "../types";
import "./pwa.css";

const NOTICES_REFRESH_MS = 15 * 60 * 1000;
const OFFLINE_HELP =
  "You're offline. Trips, the journal and bookings show what was last synced. Trip edits are kept on this device and sync when you're back online; everything else needs a connection.";

/** Fetch the personal data worth having offline, so the service worker keeps a copy. Errors don't matter. */
function primeOfflineData(): void {
  if (!hasToken()) return;
  for (const path of ["/api/bookings", "/api/shortlist", "/api/journal", "/api/journal/settings", "/api/watches", "/api/watches/alerts", "/api/import/queue", "/api/notifications"]) {
    void jfetch(path).catch(() => undefined);
  }
}

/**
 * Offline indicator, and the reload prompt once it has been dismissed. In the sidebar
 * foot on desktop (`placement="sidebar"`), floating above the tab bar on phones.
 * Renders nothing while online and up to date.
 */
export function ConnectionStatus({ placement }: { placement: "sidebar" | "floating" }) {
  const offline = useOffline();
  const updateReady = useConnectivity((s) => s.updateReady);
  if (!offline && !updateReady) return null;
  return (
    <div className={cx("shell-conn", `shell-conn--${placement}`)}>
      {offline ? (
        <button type="button" className="shell-conn-pill shell-conn-pill--offline" onClick={() => toast(OFFLINE_HELP, { duration: 9000 })}>
          <span className="shell-conn-dot" aria-hidden="true" />
          <span role="status">Offline · saved data</span>
        </button>
      ) : null}
      {updateReady ? (
        <button type="button" className="shell-conn-pill" onClick={applyUpdate}>
          <IconRefresh size={14} />
          <span>Update ready · reload</span>
        </button>
      ) : null}
    </div>
  );
}

function deliverySummary(n: Notice): string | null {
  if (n.deliveries.length === 0) return null;
  const sent = n.deliveries.filter((d) => d.ok).map((d) => d.channel);
  const failed = n.deliveries.filter((d) => !d.ok).map((d) => d.channel);
  return [sent.length ? `Sent by ${sent.join(", ")}` : "", failed.length ? `Failed: ${failed.join(", ")}` : ""].filter(Boolean).join(" · ");
}

function NoticeRow({ notice, onOpen }: { notice: Notice; onOpen: () => void }) {
  const hash = noticeHash(notice.url);
  const external = !hash && notice.url && /^https?:\/\//.test(notice.url) ? notice.url : null;
  const sent = deliverySummary(notice);
  return (
    <li className={cx("shell-notice", !notice.seen && "shell-notice--new")}>
      <p className="shell-notice-meta">
        <span>{noticeKindLabel(notice.kind)}</span>
        <span className="num">{noticeAge(notice.createdAt)}</span>
        {!notice.seen ? <span className="shell-notice-new">New</span> : null}
      </p>
      <p className="shell-notice-title">{notice.title}</p>
      {notice.body ? <p className="shell-notice-body">{notice.body}</p> : null}
      <p className="shell-notice-foot">
        {sent ? <span className="shell-notice-sent">{sent}</span> : <span className="shell-notice-sent">Shown here only</span>}
        {hash ? (
          <a className="shell-notice-link" href={hash} onClick={onOpen}>
            Open
          </a>
        ) : external ? (
          <a className="shell-notice-link" href={external} target="_blank" rel="noreferrer">
            Open
          </a>
        ) : null}
      </p>
    </li>
  );
}

/** The Alerts sheet: every Notice, newest first. Opened from the sidebar or the More sheet. */
function NoticesSheet() {
  const open = useNotices((s) => s.open);
  const notices = useNotices((s) => s.notices);
  const loaded = useNotices((s) => s.loaded);
  const { unlocked } = useJournalToken();

  useEffect(() => {
    if (open && unlocked) void refreshNotices();
  }, [open, unlocked]);

  // Reading the list is what marks it read: close it and the badge clears.
  const close = () => {
    closeNotices();
    void markAllNoticesSeen();
  };

  return (
    <Sheet open={open} onClose={close} title="Alerts" description="Watch alerts and reminders, newest first." size="md">
      {!unlocked ? (
        <UnlockCard compact title="Sign in to see your alerts" />
      ) : notices.length === 0 ? (
        <EmptyState
          size="inline"
          icon={<IconBell />}
          title={loaded ? "No alerts yet" : "Loading alerts"}
          description={loaded ? "When a watch finds a price, it shows up here, with or without email or push set up." : undefined}
          action={
            loaded ? (
              <Button size="sm" onClick={() => void refreshNotices()}>
                Check again
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="shell-notices">
          {notices.map((n) => (
            <NoticeRow key={n.id} notice={n} onOpen={close} />
          ))}
        </ul>
      )}
    </Sheet>
  );
}

/**
 * Mounted once by App. Starts the service worker (update prompt, connectivity), keeps the
 * Alerts list fresh, empties the private cache on lock, and renders the Alerts sheet and
 * the phone's offline pill.
 */
export function PwaLayer() {
  const desktop = useIsDesktop();
  const { token } = useJournalToken();

  useEffect(
    () =>
      startPwa({
        onUpdateReady: () => toast("A new version of Meridian is ready.", { action: { label: "Reload", onClick: applyUpdate }, duration: 0 }),
        onFirstControl: primeOfflineData,
        onNavigate: (url) => {
          try {
            const target = new URL(url, window.location.origin);
            if (target.origin === window.location.origin && target.hash) window.location.hash = target.hash;
          } catch {
            /* not a URL: stay put */
          }
        },
      }),
    []
  );

  // Locked or token forgotten: nothing personal stays cached on this device.
  useEffect(() => {
    const forget = () => {
      void purgePrivateCache();
      clearNotices();
    };
    const offToken = onJournalTokenChange(() => {
      if (!hasToken()) forget();
    });
    const offStore = useMeridianStore.subscribe((s, prev) => {
      if (s.journalLocked && !prev.journalLocked) forget();
    });
    return () => {
      offToken();
      offStore();
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    void refreshNotices();
    const id = window.setInterval(() => void refreshNotices(), NOTICES_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshNotices();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token]);

  return (
    <>
      {!desktop ? <ConnectionStatus placement="floating" /> : null}
      <NoticesSheet />
    </>
  );
}
