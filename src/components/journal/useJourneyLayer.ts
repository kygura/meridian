// Globe journeys layer (DESIGN-journal.md §10) and the picked-chain preview for log-from-globe (§6.3).
// MapLibre sources/layers live under the trip routes; Globe.tsx just calls this hook after its map init.

import { useEffect, useMemo, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";
import { useMeridianStore } from "../../store";
import { hasToken, refreshJourneys } from "../../lib/journalApi";
import { cityIndex, formatDay, MODE_GLYPH } from "../../lib/journal";
import { buildJourneyArcs, scrubArcs } from "../../lib/journeyArcs";
import { flightPath } from "../../lib/geo";
import { navigate } from "../../lib/router";

const ARCS = "journey-arcs";
const DASHED = "journey-arcs-dash";
const STOPS = "journey-stops";
const DRAW = "journal-draw";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const css = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Opacity / width by the feature's scrub emphasis. */
const byEmphasis = (hi: number, faded: number, normal: number): maplibregl.ExpressionSpecification => [
  "match",
  ["get", "emphasis"],
  "hi",
  hi,
  "faded",
  faded,
  normal,
];

function ensure(map: maplibregl.Map) {
  if (map.getSource(ARCS)) return;
  const before = map.getLayer("route-glow") ? "route-glow" : undefined; // planned trips always draw on top
  const ink3 = css("--ink3", "#7a6f60");
  const bg = css("--bg", "#f4ecd8");
  for (const id of [ARCS, STOPS, DRAW]) map.addSource(id, { type: "geojson", data: EMPTY });
  const isFlight: maplibregl.ExpressionSpecification = ["==", ["get", "mode"], "flight"];
  const arc = {
    type: "line" as const,
    source: ARCS,
    paint: {
      "line-color": ink3,
      "line-width": byEmphasis(1.4, 1, 1),
      "line-opacity": byEmphasis(0.9, 0.18, 0.55),
    },
  };
  map.addLayer({ ...arc, id: ARCS, filter: isFlight, layout: { "line-cap": "round", "line-join": "round" } }, before);
  map.addLayer(
    { ...arc, id: DASHED, filter: ["!", isFlight], paint: { ...arc.paint, "line-dasharray": [3, 2] } },
    before
  );
  map.addLayer(
    {
      id: DRAW + "-line",
      type: "line",
      source: DRAW,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": ink3, "line-width": 1.2, "line-opacity": 0.8 },
    },
    before
  );
  map.addLayer(
    {
      id: STOPS,
      type: "circle",
      source: STOPS,
      paint: {
        "circle-radius": 2.5,
        "circle-color": ink3,
        "circle-stroke-width": 1,
        "circle-stroke-color": bg,
        "circle-opacity": byEmphasis(1, 0.3, 0.8),
      },
    },
    before
  );
  map.addLayer(
    {
      id: STOPS + "-labels",
      type: "symbol",
      source: STOPS,
      minzoom: 3,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 9,
        "text-offset": [0, 0.9],
        "text-anchor": "top",
      },
      paint: { "text-color": ink3, "text-halo-color": bg, "text-halo-width": 1.2, "text-opacity": byEmphasis(1, 0.3, 0.8) },
    },
    before
  );
  map.addLayer(
    {
      id: DRAW + "-pts",
      type: "circle",
      source: DRAW,
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 3.5, "circle-color": ink3, "circle-stroke-width": 1, "circle-stroke-color": bg },
    },
    before
  );
}

const drawing = () => {
  const s = useMeridianStore.getState();
  return s.drawMode || s.journalDraw.active;
};

export function useJourneyLayer(
  mapRef: MutableRefObject<maplibregl.Map | null>,
  loadedRef: MutableRefObject<boolean>
) {
  const on = useMeridianStore((s) => s.layers.journeys);
  const locked = useMeridianStore((s) => s.journalLocked);
  const journeys = useMeridianStore((s) => s.journeys);
  const cities = useMeridianStore((s) => s.cities);
  const scrub = useMeridianStore((s) => s.journeyScrub);
  const draw = useMeridianStore((s) => s.journalDraw);
  const theme = useMeridianStore((s) => s.theme);

  const whenLoaded = (map: maplibregl.Map, fn: () => void) => {
    if (loadedRef.current) fn();
    else map.once("load", fn);
  };

  // No token, no request. A 401 flips journalLocked and stops further tries.
  useEffect(() => {
    if (on && !locked && journeys === null && hasToken()) refreshJourneys().catch(() => {});
  }, [on, locked, journeys]);

  const idx = useMemo(() => cityIndex(cities), [cities]);
  const built = useMemo(() => {
    if (!on || locked || !journeys) return null;
    const hubs = cities.filter((c) => c.hub === "large" && c.iata).map((c) => ({ coord: [c.lng, c.lat] as [number, number], label: c.iata! }));
    return buildJourneyArcs(journeys, (id) => idx.get(id), hubs);
  }, [on, locked, journeys, cities, idx]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let live = true;
    whenLoaded(map, () => {
      if (!live) return;
      ensure(map);
      const shown = built ? scrubArcs(built, scrub) : { arcs: [], stops: [] };
      const arcs: GeoJSON.Feature[] = shown.arcs.flatMap((a) =>
        a.paths.map((p) => ({
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: p },
          properties: {
            id: a.journeyId,
            mode: a.mode,
            emphasis: a.emphasis,
            label: `${a.fromName} → ${a.toName} · ${formatDay(a.date)} ${a.year} · ${MODE_GLYPH[a.mode]} ${a.number ?? a.mode}`.toUpperCase(),
          },
        }))
      );
      const stops: GeoJSON.Feature[] = shown.stops.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: s.coord },
        properties: { label: s.label, emphasis: s.emphasis },
      }));
      (map.getSource(ARCS) as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: arcs });
      (map.getSource(STOPS) as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: stops });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, scrub]);

  // Log-from-globe: picked cities as dots joined by the arc style.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let live = true;
    whenLoaded(map, () => {
      if (!live) return;
      ensure(map);
      const pts = draw.cityIds.map((id) => idx.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
      const features: GeoJSON.Feature[] = pts.map((c) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lng, c.lat] },
        properties: {},
      }));
      for (let i = 0; i < pts.length - 1; i++) {
        for (const seg of flightPath([pts[i].lng, pts[i].lat], [pts[i + 1].lng, pts[i + 1].lat]).segments) {
          features.push({ type: "Feature", geometry: { type: "LineString", coordinates: seg }, properties: {} });
        }
      }
      (map.getSource(DRAW) as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw.cityIds, idx]);

  // Theme: re-read --ink3 / --bg the way routes do.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const t = setTimeout(() => {
      if (!map.getLayer(ARCS)) return;
      const ink3 = css("--ink3", "#7a6f60");
      const bg = css("--bg", "#f4ecd8");
      map.setPaintProperty(ARCS, "line-color", ink3);
      map.setPaintProperty(DASHED, "line-color", ink3);
      map.setPaintProperty(DRAW + "-line", "line-color", ink3);
      for (const id of [STOPS, DRAW + "-pts"]) {
        map.setPaintProperty(id, "circle-color", ink3);
        map.setPaintProperty(id, "circle-stroke-color", bg);
      }
      map.setPaintProperty(STOPS + "-labels", "text-color", ink3);
      map.setPaintProperty(STOPS + "-labels", "text-halo-color", bg);
    }, 60);
    return () => clearTimeout(t);
  }, [theme, mapRef, loadedRef]);

  // Hover tooltip + click-through to the journey.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !on) return;
    let cleanup: (() => void) | undefined;
    let live = true;
    whenLoaded(map, () => {
      if (!live) return;
      ensure(map);
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "jr-arc-tip", offset: 8, maxWidth: "none" });
      const hit = (p: maplibregl.Point, layers: string[]) =>
        map.queryRenderedFeatures([[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]], { layers })[0];
      let shownLabel = "";
      let pointer = false;
      const hide = () => {
        popup.remove();
        shownLabel = "";
        if (pointer) map.getCanvas().style.cursor = "";
        pointer = false;
      };
      const onMove = (e: maplibregl.MapMouseEvent) => {
        const f = drawing() ? undefined : hit(e.point, [ARCS, DASHED]);
        if (!f) return hide();
        const label = String(f.properties?.label ?? "");
        if (label !== shownLabel) {
          const el = document.createElement("div");
          el.textContent = label;
          popup.setDOMContent(el);
          shownLabel = label;
        }
        popup.setLngLat(e.lngLat);
        if (!popup.isOpen()) popup.addTo(map);
        map.getCanvas().style.cursor = "pointer";
        pointer = true;
      };
      const onClick = (e: maplibregl.MapMouseEvent) => {
        if (drawing() || hit(e.point, ["city-circles"])) return;
        const id = hit(e.point, [ARCS, DASHED])?.properties?.id;
        if (id) navigate(`/journal/${encodeURIComponent(String(id))}`);
      };
      map.on("mousemove", onMove);
      map.on("click", onClick);
      cleanup = () => {
        map.off("mousemove", onMove);
        map.off("click", onClick);
        hide();
      };
    });
    return () => {
      live = false;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
}
