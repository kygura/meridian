import { useMemo } from "react";
import { useMeridianStore } from "../../../store";
import { useUIStore } from "../../../shell/uiStore";
import { Button, Card, ErrorState, IconButton, Skeleton, toast, useIsDesktop, SectionHeader } from "../../../ui";
import { IconCheck, IconRefresh, IconSparkle } from "../../../ui/icons";
import { navigate } from "../../../lib/router";
import { displayTripName, stopChain, tripDateRange, tripDays } from "../../../lib/tripPlan";
import type { City, Trip } from "../../../types";
import { MockBadge, TripDot } from "./parts";
import { dismissCandidate, useSuggestStore } from "./suggestions";
import { useTripMoney } from "./money";

/**
 * "Suggested" row: agent trip candidates with Keep and Dismiss.
 * Source city: the one the suggestions came from, else the city open in the city
 * panel, else the top saved place.
 */
export default function Suggested() {
  const trips = useMeridianStore((s) => s.trips);
  const cities = useMeridianStore((s) => s.cities);
  const shortlist = useMeridianStore((s) => s.shortlist);
  const panelCityId = useUIStore((s) => s.cityPanel?.cityId ?? null);
  const { status, sourceCityId, request } = useSuggestStore();

  const candidates = useMemo(() => trips.filter((t) => t.origin === "agent"), [trips]);

  const source = useMemo<City | null>(() => {
    const byId = (id: string | null | undefined) => (id ? cities.find((c) => c.id === id) ?? null : null);
    return byId(sourceCityId) ?? byId(panelCityId) ?? byId(shortlist[0]?.cityId);
  }, [cities, sourceCityId, panelCityId, shortlist]);

  const loading = status === "loading";
  if (!loading && status !== "error" && candidates.length === 0 && !source) return null;

  const keep = (t: Trip) => {
    useMeridianStore.getState().confirmCandidate(t.id);
    toast(`${displayTripName(t.name)} added to your trips`, {
      tone: "success",
      action: {
        label: "Open",
        onClick: () => navigate({ view: "trips", tab: "upcoming", tripId: t.id }),
      },
    });
  };

  return (
    <section className="trips-up-section" aria-labelledby="trips-up-suggested">
      <SectionHeader
        id="trips-up-suggested"
        title="Suggested"
        meta={source ? `Trip ideas starting from ${source.name}` : null}
        actions={
          candidates.length > 0 ? (
            <>
              {source ? (
                <IconButton
                  label={`Suggest new trips from ${source.name}`}
                  icon={<IconRefresh />}
                  size="md"
                  disabled={loading}
                  onClick={() => void request(source.id)}
                />
              ) : null}
              <Button
                variant="ghost"
                size="md"
                disabled={loading}
                onClick={() => useMeridianStore.getState().discardAgentCandidates()}
              >
                Dismiss all
              </Button>
            </>
          ) : null
        }
      />

      {loading ? (
        <div className="trips-up-suggest-grid" aria-busy="true" aria-label="Loading suggestions">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="trips-up-suggest">
              <Skeleton width="60%" height={16} />
              <Skeleton lines={2} height={12} />
              <Skeleton width={120} height={30} radius={8} />
            </Card>
          ))}
        </div>
      ) : status === "error" ? (
        <ErrorState
          message="Couldn't load suggestions."
          onRetry={source ? () => void request(source.id) : undefined}
        />
      ) : candidates.length === 0 && source ? (
        <Card className="trips-up-suggest-cta">
          <span className="trips-up-suggest-cta-icon" aria-hidden="true">
            <IconSparkle />
          </span>
          <p className="trips-up-suggest-cta-text">Get a few trip ideas built around {source.name}.</p>
          <Button icon={<IconSparkle size={16} />} onClick={() => void request(source.id)}>
            Suggest trips
          </Button>
        </Card>
      ) : (
        <ul className="trips-up-suggest-grid" role="list">
          {candidates.map((t) => (
            <li key={t.id}>
              <SuggestionCard trip={t} onKeep={() => keep(t)} onDismiss={() => dismissCandidate(t.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestionCard({ trip, onKeep, onDismiss }: { trip: Trip; onKeep: () => void; onDismiss: () => void }) {
  const money = useTripMoney();
  const sz = useIsDesktop() ? "sm" : "md";
  const range = tripDateRange(trip);
  const days = tripDays(trip);
  const name = displayTripName(trip.name);
  return (
    <Card className="trips-up-suggest">
      <div className="trips-up-card-title">
        <TripDot color={trip.color} />
        <h3 className="trips-up-name">{name}</h3>
      </div>
      <p className="trips-up-chain">{stopChain(trip.nodes) || "No stops"}</p>
      <div className="trips-up-meta">
        {range ? (
          <span className="tabular">
            {range}
            {days !== null ? ` · ${days} ${days === 1 ? "day" : "days"}` : ""}
          </span>
        ) : null}
        {trip.estimate ? (
          <span className="trips-up-price">
            <span className="tabular">{money(trip.estimate.priceEstimate, trip.estimate.currency)}</span>
            <MockBadge trip={trip} />
          </span>
        ) : null}
      </div>
      <div className="trips-up-suggest-actions">
        <Button size={sz} icon={<IconCheck size={16} />} onClick={onKeep} aria-label={`Keep ${name}`}>
          Keep
        </Button>
        <Button size={sz} variant="ghost" onClick={onDismiss} aria-label={`Dismiss ${name}`}>
          Dismiss
        </Button>
      </div>
    </Card>
  );
}
