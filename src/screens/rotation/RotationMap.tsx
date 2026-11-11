import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { buildStyle } from "../map/basemap";
import { loadCountries } from "../map/countries";
import { useMapColors } from "../map/useMapColors";
import { flightPath, greatCirclePoints, type FlightHub, type LngLat } from "../../lib/geo";
import type { RotationLeg, RotationStay } from "../../lib/rotation";

// The rotation's route on the same globe basemap as the Map screen, drawn the same way as
// trip routes (lib/geo flightPath for flights, through a hub when no nonstop exists;
// ground legs straight and dashed).

export interface RotationMapProps {
  stays: RotationStay[];
  legs: RotationLeg[];
  hubs: FlightHub[];
  currentId: string | null;
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function routeGeoJson(legs: RotationLeg[], hubs: FlightHub[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const l of legs) {
    const a: LngLat = [l.leg.from.lng, l.leg.from.lat];
    const b: LngLat = [l.leg.to.lng, l.leg.to.lat];
    const paths = l.leg.mode === "flight" ? flightPath(a, b, hubs).segments : [greatCirclePoints(a, b, 16)];
    for (const coordinates of paths) {
      features.push({ type: "Feature", properties: { mode: l.leg.mode }, geometry: { type: "LineString", coordinates } });
    }
  }
  return { type: "FeatureCollection", features };
}

export function stopsGeoJson(stays: RotationStay[], currentId: string | null): GeoJSON.FeatureCollection {
  const seen = new Map<string, GeoJSON.Feature>();
  for (const s of stays) {
    const f = seen.get(s.place.cityId);
    const current = s.id === currentId;
    if (f) {
      if (current) f.properties!.current = true;
      continue;
    }
    seen.set(s.place.cityId, {
      type: "Feature",
      properties: { name: s.place.name, current, kind: s.kind, idea: s.status === "idea" },
      geometry: { type: "Point", coordinates: [s.place.lng, s.place.lat] },
    });
  }
  return { type: "FeatureCollection", features: [...seen.values()] };
}

export function RotationMap({ stays, legs, hubs, currentId }: RotationMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);
  const colors = useMapColors();
  const route = useMemo(() => routeGeoJson(legs, hubs), [legs, hubs]);
  const stops = useMemo(() => stopsGeoJson(stays, currentId), [stays, currentId]);

  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: buildStyle(colors, { below: [], above: [] }),
      center: [10, 25],
      zoom: 0.8,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      cooperativeGestures: true,
    });
    map.touchZoomRotate.disableRotation();
    map.on("style.load", () => map.setProjection({ type: "globe" }));
    map.on("load", () => {
      map.addSource("rot-route", { type: "geojson", data: EMPTY });
      map.addSource("rot-stops", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "rot-route-casing", type: "line", source: "rot-route", paint: { "line-color": colors.paper, "line-width": 4 } });
      map.addLayer({
        id: "rot-route-flight",
        type: "line",
        source: "rot-route",
        filter: ["==", ["get", "mode"], "flight"],
        paint: { "line-color": colors.accent, "line-width": 2 },
      });
      map.addLayer({
        id: "rot-route-ground",
        type: "line",
        source: "rot-route",
        filter: ["!=", ["get", "mode"], "flight"],
        paint: { "line-color": colors.accent, "line-width": 2, "line-dasharray": [2, 1.5] },
      });
      map.addLayer({
        id: "rot-stops",
        type: "circle",
        source: "rot-stops",
        paint: {
          "circle-radius": ["case", ["get", "current"], 7, ["==", ["get", "kind"], "base"], 5, 3.5],
          "circle-color": ["case", ["get", "current"], colors.accent, colors.dot],
          "circle-opacity": ["case", ["get", "idea"], 0.45, 1],
          "circle-stroke-color": colors.paper,
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "rot-labels",
        type: "symbol",
        source: "rot-stops",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["meridian-serif"],
          "text-size": 13,
          "text-variable-anchor": ["left", "right", "top", "bottom"],
          "text-radial-offset": 0.8,
        },
        paint: { "text-color": colors.label, "text-halo-color": colors.halo, "text-halo-width": 1 },
      });
      setLoaded(true);
    });
    loadCountries()
      .then((fc) => {
        const set = () => (map.getSource("countries") as maplibregl.GeoJSONSource | undefined)?.setData(fc);
        if (map.isStyleLoaded()) set();
        else map.once("load", set);
      })
      .catch(() => {});
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      setLoaded(false);
    };
    // The map is built once; colours are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource("rot-route") as maplibregl.GeoJSONSource).setData(route);
    (map.getSource("rot-stops") as maplibregl.GeoJSONSource).setData(stops);
    const pts = stops.features.map((f) => (f.geometry as GeoJSON.Point).coordinates as [number, number]);
    if (pts.length === 1) map.jumpTo({ center: pts[0], zoom: 3 });
    else if (pts.length > 1) {
      const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
      for (const p of pts) b.extend(p);
      map.fitBounds(b, { padding: 48, maxZoom: 5, duration: 0 });
    }
  }, [loaded, route, stops]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    map.setPaintProperty("water", "background-color", colors.water);
    map.setPaintProperty("land", "fill-color", colors.land);
    map.setPaintProperty("borders", "line-color", colors.border);
    for (const id of ["rot-route-flight", "rot-route-ground"]) map.setPaintProperty(id, "line-color", colors.accent);
    map.setPaintProperty("rot-route-casing", "line-color", colors.paper);
    map.setPaintProperty("rot-stops", "circle-color", ["case", ["get", "current"], colors.accent, colors.dot]);
    map.setPaintProperty("rot-stops", "circle-stroke-color", colors.paper);
    map.setPaintProperty("rot-labels", "text-color", colors.label);
    map.setPaintProperty("rot-labels", "text-halo-color", colors.halo);
  }, [loaded, colors]);

  return <div ref={el} className="rotation-map" role="img" aria-label={`Map of the rotation: ${stops.features.map((f) => f.properties!.name).join(", ") || "no stays yet"}`} />;
}
