// Trip risk card (trip editor) and the incident feed it reads.
// Scoring lives in lib/tripRisk; this file only gathers incidents and renders.

import { useEffect, useMemo } from "react";
import { useMeridianStore } from "../../../store";
import { useAnomalies } from "../../map/useFinderData";
import { newsAnomalyData } from "../../map/finder";
import { loadNews } from "../../world/useNews";
import {
  assessTrip,
  clusterName,
  RISK_LABEL,
  type RiskIncident,
  type RiskLevel,
  type TripRisk,
} from "../../../lib/tripRisk";
import type { TripRoute } from "../../../lib/tripPlan";
import { Badge, Button, type BadgeTone } from "../../../ui";
import type { City, Trip } from "../../../types";

export const RISK_TONE: Record<RiskLevel, BadgeTone> = {
  low: "success",
  watch: "neutral",
  caution: "warning",
  avoid: "danger",
};

/** Seeded anomalies (conflicts, advisories, hazards) plus live news alerts, as incidents. */
export function useRiskIncidents(): { incidents: RiskIncident[]; status: "loading" | "ready" | "error"; retry: () => void } {
  const anomalies = useAnomalies(true);
  const ticker = useMeridianStore((s) => s.ticker);
  const cities = useMeridianStore((s) => s.cities);
  useEffect(() => {
    void loadNews();
  }, []);

  const incidents = useMemo(() => {
    const out: RiskIncident[] = [];
    for (const a of anomalies.data?.items ?? [])
      out.push({
        id: a.id,
        kind: a.kind,
        label: a.label,
        country: a.country,
        lat: a.lat,
        lng: a.lng,
        severity: a.severity,
        months: a.months,
      });
    if (cities.length) {
      const byId = new Map<string, City>(cities.map((c) => [c.id, c]));
      for (const n of newsAnomalyData(ticker, cities)) {
        const city = n.cityId ? byId.get(n.cityId) : undefined;
        out.push({
          id: n.id,
          kind: "news",
          label: n.label,
          country: city?.country,
          lng: n.coord[0],
          lat: n.coord[1],
          severity: n.severity,
        });
      }
    }
    return out;
  }, [anomalies.data, ticker, cities]);

  const status = anomalies.status === "error" ? "error" : anomalies.data ? "ready" : "loading";
  return { incidents, status, retry: anomalies.retry };
}

export function useTripRisk(trip: Trip, route: TripRoute): { risk: TripRisk | null; status: "loading" | "ready" | "error"; retry: () => void } {
  const { incidents, status, retry } = useRiskIncidents();
  const cities = useMeridianStore((s) => s.cities);
  const risk = useMemo(() => {
    if (status !== "ready") return null;
    const country = new Map(cities.map((c) => [c.id, c.country]));
    return assessTrip(trip, route.departure, route.all, incidents, (id) => country.get(id));
  }, [status, trip, route, incidents, cities]);
  return { risk, status, retry };
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  return <Badge tone={RISK_TONE[level]}>{RISK_LABEL[level]}</Badge>;
}

const fmtKm = (km: number) => `${Math.round(km).toLocaleString("en-US")} km`;

/** Risk card body: overall level, each place on the route, flights near conflicts. */
export function RiskCard({ trip, route }: { trip: Trip; route: TripRoute }) {
  const { risk, status, retry } = useTripRisk(trip, route);

  if (status === "error")
    return (
      <div className="trips-risk">
        <p className="trips-risk-note">Couldn't load incidents.</p>
        <Button size="sm" variant="ghost" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  if (!risk) return <p className="trips-risk-note">Checking incidents near the route…</p>;

  const flagged = risk.places.filter((p) => p.level !== "low");
  const legs = risk.legs.filter((l) => l.near.length > 0);
  // Clusters that actually raise a level somewhere on the route.
  const raising = new Set<string>();
  for (const p of flagged) {
    raising.add(p.hits[0].cluster.id);
    for (const h of p.hits) if (h.score >= 0.75) raising.add(h.cluster.id);
  }
  for (const l of legs) for (const n of l.near) raising.add(n.cluster.id);

  return (
    <div className="trips-risk">
      <div className="trips-risk-head">
        <RiskBadge level={risk.level} />
        <span className="trips-risk-sum">
          {raising.size === 0
            ? `Nothing serious on record near ${trip.nodes.length ? "the route" : route.departure.name}.`
            : `${raising.size} ${raising.size === 1 ? "cluster" : "clusters"} of incidents near the route.`}
        </span>
      </div>

      {flagged.length > 0 ? (
        <ul className="trips-risk-list">
          {flagged.map((p) => {
            const top = p.hits[0];
            return (
              <li key={p.role === "departure" ? "dep" : `${p.node.cityId}#${p.role}`} className="trips-risk-row">
                <div className="trips-risk-row-head">
                  <span className="trips-risk-place">
                    {p.role === "departure" ? "From " : ""}
                    {p.node.name}
                  </span>
                  <RiskBadge level={p.level} />
                </div>
                <p className="trips-risk-detail">
                  {clusterName(top.cluster)}: {top.cluster.incidents.length}{" "}
                  {top.cluster.incidents.length === 1 ? "incident" : "incidents"}
                  {top.inCountry ? ", same country" : `, ${fmtKm(top.km)} away`}
                  {p.hits.length > 1 ? ` · ${p.hits.length - 1} more nearby` : ""}
                </p>
                <p className="trips-risk-sub">{top.cluster.incidents[0].label}</p>
              </li>
            );
          })}
        </ul>
      ) : null}

      {legs.length > 0 ? (
        <ul className="trips-risk-list">
          {legs.map((l) => (
            <li key={`leg${l.leg.index}`} className="trips-risk-row">
              <div className="trips-risk-row-head">
                <span className="trips-risk-place">
                  {l.leg.from.name} → {l.leg.to.name}
                </span>
                <RiskBadge level={l.level} />
              </div>
              <p className="trips-risk-detail">
                Flight path passes within {fmtKm(l.near[0].km)} of {clusterName(l.near[0].cluster)}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="trips-risk-note">
        From {risk.incidentCount} known {risk.incidentCount === 1 ? "incident" : "incidents"}, grouped by country and
        proximity into {risk.clusterCount} regional {risk.clusterCount === 1 ? "cluster" : "clusters"}. Seasonal hazards
        count only in the trip's months. Check official advisories before you go.
      </p>
    </div>
  );
}
