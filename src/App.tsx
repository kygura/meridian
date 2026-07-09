import { useEffect } from "react";
import { useMeridianStore } from "./store";
import { useRoute } from "./lib/router";
import TopBar from "./components/TopBar";
import LeftDrawer from "./components/LeftDrawer";
import RightDrawer from "./components/RightDrawer";
import Globe from "./components/Globe";
import CommandPalette from "./components/CommandPalette";
import TripCandidates from "./components/TripCandidates";
import TripsOverlay from "./components/TripsOverlay";
import ThemeWipe from "./components/ThemeWipe";
import TripsPage from "./pages/TripsPage";
import SeasonalityPage from "./components/seasonality/SeasonalityPage";
import BookingModal from "./components/booking/BookingModal";
import BookingsPanel from "./components/booking/BookingsPanel";
import { apiUrl } from "./lib/api";

export default function App() {
  const { toggleLeftDrawer, setRightDrawer, toggleCommand, setDrawMode } =
    useMeridianStore();
  const route = useRoute();

  // Fetch initial data on mount
  useEffect(() => {
    fetch(apiUrl("/api/cities?limit=10000"))
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

    // Bookings cache — server is source of truth (DESIGN-booking.md §7.3).
    void useMeridianStore.getState().fetchBookings();
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
      if (e.key === "Escape") setDrawMode(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleLeftDrawer, setRightDrawer, toggleCommand, setDrawMode]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: "44px minmax(0, 1fr)",
        gridTemplateAreas: `"top" "center"`,
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
        {/* Globe stays mounted across navigation to preserve the map instance */}
        <Globe />
        {route.view === "trips" && <TripsPage tripId={route.tripId} />}
        {route.view === "seasons" && <SeasonalityPage />}
      </div>
      <LeftDrawer />
      <RightDrawer />
      <CommandPalette />
      <TripCandidates />
      <TripsOverlay />
      <BookingModal />
      <BookingsPanel />
      <ThemeWipe />
    </div>
  );
}
