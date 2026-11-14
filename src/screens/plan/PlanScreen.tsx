import type { PlanTab, Route } from "../../lib/router";
import { hrefFor } from "../../lib/router";
import { Page, PageActionsProvider, PageHeader, Tabs } from "../../ui";
import { useBadgeCounts, badgeLabel } from "../../shell/useNavBadges";
import WhenToGo from "./when/WhenToGo";
import PlacesToLive from "./live/PlacesToLive";
import Sources from "./sources/Sources";
import RepeatTrip from "./repeat/RepeatTrip";
import Watches from "./watches/Watches";
import Flights from "./flights/Flights";
import DaysPage from "./days/DaysPage";
import "./plan.css";

export interface PlanScreenProps {
  route: Extract<Route, { view: "plan" }>;
}

const TABS: { value: PlanTab; label: string }[] = [
  { value: "when", label: "When to go" },
  { value: "live", label: "Places to live" },
  { value: "sources", label: "Sources" },
  { value: "repeat", label: "Repeat a trip" },
  { value: "watches", label: "Watches" },
  { value: "flights", label: "Flights" },
  { value: "days", label: "Days" },
];

/**
 * Route #/plan/<tab> and #/plan/repeat/<journeyId>/<stopIndex>.
 * Renders the Page, the "Plan" PageHeader and route tabs (links). Each tab component
 * renders only its content, and its primary action (if any) with <PageActions>.
 * Every tab, When to go included, uses the shared page width.
 */
export default function PlanScreen({ route }: PlanScreenProps) {
  const { alerts } = useBadgeCounts();
  return (
    <PageActionsProvider>
      <Page>
        <PageHeader
          kicker="Planner · where to go next"
          title="Plan"
          tabs={
            <Tabs<PlanTab>
              label="Plan sections"
              value={route.tab}
              items={TABS.map((t) => ({
                ...t,
                href: hrefFor({ view: "plan", tab: t.value }),
                badge: t.value === "watches" && alerts ? badgeLabel(alerts) : undefined,
              }))}
            />
          }
        />
        {route.tab === "when" && <WhenToGo />}
        {route.tab === "live" && <PlacesToLive />}
        {route.tab === "sources" && <Sources />}
        {route.tab === "repeat" && (
          <RepeatTrip key={`${route.journeyId ?? ""}:${route.stopIndex ?? ""}`} journeyId={route.journeyId} stopIndex={route.stopIndex} />
        )}
        {route.tab === "watches" && <Watches />}
        {route.tab === "flights" && <Flights />}
        {route.tab === "days" && <DaysPage />}
      </Page>
    </PageActionsProvider>
  );
}
