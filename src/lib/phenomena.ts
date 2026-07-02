import type { City } from "../types";
import { greatCirclePoints, haversineKm } from "./geo";

export { greatCirclePoints as greatCircle } from "./geo";

export interface Phenomenon {
  lat: number;
  lng: number;
  label: string;
  sev: number;
  type?: string;
}

export const CONFLICTS: Phenomenon[] = [
  { lat: 31.5, lng: 34.5, label: "GAZA / ISRAEL", sev: 3 },
  { lat: 49.0, lng: 32.0, label: "UKRAINE", sev: 3 },
  { lat: 33.5, lng: 44.4, label: "IRAQ", sev: 2 },
  { lat: 15.5, lng: 32.5, label: "SUDAN", sev: 3 },
  { lat: 4.0, lng: 28.0, label: "DR CONGO E.", sev: 2 },
  { lat: 33.7, lng: 73.0, label: "KASHMIR", sev: 1 },
  { lat: 6.5, lng: 12.5, label: "CAMEROON", sev: 1 },
  { lat: 12.0, lng: 49.0, label: "YEMEN", sev: 2 },
];

export const DISASTERS: Phenomenon[] = [
  { lat: 38.3, lng: 142.4, label: "M6.4 OFFSHORE TOHOKU", type: "quake", sev: 2 },
  { lat: 14.6, lng: 121.0, label: "TYPHOON KIMI", type: "storm", sev: 3 },
  { lat: 37.7, lng: -122.4, label: "WILDFIRE — N. CAL", type: "fire", sev: 2 },
  { lat: 25.2, lng: 90.4, label: "MONSOON FLOOD — NE IND", type: "flood", sev: 3 },
  { lat: -15.8, lng: -47.9, label: "DROUGHT — CERRADO", type: "drought", sev: 1 },
  { lat: 64.1, lng: -21.9, label: "VOLCANIC SWARM — REYKJANES", type: "volcano", sev: 1 },
];

function toFeatures(items: Phenomenon[]): GeoJSON.Feature[] {
  return items.map((p) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    properties: { label: p.label, sev: p.sev, type: p.type ?? "" },
  }));
}

export function conflictFeatures(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: toFeatures(CONFLICTS) };
}

export function disasterFeatures(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: toFeatures(DISASTERS) };
}

/**
 * Build a sparse air-route network from the most populous cities. Each hub
 * connects to its nearest neighbours, producing a faithful "flight web".
 */
export function buildAirRoutes(
  cities: City[],
  hubCount = 28,
  linksPerHub = 3
): GeoJSON.FeatureCollection {
  const hubs = [...cities]
    .filter((c) => c.lat && c.lng)
    .sort((a, b) => b.population - a.population)
    .slice(0, hubCount);

  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];

  for (const hub of hubs) {
    const nearest = hubs
      .filter((o) => o.id !== hub.id)
      .map((o) => ({ o, d: haversineKm([hub.lng, hub.lat], [o.lng, o.lat]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, linksPerHub);

    for (const { o } of nearest) {
      const key = [hub.id, o.id].sort().join("::");
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: greatCirclePoints([hub.lng, hub.lat], [o.lng, o.lat]),
        },
        properties: { from: hub.id, to: o.id },
      });
    }
  }

  return { type: "FeatureCollection", features };
}
