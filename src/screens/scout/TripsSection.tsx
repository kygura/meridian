import { Badge, Card, EmptyState, ErrorState, SectionHeader, Skeleton } from "../../ui";
import { IconTrips } from "../../ui/icons";
import { hrefFor } from "../../lib/router";
import { TRIP_STATUS_LABEL, tripDatesText } from "../../lib/atlasFormat";
import type { Trip } from "../../types";
import type { Resource } from "./useScout";

/** Trips Atlas planned: ordinary Meridian trips with an "atlas-" id. */
export function TripsSection({ trips }: { trips: Resource<Trip[]> }) {
  const list = trips.data;
  return (
    <section className="scout-section" aria-labelledby="scout-trips">
      <SectionHeader id="scout-trips" title="Planned trips" meta={list?.length ? `${list.length} from Atlas` : undefined} />
      {trips.error && !list ? (
        <ErrorState message={trips.error} onRetry={() => void trips.reload()} />
      ) : !list ? (
        <Card padding="sm">
          <Skeleton lines={2} />
        </Card>
      ) : list.length === 0 ? (
        <EmptyState icon={<IconTrips />} title="No planned trips yet" description="When Atlas plans a trip it saves it here and in Trips with the status Scouting. You keep it, change it or delete it." />
      ) : (
        <ul className="scout-list">
          {list.map((t) => (
            <li key={t.id}>
              <Card padding="sm" className="scout-trip">
                <div className="scout-trip-main">
                  <a className="scout-link" href={hrefFor({ view: "trips", tab: "upcoming", tripId: t.id })}>
                    {t.name}
                  </a>
                  <span className="scout-muted num">{tripDatesText(t)}</span>
                </div>
                <Badge tone={t.status === "confirmed" ? "success" : t.status === "scouting" ? "accent" : "neutral"}>{TRIP_STATUS_LABEL[t.status]}</Badge>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
