import type { City } from "../types";

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

function haversine(a: City, b: City): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function greatCircle(
  a: [number, number],
  b: [number, number],
  steps = 32
): [number, number][] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const [lon1, lat1] = [toRad(a[0]), toRad(a[1])];
  const [lon2, lat2] = [toRad(b[0]), toRad(b[1])];
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
      )
    );
  if (d === 0) return [a, b];
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    pts.push([
      toDeg(Math.atan2(y, x)),
      toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    ]);
  }
  return pts;
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
      .map((o) => ({ o, d: haversine(hub, o) }))
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
          coordinates: greatCircle([hub.lng, hub.lat], [o.lng, o.lat]),
        },
        properties: { from: hub.id, to: o.id },
      });
    }
  }

  return { type: "FeatureCollection", features };
}
