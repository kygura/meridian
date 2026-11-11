import { useMemo } from "react";
import { Badge, Button, ErrorState, SectionHeader } from "../../ui";
import { IconCheck, IconClose } from "../../ui/icons";
import { useMeridianStore } from "../../store";
import { resolveTripColor } from "../../lib/tripColors";
import { tripDays } from "../../lib/tripPlan";
import type { Trip } from "../../types";
import { dismissIdea, useTripIdeas } from "./tripIdeas";

function days(t: Trip): number | null {
  const d = tripDays(t);
  return d !== null && d > 0 ? d : null;
}

function price(t: Trip): string | null {
  const e = t.estimate;
  if (!e || !Number.isFinite(e.priceEstimate)) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: e.currency || "EUR", maximumFractionDigits: 0 }).format(e.priceEstimate);
  } catch {
    return `${Math.round(e.priceEstimate)} ${e.currency}`;
  }
}

/** Agent trip candidates with Keep and Dismiss (DESIGN-v3 §6 Ask). Kept trips move to Trips › Upcoming. */
export default function TripIdeas({ onKeep }: { onKeep: (tripId: string, name: string) => void }) {
  const trips = useMeridianStore((s) => s.trips);
  const ideas = useMemo(() => trips.filter((t) => t.origin === "agent"), [trips]);
  const { status, cityId, cityName, request } = useTripIdeas();

  if (status === "error" && cityId) {
    return (
      <section className="ask-ideas" aria-label="Trip ideas">
        <ErrorState message="Couldn't get trip ideas." onRetry={() => void request(cityId, cityName ?? "")} />
      </section>
    );
  }
  if (!ideas.length) return null;

  return (
    <section className="ask-ideas" aria-label="Trip ideas">
      <SectionHeader
        level={3}
        title={cityName ? `Trip ideas around ${cityName}` : "Trip ideas"}
        meta={`${ideas.length} ${ideas.length === 1 ? "idea" : "ideas"}`}
        actions={
          <Button size="sm" variant="ghost" onClick={() => useMeridianStore.getState().discardAgentCandidates()}>
            Dismiss all
          </Button>
        }
      />
      <ul className="ask-ideas-list">
        {ideas.map((t) => {
          const d = days(t);
          const p = price(t);
          return (
            <li key={t.id} className="ask-idea">
              <div className="ask-idea-main">
                <p className="ask-idea-name">
                  <span className="ask-idea-dot" style={{ background: resolveTripColor(t.color) }} aria-hidden="true" />
                  {t.name}
                </p>
                <p className="ask-idea-chain">{t.nodes.map((n) => n.name).join(" → ")}</p>
                <p className="ask-idea-meta num">
                  {[d ? `${d} days` : null, p ? `about ${p}` : null].filter(Boolean).join(" · ")}
                  {t.estimate?.source === "mock" && (
                    <Badge tone="warning" className="ask-idea-mock">
                      Mock
                    </Badge>
                  )}
                </p>
              </div>
              <div className="ask-idea-actions">
                <Button size="sm" variant="ghost" icon={<IconClose size={16} />} onClick={() => dismissIdea(t.id)} aria-label={`Dismiss ${t.name}`}>
                  Dismiss
                </Button>
                <Button
                  size="sm"
                  icon={<IconCheck size={16} />}
                  onClick={() => {
                    useMeridianStore.getState().confirmCandidate(t.id);
                    onKeep(t.id, t.name);
                  }}
                  aria-label={`Keep ${t.name}`}
                >
                  Keep
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
