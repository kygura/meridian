// Trip risk: how exposed a planned route is to known incidents.
//
// Incidents are the map's anomalies (standing conflicts, advisories, seasonal hazards,
// live news alerts placed on a capital). A single marker says little; several close
// together say a region is unsettled. So incidents are first grouped into clusters:
// two incidents share a cluster when they are in the same country or within
// CLUSTER_LINK_KM of each other (single linkage, so a chain of neighbours across a
// border becomes one regional cluster). A cluster weighs its worst incident plus a
// little for each extra one.
//
// Each place on the route (the departure and every stop) is scored against every
// cluster by distance, with a floor for being in an affected country. Each flight is
// checked for passing near a conflict cluster. The trip's level is the worst of those.
//
// This is a reading aid, not an advisory. Pure functions; the UI feeds the incidents.

import { countryKey } from "./countryNames";
import { greatCirclePoints, haversineKm, type LngLat } from "./geo";
import { spanMonths, tripSeason } from "./season";
import type { MonthSpan, Trip, TripNode } from "../types";
import type { TripLeg } from "./tripPlan";

export type IncidentKind = "conflict" | "advisory" | "hazard" | "news";

export interface RiskIncident {
  id: string;
  kind: IncidentKind;
  label: string;
  /** worldcities.csv spelling. */
  country?: string;
  lat: number;
  lng: number;
  /** 1 (watch) .. 3 (avoid). */
  severity: number;
  /** Months (1-12) a seasonal hazard is in season; absent = standing. */
  months?: number[];
}

export interface RiskCluster {
  id: string;
  incidents: RiskIncident[];
  /** Country keys the cluster touches. */
  countries: string[];
  /** Display names of those countries, in first-seen order. */
  countryNames: string[];
  centroid: LngLat;
  /** Worst incident severity, 1..3. */
  peak: number;
  /** peak plus a bump for density, capped at peak + 1. */
  weight: number;
  /** Any conflict among the incidents (used for flight-path checks). */
  conflict: boolean;
}

export type RiskLevel = "low" | "watch" | "caution" | "avoid";

export interface ClusterHit {
  cluster: RiskCluster;
  /** Distance from the place to the nearest incident in the cluster. */
  km: number;
  /** weight × proximity × season factor. */
  score: number;
  /** The place is in one of the cluster's countries. */
  inCountry: boolean;
}

export interface PlaceRisk {
  node: TripNode;
  /** "departure" or the stop's index. */
  role: "departure" | number;
  score: number;
  level: RiskLevel;
  /** Clusters that reach this place, strongest first. */
  hits: ClusterHit[];
}

export interface LegRisk {
  leg: TripLeg;
  /** Conflict clusters the flight path passes within OVERFLY_KM of. */
  near: { cluster: RiskCluster; km: number }[];
  level: RiskLevel;
}

export interface TripRisk {
  level: RiskLevel;
  score: number;
  places: PlaceRisk[];
  legs: LegRisk[];
  /** Clusters touching the route, strongest first (deduped across places). */
  clusters: RiskCluster[];
  /** How many incidents and clusters the assessment looked at. */
  incidentCount: number;
  clusterCount: number;
}

export const CLUSTER_LINK_KM = 600;
/** Full weight within this distance of an incident. */
const NEAR_KM = 150;
/** Distance over which influence falls to 1/e beyond NEAR_KM. */
const DECAY_KM = 350;
/** Beyond this a cluster has no influence on a place. */
const REACH_KM = 1500;
/** Being anywhere in an affected country counts for at least this much. */
const IN_COUNTRY_FLOOR = 0.6;
/** A flight passing this close to a conflict is flagged. */
const OVERFLY_KM = 250;
/** Conflicts this close to take-off or landing belong to the place, not the flight. */
const ENDPOINT_KM = 500;
/** Hazards whose months can't be compared to the trip count at this fraction. */
const UNKNOWN_SEASON_FACTOR = 0.5;
/** Share of the second and later clusters added to a place's score. */
const SECONDARY_SHARE = 0.2;

const clampSev = (n: number) => Math.max(1, Math.min(3, Math.round(n || 1)));

/**
 * Group incidents into regional clusters: same country, or within `linkKm` of another
 * member. Clusters come back strongest first.
 */
export function clusterIncidents(incidents: RiskIncident[], linkKm = CLUSTER_LINK_KM): RiskCluster[] {
  const n = incidents.length;
  const parent = incidents.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const keys = incidents.map((i) => (i.country ? countryKey(i.country) : ""));
  const firstOfCountry = new Map<string, number>();
  keys.forEach((k, i) => {
    if (!k) return;
    const f = firstOfCountry.get(k);
    if (f === undefined) firstOfCountry.set(k, i);
    else union(f, i);
  });
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (haversineKm([incidents[i].lng, incidents[i].lat], [incidents[j].lng, incidents[j].lat]) <= linkKm) union(i, j);

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(i);
    groups.set(r, g);
  }

  const out: RiskCluster[] = [];
  for (const idx of groups.values()) {
    const members = idx.map((i) => incidents[i]);
    const countries: string[] = [];
    const countryNames: string[] = [];
    idx.forEach((i) => {
      const k = keys[i];
      if (k && !countries.includes(k)) {
        countries.push(k);
        countryNames.push(incidents[i].country!);
      }
    });
    const peak = Math.max(...members.map((m) => clampSev(m.severity)));
    const weight = Math.min(peak + 1, peak + 0.25 * (members.length - 1));
    const centroid: LngLat = [
      members.reduce((a, m) => a + m.lng, 0) / members.length,
      members.reduce((a, m) => a + m.lat, 0) / members.length,
    ];
    out.push({
      id: members.map((m) => m.id).sort()[0],
      incidents: [...members].sort((a, b) => clampSev(b.severity) - clampSev(a.severity)),
      countries,
      countryNames,
      centroid,
      peak,
      weight,
      conflict: members.some((m) => m.kind === "conflict"),
    });
  }
  return out.sort((a, b) => b.weight - a.weight || b.incidents.length - a.incidents.length);
}

/** 1 within NEAR_KM, then exponential fall-off, 0 beyond REACH_KM. */
export function proximity(km: number): number {
  if (km <= NEAR_KM) return 1;
  if (km >= REACH_KM) return 0;
  return Math.exp(-(km - NEAR_KM) / DECAY_KM);
}

export function riskLevel(score: number): RiskLevel {
  if (score >= 2.75) return "avoid";
  if (score >= 1.75) return "caution";
  if (score >= 0.75) return "watch";
  return "low";
}

const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, watch: 1, caution: 2, avoid: 3 };
export const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);

/** How much of a cluster applies in these months: hazards only count in season. */
function seasonFactor(cluster: RiskCluster, months: number[] | null): number {
  // Standing incidents always apply; the cluster's seasonal part only when it overlaps.
  const standing = cluster.incidents.some((i) => !i.months);
  if (standing) return 1;
  if (!months) return UNKNOWN_SEASON_FACTOR;
  return cluster.incidents.some((i) => i.months!.some((m) => months.includes(m))) ? 1 : 0;
}

/**
 * Hazards out of season are dropped before clustering, so a monsoon in August doesn't
 * weigh on a February trip. With no months known they are kept (seasonFactor halves them).
 */
export function inSeason(incidents: RiskIncident[], months: number[] | null): RiskIncident[] {
  if (!months) return incidents;
  return incidents.filter((i) => !i.months || i.months.some((m) => months.includes(m)));
}

/** Score one place against the clusters. */
export function placeRisk(
  node: TripNode,
  role: PlaceRisk["role"],
  country: string | undefined,
  clusters: RiskCluster[],
  months: number[] | null
): PlaceRisk {
  const ck = country ? countryKey(country) : "";
  const at: LngLat = [node.lng, node.lat];
  const hits: ClusterHit[] = [];
  for (const c of clusters) {
    const km = Math.min(...c.incidents.map((i) => haversineKm(at, [i.lng, i.lat])));
    const inCountry = !!ck && c.countries.includes(ck);
    const prox = Math.max(proximity(km), inCountry ? IN_COUNTRY_FLOOR : 0);
    if (prox <= 0) continue;
    const score = c.weight * prox * seasonFactor(c, months);
    if (score < 0.05) continue;
    hits.push({ cluster: c, km: Math.round(km), score, inCountry });
  }
  hits.sort((a, b) => b.score - a.score);
  const score = hits.length ? hits[0].score + SECONDARY_SHARE * hits.slice(1).reduce((a, h) => a + h.score, 0) : 0;
  return { node, role, score, level: riskLevel(score), hits };
}

/**
 * Conflict clusters a flight passes over on the way. Conflicts close to either end are left
 * out: a stop next to a conflict is already scored as a place. At most "caution".
 */
export function legRisk(leg: TripLeg, clusters: RiskCluster[]): LegRisk {
  const a: LngLat = [leg.from.lng, leg.from.lat];
  const b: LngLat = [leg.to.lng, leg.to.lat];
  const path = greatCirclePoints(a, b, 48);
  const near: LegRisk["near"] = [];
  for (const c of clusters) {
    if (!c.conflict) continue;
    let best = Infinity;
    for (const i of c.incidents) {
      if (i.kind !== "conflict") continue;
      const at: LngLat = [i.lng, i.lat];
      if (haversineKm(at, a) <= ENDPOINT_KM || haversineKm(at, b) <= ENDPOINT_KM) continue;
      for (const p of path) best = Math.min(best, haversineKm(p, at));
    }
    if (best <= OVERFLY_KM) near.push({ cluster: c, km: Math.round(best) });
  }
  near.sort((a, b) => b.cluster.weight - a.cluster.weight);
  const level: RiskLevel = near.length === 0 ? "low" : near[0].cluster.peak >= 3 ? "caution" : "watch";
  return { leg, near, level };
}

function nodeMonths(months: MonthSpan | undefined, fallback: MonthSpan | null): number[] | null {
  const span = months ?? fallback;
  return span ? spanMonths(span) : null;
}

/**
 * Assess a trip from its departure. `countryOf` maps a cityId to its country (from the
 * loaded cities); places it can't resolve are scored by distance alone.
 */
export function assessTrip(
  trip: Pick<Trip, "nodes" | "season">,
  departure: TripNode,
  legs: TripLeg[],
  incidents: RiskIncident[],
  countryOf: (cityId: string) => string | undefined
): TripRisk {
  const season = tripSeason(trip);
  const tripMonths = season ? spanMonths(season) : null;
  const clusters = clusterIncidents(inSeason(incidents, tripMonths));

  const places: PlaceRisk[] = [
    placeRisk(departure, "departure", countryOf(departure.cityId), clusters, tripMonths),
    ...trip.nodes.map((n, i) => placeRisk(n, i, countryOf(n.cityId), clusters, nodeMonths(n.months, season))),
  ];
  const legRisks = legs.map((l) => legRisk(l, clusters));

  let level: RiskLevel = "low";
  let score = 0;
  for (const p of places) {
    level = maxLevel(level, p.level);
    score = Math.max(score, p.score);
  }
  for (const l of legRisks) level = maxLevel(level, l.level);

  const seen = new Map<string, { c: RiskCluster; s: number }>();
  for (const p of places)
    for (const h of p.hits) {
      const prev = seen.get(h.cluster.id);
      if (!prev || h.score > prev.s) seen.set(h.cluster.id, { c: h.cluster, s: h.score });
    }
  for (const l of legRisks) for (const n of l.near) if (!seen.has(n.cluster.id)) seen.set(n.cluster.id, { c: n.cluster, s: 0 });
  const touching = [...seen.values()].sort((a, b) => b.s - a.s || b.c.weight - a.c.weight).map((x) => x.c);

  return {
    level,
    score: Math.round(score * 100) / 100,
    places,
    legs: legRisks,
    clusters: touching,
    incidentCount: clusters.reduce((a, c) => a + c.incidents.length, 0),
    clusterCount: clusters.length,
  };
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: "Low",
  watch: "Watch",
  caution: "Caution",
  avoid: "Avoid",
};

/** "Ukraine, Russia" / "Sudan" / "3 incidents near Kyiv"-style cluster name. */
export function clusterName(c: RiskCluster): string {
  if (c.countryNames.length === 0) return c.incidents[0]?.label ?? "Incidents";
  if (c.countryNames.length <= 2) return c.countryNames.join(", ");
  return `${c.countryNames.slice(0, 2).join(", ")} +${c.countryNames.length - 2}`;
}
