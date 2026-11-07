import type maplibregl from "maplibre-gl";
import { countryKey } from "../../lib/countryNames";
import { featureKeys, type CountryCollection } from "./countries";
import type { RegionSeason } from "../../lib/seasonalityApi";
import type { City } from "../../types";
import { cityRank, OVERLAY_SOURCES, type overlayLayers } from "./overlays";
import type { MapColors } from "./useMapColors";
import { isFilterActive, matchesFilter, modeStep, monthTraits, type ClimateFilter, type ClimateMode, type ClimateMonth } from "../../lib/climate";

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

export interface TintOptions {
  mode: ClimateMode;
  /** 1-12 */
  month: number;
  /** Countries that miss it keep the plain land colour. */
  filter: ClimateFilter;
  /** 7-step ramp per mode (MapColors.ramps). */
  ramps: Record<ClimateMode, string[]>;
  /** countryKey()s left untinted regardless (e.g. conflict advisories when avoiding them). */
  excluded?: Set<string>;
}

/** A region's 12 months as climate months, or null when it lacks temperature and rain. */
function regionMonths(r: RegionSeason): ClimateMonth[] | null {
  if (!r.months.every((m) => typeof m.tempC === "number" && typeof m.precipMm === "number")) return null;
  return r.months.map((m) => ({ score: m.score, tempC: m.tempC!, precipMm: m.precipMm! }));
}

/**
 * Countries with a `tint` colour for the month (seasons layer), or the plain polygons
 * when `regions` is null. The tint follows the mode (comfort, temperature, rain,
 * greenery); with a filter active only countries whose average month meets it are
 * tinted. Countries without data keep the land colour.
 */
export function tintCountries(fc: CountryCollection, regions: RegionSeason[] | null, opts: TintOptions): GeoJSON.FeatureCollection {
  if (!regions) return fc;
  const { mode, month, filter, ramps, excluded } = opts;
  const ramp = ramps[mode];
  const filtering = isFilterActive(filter);
  const tint = new Map<string, string>();
  for (const r of regions) {
    const key = countryKey(r.region);
    if (excluded?.has(key)) continue;
    const months = regionMonths(r);
    if (!months) {
      // Older server: scores only, so comfort is all we can show.
      const s = r.months[month - 1]?.score;
      if (mode === "comfort" && !filtering && typeof s === "number") tint.set(key, ramp[tintStep(s)]);
      continue;
    }
    const t = monthTraits(months, month);
    if (!t || (filtering && !matchesFilter(t, filter))) continue;
    tint.set(key, ramp[modeStep(mode, t)]);
  }
  return {
    type: "FeatureCollection",
    features: fc.features.map((f) => {
      const keys = featureKeys(f.properties ?? {});
      const c = keys.map((k) => tint.get(k)).find((v) => v !== undefined);
      if (c === undefined) return f;
      return { ...f, properties: { ...f.properties, tint: c } };
    }),
  };
}

/** Comfort score 0-100 -> ramp step 1-6 (step 0 is too close to plain land). */
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
