import type { Route, TripsTab } from "../../lib/router";
import { hrefFor } from "../../lib/router";
import { Page, PageActionsProvider, PageHeader, Tabs } from "../../ui";
import UpcomingList from "./upcoming/UpcomingList";
import TripEditor from "./upcoming/TripEditor";
import PastTimeline from "./past/PastTimeline";
import JourneyDetail from "./past/JourneyDetail";
import "./trips.css";

export interface TripsScreenProps {
  route: Extract<Route, { view: "trips" }>;
}

/**
 * Route #/trips, #/trips/past, #/trips/plan/<tripId>, #/trips/past/<journeyId>.
 *
 * List views: this screen renders the Page, the "Trips" PageHeader and the
 * Upcoming / Past route tabs (the same underline tabs as Plan). The tab component puts its primary action in the
 * header with <PageActions> (UpcomingList: "New trip"; PastTimeline: "Log a trip").
 *
 * Detail views (tripId / journeyId): the detail component owns the whole page
 * content, including its own <PageHeader back={…}>. This screen only wraps it in <Page>.
 */
export default function TripsScreen({ route }: TripsScreenProps) {
  if (route.tab === "upcoming" && route.tripId) {
    return (
      <Page>
        <TripEditor key={route.tripId} tripId={route.tripId} />
      </Page>
    );
  }
  if (route.tab === "past" && route.journeyId) {
    return (
      <Page>
        <JourneyDetail key={route.journeyId} journeyId={route.journeyId} />
      </Page>
    );
  }

  return (
    <PageActionsProvider>
      <Page>
        <PageHeader
          kicker="Logbook · past and planned"
          title="Trips"
          tabs={
            <Tabs<TripsTab>
              label="Trips sections"
              value={route.tab}
              items={[
                { value: "upcoming", label: "Upcoming", href: hrefFor({ view: "trips", tab: "upcoming" }) },
                { value: "past", label: "Past", href: hrefFor({ view: "trips", tab: "past" }) },
              ]}
            />
          }
        />
        {route.tab === "upcoming" ? <UpcomingList /> : <PastTimeline />}
      </Page>
    </PageActionsProvider>
  );
}
