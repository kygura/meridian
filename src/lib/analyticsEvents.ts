import { analyticsEnabled, trackEvent, trackPageView } from "./analytics";
import { parseHash, routePath, type Route } from "./router";
import { useUIStore } from "../shell/uiStore";
import { useMeridianStore } from "../store";

// Page views and the events that follow from UI state, in one place. Events tied to
// a single action (search, shortlist, trips, Ask, booking, finder, sign-in) are sent
// where the action happens; docs/analytics.md lists all of them.

const TITLES: Record<Route["view"], string> = {
  map: "Map",
  trips: "Trips",
  plan: "Plan",
  inbox: "Inbox",
  world: "World",
  rotation: "Rotation",
  locales: "Locales",
  scout: "Scout",
};

function pageTitle(route: Route): string {
  if (route.view === "trips") return `Trips · ${route.tab === "past" ? "Past" : "Upcoming"}`;
  if (route.view === "plan") return `Plan · ${route.tab}`;
  return TITLES[route.view];
}

let started = false;

export function startAnalyticsTracking(): void {
  if (started || !analyticsEnabled()) return;
  started = true;

  // Page views: the hash route as a virtual path. Ids in a path (a trip, a journey)
  // are collapsed so reports group by screen, not by record.
  let lastPath = "";
  const sendPage = () => {
    const route = parseHash(window.location.hash);
    const path = routePath(route)
      .replace(/^\/trips\/plan\/[^/]+$/, "/trips/plan/:trip")
      .replace(/^\/trips\/past\/[^/]+$/, "/trips/past/:journey")
      .replace(/^\/plan\/repeat\/[^/]+(\/\d+)?$/, "/plan/repeat/:journey");
    if (path === lastPath) return;
    lastPath = path;
    trackPageView(path, `${pageTitle(route)} · Meridian`);
  };
  sendPage();
  window.addEventListener("hashchange", sendPage);

  // A city opened from anywhere: map pin, search, trip stop, Ask.
  useUIStore.subscribe((s, prev) => {
    const id = s.cityPanel?.cityId;
    if (id && id !== prev.cityPanel?.cityId) {
      const city = useMeridianStore.getState().cities.find((c) => c.id === id);
      trackEvent("city_view", { city_id: id, city_name: city?.name, country: city?.country });
    }
    if (s.ask.open && !prev.ask.open) trackEvent("ask_open");
  });

  // The booking sheet opened: someone is looking at flights for a leg or a city.
  useMeridianStore.subscribe((s, prev) => {
    if (s.bookingModal.open && !prev.bookingModal.open) {
      const t = s.bookingModal.target;
      trackEvent("flight_search_start", {
        destination_city_id: t?.dest.cityId,
        destination_iata: t?.dest.iata,
        origin_iata: t?.origin?.iata,
        from_trip: Boolean(t?.tripId),
      });
    }
  });
}
