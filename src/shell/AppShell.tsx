import { useEffect, type ReactNode } from "react";
import type { Route } from "../lib/router";
import { useIsDesktop, useLayer } from "../ui";
import AskPanel from "../screens/ask/AskPanel";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { useApplyTheme } from "./theme";
import { useUIStore } from "./uiStore";
import { useGlobalKeys } from "./useGlobalKeys";
import { NotionSheetHost } from "./NotionSettings";
import { useNavBadges } from "./useNavBadges";

export interface AppShellProps {
  route: Route;
  /** Routed screens. The shell gives them a positioned, full-height main area. */
  children: ReactNode;
}

/**
 * Layout (DESIGN-v3.md §3): sidebar + main + docked Ask column on desktop; main +
 * bottom tab bar on phones (Ask becomes a sheet there). Also owns theme, global
 * keys and nav badge polling.
 */
export function AppShell({ route, children }: AppShellProps) {
  const desktop = useIsDesktop();
  const askOpen = useUIStore((s) => s.ask.open);
  const closeAsk = useUIStore((s) => s.closeAsk);
  const badges = useNavBadges();

  useApplyTheme();
  useGlobalKeys();
  // Esc closes the Ask panel when it is the topmost layer.
  useLayer(askOpen, closeAsk);

  const docked = desktop && askOpen;
  useEffect(() => {
    // Side sheets sit left of the docked Ask column.
    document.documentElement.style.setProperty("--ask-offset", docked ? "var(--ask-w)" : "0px");
  }, [docked]);

  return (
    <div className="shell" data-layout={desktop ? "desktop" : "phone"} data-ask={docked ? "docked" : undefined}>
      {desktop ? <Sidebar route={route} badges={badges} /> : null}
      <main className="shell-main" id="main">
        {children}
      </main>
      {docked ? (
        <aside className="shell-ask" aria-label="Ask">
          <AskPanel mode="docked" onClose={closeAsk} />
        </aside>
      ) : null}
      {!desktop ? <TabBar route={route} badges={badges} /> : null}
      {!desktop && askOpen ? <AskPanel mode="sheet" onClose={closeAsk} /> : null}
      <NotionSheetHost />
    </div>
  );
}
