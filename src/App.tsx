import { useEffect } from "react";
import { useMeridianStore } from "./store";
import { useRoute } from "./lib/router";
import { apiUrl } from "./lib/api";
import { AppShell } from "./shell/AppShell";
import { useUIStore } from "./shell/uiStore";
import { Toaster } from "./ui";
import { onJournalTokenChange } from "./ui/journalToken";
import { startTripSync } from "./lib/tripSync";
import MapScreen from "./screens/map/MapScreen";
import CityPanel from "./screens/map/CityPanel";
import TripsScreen from "./screens/trips/TripsScreen";
import QuickLogSheet from "./screens/trips/past/QuickLogSheet";
import PlanScreen from "./screens/plan/PlanScreen";
import BookingSheet from "./screens/plan/flights/BookingSheet";
import InboxScreen from "./screens/inbox/InboxScreen";
import WorldScreen from "./screens/world/WorldScreen";
import RotationScreen from "./screens/rotation/RotationScreen";

export default function App() {
  const route = useRoute();
  const cityPanel = useUIStore((s) => s.cityPanel);
  const closeCity = useUIStore((s) => s.closeCity);

  // Initial data: cities, shortlist, bookings (server is the source of truth for bookings).
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

    void useMeridianStore.getState().fetchBookings();
  }, []);

  // Trips sync to the server while the journal is unlocked (ADR 0006).
  useEffect(() => startTripSync(onJournalTokenChange), []);

  const onMap = route.view === "map";

  return (
    <>
      <AppShell route={route}>
        {/* The map stays mounted across navigation so the map instance survives. */}
        <div className="shell-screen" hidden={!onMap}>
          <MapScreen active={onMap} />
        </div>
        {route.view === "trips" && (
          <div className="shell-screen">
            <TripsScreen route={route} />
          </div>
        )}
        {route.view === "plan" && (
          <div className="shell-screen">
            <PlanScreen route={route} />
          </div>
        )}
        {route.view === "inbox" && (
          <div className="shell-screen">
            <InboxScreen />
          </div>
        )}
        {route.view === "world" && (
          <div className="shell-screen">
            <WorldScreen />
          </div>
        )}
        {route.view === "rotation" && (
          <div className="shell-screen">
            <RotationScreen />
          </div>
        )}
      </AppShell>

      {/* Global layers, reachable from any route. */}
      {cityPanel && <CityPanel key={cityPanel.cityId} cityId={cityPanel.cityId} onClose={closeCity} />}
      <QuickLogSheet />
      <BookingSheet />
      <Toaster />
    </>
  );
}
