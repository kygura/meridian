import { useEffect, useState } from "react";
import type { Route } from "../lib/router";
import { useMeridianStore } from "../store";
import { Button, cx } from "../ui";
import { IconAsk, IconBell, IconLogo, IconPlus } from "../ui/icons";
import { openNotices, useNotices } from "../lib/notices";
import { ConnectionStatus } from "./PwaLayer";
import { NAV_ITEMS, isActive } from "./nav";
import { SettingsPopover } from "./SettingsPanel";
import { useUIStore } from "./uiStore";
import { badgeLabel } from "./useNavBadges";

export interface SidebarProps {
  route: Route;
  badges: { inbox: number; alerts: number };
}

/** Desktop (>= 900px) navigation column. */
export function Sidebar({ route, badges }: SidebarProps) {
  const openQuickLog = useMeridianStore((s) => s.openQuickLog);
  const askOpen = useUIStore((s) => s.ask.open);
  const toggleAsk = useUIStore((s) => s.toggleAsk);
  const noticesOpen = useNotices((s) => s.open);
  const noticesUnseen = useNotices((s) => s.unseen);

  return (
    <aside className="shell-sidebar" aria-label="Main">
      <a className="shell-logo" href="#/" aria-label="Meridian, map">
        <span className="shell-logo-mark">
          <IconLogo size={18} />
        </span>
        <span className="shell-logo-text">
          <span className="shell-logo-name">Meridian</span>
          <span className="shell-logo-tag">cartographic interface</span>
        </span>
      </a>
      <nav className="shell-nav" aria-label="Sections">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item, route);
          const count = item.badge ? badges[item.badge] : 0;
          const countLabel =
            item.badge === "inbox" ? `${count} to review` : item.badge === "alerts" ? `${count} new alerts` : "";
          return (
            <a
              key={item.view}
              href={item.href}
              className={cx("shell-nav-link", active && "shell-nav-link--active")}
              aria-current={active ? "page" : undefined}
              aria-label={count ? `${item.label}, ${countLabel}` : undefined}
            >
              {item.icon}
              <span>{item.label}</span>
              {count ? (
                <span className="shell-nav-badge" aria-hidden="true">
                  {badgeLabel(count)}
                </span>
              ) : null}
            </a>
          );
        })}
        <button
          type="button"
          className={cx("shell-nav-link", askOpen && "shell-nav-link--active")}
          aria-pressed={askOpen}
          onClick={toggleAsk}
        >
          <IconAsk />
          <span>Ask</span>
          <kbd className="shell-kbd" aria-hidden="true">
            ⌘K
          </kbd>
        </button>
        <button
          type="button"
          className={cx("shell-nav-link", noticesOpen && "shell-nav-link--active")}
          aria-haspopup="dialog"
          aria-expanded={noticesOpen}
          aria-label={noticesUnseen ? `Alerts, ${noticesUnseen} new` : undefined}
          onClick={openNotices}
        >
          <IconBell />
          <span>Alerts</span>
          {noticesUnseen ? (
            <span className="shell-nav-badge" aria-hidden="true">
              {badgeLabel(noticesUnseen)}
            </span>
          ) : null}
        </button>
      </nav>
      <div className="shell-sidebar-cta">
        {/* Secondary, so the page's own primary action stays the only filled button on screen. */}
        <Button block icon={<IconPlus size={18} />} onClick={() => openQuickLog()}>
          Log a trip
        </Button>
      </div>
      <div className="shell-sidebar-foot">
        <ConnectionStatus placement="sidebar" />
        <UtcClock />
        <SettingsPopover />
      </div>
    </aside>
  );
}

/** The original top bar's UTC readout, kept as a quiet footer line. */
function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const time = now.toISOString().slice(11, 16);
  const date = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <p className="shell-clock" aria-label={`UTC ${time}, ${date}`}>
      <span className="shell-clock-k">UTC</span>
      <span className="shell-clock-v num">{time}</span>
      <span className="shell-clock-d">{date}</span>
    </p>
  );
}
