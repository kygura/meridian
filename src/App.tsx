import { useEffect } from "react";
import { useMeridianStore } from "./store";
import TopBar from "./components/TopBar";
import LeftDrawer from "./components/LeftDrawer";
import RightDrawer from "./components/RightDrawer";
import BottomBar from "./components/BottomBar";
import Globe from "./components/Globe";
import CommandPalette from "./components/CommandPalette";
import TripCandidates from "./components/TripCandidates";
import TripsOverlay from "./components/TripsOverlay";
import ThemeWipe from "./components/ThemeWipe";
import { apiUrl } from "./lib/api";

export default function App() {
  const {
    setCities,
    setShortlist,
    toggleLeftDrawer,
    setRightDrawer,
    toggleCommand,
  } = useMeridianStore();

  // Fetch initial data on mount
  useEffect(() => {
    fetch(apiUrl("/api/cities?limit=5000"))
      .then((r) => r.json())
      .then((data) => {
        const cities = data?.cities ?? data;
        if (Array.isArray(cities)) useMeridianStore.getState().setCities(cities);
      })
      .catch(() => {});

    fetch(apiUrl("/api/shortlist"))
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) useMeridianStore.getState().setShortlist(data);
      })
      .catch(() => {});
  }, []);

  // Keyboard listeners
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Command palette: ⌘K / Ctrl+K works everywhere.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleCommand();
        return;
      }

      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      if (e.key === "[") toggleLeftDrawer();
      if (e.key === "]") setRightDrawer(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleLeftDrawer, setRightDrawer, toggleCommand]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: "44px minmax(0, 1fr) 56px",
        gridTemplateAreas: `"top" "center" "bottom"`,
      }}
    >
      <TopBar />
      <div
        style={{
          gridArea: "center",
          position: "relative",
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <Globe />
      </div>
      <BottomBar />
      <LeftDrawer />
      <RightDrawer />
      <CommandPalette />
      <TripCandidates />
      <TripsOverlay />
      <ThemeWipe />
    </div>
  );
}
