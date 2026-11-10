import { useState } from "react";
import type { Route } from "../lib/router";
import { Sheet, cx } from "../ui";
import { IconAsk, IconBell, IconMore, IconPlus } from "../ui/icons";
import { openNotices, useNotices } from "../lib/notices";
import { useMeridianStore } from "../store";
import { NAV_ITEMS, isActive } from "./nav";
import { SettingsPanel } from "./SettingsPanel";
import { useUIStore } from "./uiStore";
import { badgeLabel } from "./useNavBadges";

export interface TabBarProps {
  route: Route;
  badges: { inbox: number; alerts: number };
}

const TAB_VIEWS = new Set(["map", "trips", "plan", "inbox"]);

/** Phone (< 900px) bottom tab bar: Map, Trips, Plan, Inbox, More. */
export function TabBar({ route, badges }: TabBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = route.view === "world";
  const noticesUnseen = useNotices((s) => s.unseen);

  return (
    <>
      <nav className="shell-tabbar" aria-label="Sections">
        {NAV_ITEMS.filter((i) => TAB_VIEWS.has(i.view)).map((item) => {
          const active = isActive(item, route);
          const count = item.badge ? badges[item.badge] : 0;
          return (
            <a
              key={item.view}
              href={item.href}
              className={cx("shell-tab", active && "shell-tab--active")}
              aria-current={active ? "page" : undefined}
            >
              <span className="shell-tab-icon">
                {item.icon}
                {count ? (
                  <span className="shell-tab-badge">
                    {badgeLabel(count)}
                    <span className="sr-only">{item.badge === "inbox" ? " to review" : " new alerts"}</span>
                  </span>
                ) : null}
              </span>
              <span className="shell-tab-label">{item.label}</span>
            </a>
          );
        })}
        <button
          type="button"
          className={cx("shell-tab", moreActive && "shell-tab--active")}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <span className="shell-tab-icon">
            <IconMore />
            {noticesUnseen ? (
              <span className="shell-tab-badge">
                {badgeLabel(noticesUnseen)}
                <span className="sr-only"> new alerts</span>
              </span>
            ) : null}
          </span>
          <span className="shell-tab-label">More</span>
        </button>
      </nav>
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}

/** World, Ask, Log a trip and Settings for phones. */
export function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const openAsk = useUIStore((s) => s.openAsk);
  const openQuickLog = useMeridianStore((s) => s.openQuickLog);
  const world = NAV_ITEMS.find((i) => i.view === "world")!;
  const noticesUnseen = useNotices((s) => s.unseen);
  return (
    <Sheet open={open} onClose={onClose} title="More" size="sm">
      <div className="shell-more-list">
        <a className="shell-more-link" href={world.href} onClick={onClose}>
          {world.icon}
          <span>{world.label}</span>
        </a>
        <button
          type="button"
          className="shell-more-link"
          onClick={() => {
            onClose();
            openAsk();
          }}
        >
          <IconAsk />
          <span>Ask</span>
        </button>
        <button
          type="button"
          className="shell-more-link"
          onClick={() => {
            onClose();
            openQuickLog();
          }}
        >
          <IconPlus />
          <span>Log a trip</span>
        </button>
        <button
          type="button"
          className="shell-more-link"
          onClick={() => {
            onClose();
            openNotices();
          }}
        >
          <IconBell />
          <span>Alerts</span>
          {noticesUnseen ? (
            <span className="shell-nav-badge">
              {badgeLabel(noticesUnseen)}
              <span className="sr-only"> new</span>
            </span>
          ) : null}
        </button>
      </div>
      <hr className="shell-more-rule" />
      <SettingsPanel />
    </Sheet>
  );
}
