import type maplibregl from "maplibre-gl";
import { featureKeys, type CountryCollection } from "./countries";
import type { City } from "../../types";
import { cityRank, OVERLAY_SOURCES, type overlayLayers } from "./overlays";
import type { MapColors } from "./useMapColors";

type OverlayLayers = ReturnType<typeof overlayLayers>;

// The globe basemap: ocean, land, graticule, equator, borders and city labels, all
// coloured from tokens (the original parchment atlas). Trip overlays from overlays.ts
// are part of the same style so they wrap the sphere.

const GLYPHS = "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf";
const FONT = ["Noto Sans Regular"];
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Label tiers: rank -> minimum zoom. Rank 3 cities never get a label. */
const LABEL_TIERS: [number, number][] = [
  [0, 3],
  [1, 4.5],
  [2, 6],
];

/** Meridians and parallels every 15 degrees, densified so they curve with the globe. */
export function graticule(step = 15): { lines: GeoJSON.FeatureCollection; equator: GeoJSON.FeatureCollection } {
  const features: GeoJSON.Feature[] = [];
  const seg = (coords: [number, number][]): GeoJSON.Feature => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {},
  });
  for (let lng = -180; lng < 180; lng += step) {
    const c: [number, number][] = [];
    for (let lat = -80; lat <= 80; lat += 2) c.push([lng, lat]);
    features.push(seg(c));
  }
  for (let lat = -75; lat <= 75; lat += step) {
    if (lat === 0) continue;
    const c: [number, number][] = [];
    for (let lng = -180; lng <= 180; lng += 2) c.push([lng, lat]);
    features.push(seg(c));
  }
  const eq: [number, number][] = [];
  for (let lng = -180; lng <= 180; lng += 2) eq.push([lng, 0]);
  return { lines: { type: "FeatureCollection", features }, equator: { type: "FeatureCollection", features: [seg(eq)] } };
}

export function buildStyle(colors: MapColors, overlays: OverlayLayers): maplibregl.StyleSpecification {
  const labelLayers: maplibregl.LayerSpecification[] = LABEL_TIERS.map(([rank, minzoom]) => ({
    id: `city-labels-${rank}`,
    type: "symbol",
    source: "city-labels",
    minzoom,
    filter: ["==", ["get", "rank"], rank],
    layout: {
      "text-field": ["get", "name"],
      "text-font": FONT,
      "text-size": rank === 0 ? 12 : 11,
      "text-letter-spacing": 0.02,
      "text-variable-anchor": ["left", "right", "top", "bottom"],
      "text-radial-offset": 0.7,
      "text-justify": "auto",
      "text-allow-overlap": false,
      "text-ignore-placement": false,
      "text-padding": 4,
      "text-max-width": 8,
      "symbol-sort-key": ["-", 0, ["get", "pop"]],
    },
    paint: {
      "text-color": colors.label,
      "text-halo-color": colors.halo,
      "text-halo-width": 1.4,
    },
  }));
  const grat = graticule();
  const sources: maplibregl.StyleSpecification["sources"] = {
    countries: { type: "geojson", data: EMPTY },
    graticule: { type: "geojson", data: grat.lines },
    equator: { type: "geojson", data: grat.equator },
    "city-labels": { type: "geojson", data: EMPTY },
  };
  for (const id of OVERLAY_SOURCES) sources[id] = { type: "geojson", data: EMPTY };

  return {
    version: 8,
    glyphs: GLYPHS,
    projection: { type: "globe" },
    sources,
    layers: [
      { id: "water", type: "background", paint: { "background-color": colors.water } },
      {
        id: "land",
        type: "fill",
        source: "countries",
        paint: {
          "fill-color": ["to-color", ["coalesce", ["get", "tint"], colors.land]],
          "fill-opacity": 1,
        },
      },
      { id: "graticule", type: "line", source: "graticule", paint: { "line-color": colors.grat, "line-width": 0.6 } },
      {
        id: "equator",
        type: "line",
        source: "equator",
        paint: { "line-color": colors.equator, "line-width": 0.9, "line-dasharray": [4, 3] },
      },
      {
        id: "borders",
        type: "line",
        source: "countries",
        paint: { "line-color": colors.border, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 3, 0.8, 6, 1.2] },
      },
      ...overlays.below,
      ...labelLayers,
      ...overlays.above,
    ],
  };
}

/** Re-colour an existing map after a theme change. */
export function repaintBasemap(map: maplibregl.Map, colors: MapColors): void {
  if (!map.getLayer("water")) return;
  map.setPaintProperty("water", "background-color", colors.water);
  map.setPaintProperty("land", "fill-color", ["to-color", ["coalesce", ["get", "tint"], colors.land]]);
  map.setPaintProperty("graticule", "line-color", colors.grat);
  map.setPaintProperty("equator", "line-color", colors.equator);
  map.setPaintProperty("borders", "line-color", colors.border);
  for (const [rank] of LABEL_TIERS) {
    const id = `city-labels-${rank}`;
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(id, "text-color", colors.label);
    map.setPaintProperty(id, "text-halo-color", colors.halo);
  }
}

/** City label points (ranks 0-2 only). */
export function labelFeatures(cities: City[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const c of cities) {
    const rank = cityRank(c);
    if (rank > 2 || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lng, c.lat] },
      properties: { name: c.name, rank, pop: c.population },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Countries with a `tint` colour for the data layer, or the plain polygons when `values`
 * is null. `values` maps countryKey -> 0-100 ramp position; countries without a value
 * keep the land colour.
 */
export function tintByValues(
  fc: CountryCollection,
  values: ReadonlyMap<string, number> | null,
  ramp: string[],
  invert = false
): GeoJSON.FeatureCollection {
  if (!values) return fc;
  return {
    type: "FeatureCollection",
    features: fc.features.map((f) => {
      const v = featureKeys(f.properties ?? {})
        .map((k) => values.get(k))
        .find((x) => x !== undefined);
      if (v === undefined) return f;
      return { ...f, properties: { ...f.properties, tint: ramp[tintStep(invert ? 100 - v : v)] } };
    }),
  };
}

/** Ramp position 0-100 -> ramp step 1-6 (step 0 is too close to plain land). */
export function tintStep(score: number): number {
  return 1 + Math.max(0, Math.min(5, Math.round((score / 100) * 5)));
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
