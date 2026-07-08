import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import maplibregl from "maplibre-gl";
import { apiUrl } from "../lib/api";
import { useMeridianStore } from "../store";
import { conflictFeatures, disasterFeatures } from "../lib/phenomena";
import { flightPath, haversineKm } from "../lib/geo";
import { resolveTripColor } from "../lib/tripColors";
import type { LayerKey, MetricSurface } from "../types";

const COUNTRIES_GEOJSON =
  "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_admin_0_countries.geojson";

const GLYPHS = "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf";
const FONT = ["Noto Sans Regular"];

// Metric layers — each has its own identity hue. When several are active they
// are meshed (mean-tinted-by-dominant-hue) and disagreement is surfaced as a ring.
const METRIC_LAYERS = ["weather", "cost"] as const;

type MetricKey = (typeof METRIC_LAYERS)[number];

const LAYER_COLORS: Record<MetricKey, string> = {
  weather: "#d98a2b",
  cost: "#2f86b5",
};

const LAYER_LABELS: Record<MetricKey, string> = {
  weather: "WEATHER",
  cost: "COST",
};

// Capitals and major connectivity hubs render prominently.
const CAPITAL_COLOR = "#b3261e";
const HUB_COLOR = "#1a6f8f";

// Colour shown where active signals disagree (high spread).
const DISCREPANCY_COLOR = "#7c3aed";
// Dark base mixed into low values so nodes stay legible on parchment.
const NODE_BASE = "#241f19";

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const c = (i: number) => Math.round(A[i] + (B[i] - A[i]) * t);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

// Fill colour: hue from the dominant signal, lightness driven by the mean level.
function nodeFill(dominant: MetricKey, level: number): string {
  return mixHex(NODE_BASE, LAYER_COLORS[dominant], 0.4 + 0.6 * (level / 100));
}

function getCSSVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

// Default (no metric mesh) circle styling: capitals and large hubs pop.
function cityCircleColorExpr(): maplibregl.ExpressionSpecification {
  return [
    "case",
    ["boolean", ["get", "capital"], false],
    CAPITAL_COLOR,
    ["==", ["get", "hub"], "large"],
    HUB_COLOR,
    getCSSVar("--ink") || "#1c1814",
  ];
}

function cityCircleRadiusExpr(): maplibregl.ExpressionSpecification {
  return [
    "case",
    ["boolean", ["get", "selected"], false],
    7,
    ["boolean", ["get", "capital"], false],
    5.5,
    ["==", ["get", "hub"], "large"],
    5,
    4,
  ];
}

function buildStyle(): maplibregl.StyleSpecification {
  const ocean = getCSSVar("--ocean") || "#e9dcbe";
  const land = getCSSVar("--land") || "#d6c6a2";
  const borderCountry = getCSSVar("--border-country") || "rgba(28,24,20,0.5)";

  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { countries: { type: "geojson", data: COUNTRIES_GEOJSON } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": ocean } },
      {
        id: "countries-fill",
        type: "fill",
        source: "countries",
        paint: { "fill-color": land },
      },
      {
        id: "countries-border",
        type: "line",
        source: "countries",
        paint: { "line-color": borderCountry, "line-width": 0.8 },
      },
    ],
  };
}

// ── Evocative phenomenon glyphs (canvas → map images) ───────────────
type GlyphDraw = (ctx: CanvasRenderingContext2D, s: number) => void;

function glyphImage(
  draw: GlyphDraw,
  size = 44,
  pr = 2
): { data: ImageData; pixelRatio: number } {
  const c = document.createElement("canvas");
  c.width = size * pr;
  c.height = size * pr;
  const ctx = c.getContext("2d")!;
  ctx.scale(pr, pr);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // Soft halo so glyphs read on the parchment globe.
  ctx.shadowColor = getCSSVar("--bg") || "#f4ecd8";
  ctx.shadowBlur = 2;
  draw(ctx, size);
  return {
    data: ctx.getImageData(0, 0, size * pr, size * pr),
    pixelRatio: pr,
  };
}

// Earthquake — radiating shockwave rings from an epicentre.
const drawQuake: GlyphDraw = (ctx, s) => {
  const cx = s / 2;
  const cy = s / 2;
  ctx.strokeStyle = "#7a4a1f";
  for (let i = 3; i >= 1; i--) {
    ctx.globalAlpha = 0.25 + 0.22 * (3 - i);
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(cx, cy, i * 5.2, -0.7, Math.PI + 0.7);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#5a3413";
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
};

// Cyclone / typhoon — two spiral arms around a calm eye.
const drawStorm: GlyphDraw = (ctx, s) => {
  const cx = s / 2;
  const cy = s / 2;
  ctx.strokeStyle = "#3b6e8c";
  ctx.lineWidth = 2.4;
  for (let arm = 0; arm < 2; arm++) {
    ctx.beginPath();
    for (let t = 0; t <= Math.PI * 1.7; t += 0.1) {
      const r = 2 + t * 3.1;
      const a = t + arm * Math.PI;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "#214b63";
  ctx.beginPath();
  ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
  ctx.fill();
};

// Wildfire — overlapping flame tongues with a hot gradient.
const drawFire: GlyphDraw = (ctx, s) => {
  const cx = s / 2;
  const by = s / 2 + 9;
  const grad = ctx.createLinearGradient(0, by, 0, by - 22);
  grad.addColorStop(0, "#b3261e");
  grad.addColorStop(1, "#e8a02b");
  ctx.fillStyle = grad;
  const flame = (ox: number, scale: number) => {
    ctx.beginPath();
    ctx.moveTo(cx + ox, by);
    ctx.quadraticCurveTo(cx + ox - 6 * scale, by - 8 * scale, cx + ox - 1 * scale, by - 16 * scale);
    ctx.quadraticCurveTo(cx + ox + 1 * scale, by - 9 * scale, cx + ox + 5 * scale, by - 13 * scale);
    ctx.quadraticCurveTo(cx + ox + 6 * scale, by - 5 * scale, cx + ox, by);
    ctx.closePath();
    ctx.fill();
  };
  flame(-5, 0.8);
  flame(5, 0.8);
  flame(0, 1.15);
};

// Flood — a droplet riding over rising ripples.
const drawFlood: GlyphDraw = (ctx, s) => {
  const cx = s / 2;
  const cy = s / 2 - 4;
  ctx.fillStyle = "#2f6fb0";
  ctx.beginPath();
  ctx.moveTo(cx, cy - 9);
  ctx.quadraticCurveTo(cx + 7, cy + 2, cx, cy + 7);
  ctx.quadraticCurveTo(cx - 7, cy + 2, cx, cy - 9);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#2f6fb0";
  ctx.lineWidth = 1.8;
  for (let i = 0; i < 2; i++) {
    const y = s / 2 + 8 + i * 4;
    ctx.beginPath();
    for (let x = 6; x <= s - 6; x += 2) {
      const yy = y + Math.sin(x / 3) * 1.6;
      x === 6 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
};

// Drought — a beating sun over cracked ground.
const drawDrought: GlyphDraw = (ctx, s) => {
  const cx = s / 2;
  const cy = s / 2 - 2;
  ctx.strokeStyle = "#c2680c";
  ctx.fillStyle = "#c2680c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 7, cy + Math.sin(a) * 7);
    ctx.lineTo(cx + Math.cos(a) * 10, cy + Math.sin(a) * 10);
    ctx.stroke();
  }
  ctx.strokeStyle = "#8a5a2a";
  ctx.lineWidth = 1.6;
  const gy = s / 2 + 11;
  ctx.beginPath();
  ctx.moveTo(6, gy);
  ctx.lineTo(s - 6, gy);
  ctx.moveTo(s / 2 - 4, gy);
  ctx.lineTo(s / 2 - 7, gy + 4);
  ctx.moveTo(s / 2 + 4, gy);
  ctx.lineTo(s / 2 + 7, gy + 4);
  ctx.stroke();
};

// Volcano — a cone venting lava and embers.
const drawVolcano: GlyphDraw = (ctx, s) => {
  const cx = s / 2;
  const by = s / 2 + 10;
  ctx.fillStyle = "#5a4636";
  ctx.beginPath();
  ctx.moveTo(cx - 10, by);
  ctx.lineTo(cx - 3, by - 12);
  ctx.lineTo(cx + 3, by - 12);
  ctx.lineTo(cx + 10, by);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#d14a1e";
  ctx.beginPath();
  ctx.moveTo(cx - 3, by - 12);
  ctx.lineTo(cx, by - 20);
  ctx.lineTo(cx + 3, by - 12);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#e8a02b";
  ([[-4, -18], [4, -19], [0, -25]] as const).forEach(([dx, dy]) => {
    ctx.beginPath();
    ctx.arc(cx + dx, by + dy, 1.4, 0, Math.PI * 2);
    ctx.fill();
  });
};

// Conflict — a radiating alert burst.
const drawBurst: GlyphDraw = (ctx, s) => {
  const cx = s / 2;
  const cy = s / 2;
  ctx.strokeStyle = "#b3261e";
  ctx.fillStyle = "#b3261e";
  ctx.lineWidth = 2.2;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r0 = i % 2 ? 3 : 5;
    const r1 = i % 2 ? 9 : 12;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
  ctx.fill();
};

const DISASTER_GLYPHS: Record<string, GlyphDraw> = {
  quake: drawQuake,
  storm: drawStorm,
  fire: drawFire,
  flood: drawFlood,
  drought: drawDrought,
  volcano: drawVolcano,
};

function registerPhenomenonImages(map: maplibregl.Map): void {
  const add = (id: string, draw: GlyphDraw) => {
    try {
      if (map.hasImage(id)) map.removeImage(id);
      const img = glyphImage(draw);
      map.addImage(id, img.data, { pixelRatio: img.pixelRatio });
    } catch {
      /* noop */
    }
  };
  for (const [type, draw] of Object.entries(DISASTER_GLYPHS)) add(`dis-${type}`, draw);
  add("conflict-burst", drawBurst);
}

export default function Globe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  const [zoom, setZoom] = useState(2.2);
  const [center, setCenter] = useState<[number, number]>([10, 25]);
  const {
    cities,
    layers,
    theme,
    trips,
    activeTripId,
    surfaces,
    setSurface,
    shortlist,
  } = useMeridianStore();

  const activeMetrics = useMemo(
    () => METRIC_LAYERS.filter((k) => layers[k]),
    [layers]
  );
  const hasMetric = activeMetrics.length > 0;
  const hasActiveTrip = trips.some((t) => t.id === activeTripId);

  // Fetch every active metric surface that isn't cached yet.
  useEffect(() => {
    for (const id of activeMetrics) {
      if (surfaces[id]) continue;
      fetch(apiUrl(`/api/metrics/surface/${id}`))
        .then((r) => r.json())
        .then((data) => {
          if (data && Array.isArray(data.values)) setSurface(id, data);
        })
        .catch(() => {});
    }
  }, [activeMetrics, surfaces, setSurface]);

  // Mesh the active surfaces per city: mean (level), spread (disagreement),
  // dominant signal (hue). Fill = mean tinted by the dominant signal's hue.
  const cityFeatures = useMemo(() => {
    const ready = activeMetrics.filter((id) => surfaces[id]) as MetricKey[];

    // locationId -> { key -> normalized }
    const byCity = new Map<string, Partial<Record<MetricKey, number>>>();
    for (const key of ready) {
      const surf = surfaces[key] as MetricSurface;
      for (const v of surf.values) {
        const cur = byCity.get(v.locationId) ?? {};
        cur[key] = v.normalized;
        byCity.set(v.locationId, cur);
      }
    }

    const selectedId = useMeridianStore.getState().selectedCityId;
    return cities
      .filter((c) => c.lat && c.lng)
      .map((city) => {
        const vals = byCity.get(city.id);
        let mean: number | null = null;
        let spread = 0;
        let fill: string | null = null;

        if (vals && ready.length) {
          const entries = ready
            .map((k) => [k, vals[k]] as const)
            .filter((e): e is [MetricKey, number] => typeof e[1] === "number");
          if (entries.length) {
            const nums = entries.map((e) => e[1]);
            mean = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
            spread = Math.round(Math.max(...nums) - Math.min(...nums));
            const dominant = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
            fill = nodeFill(dominant, mean);
          }
        }

        return {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [city.lng, city.lat],
          },
          properties: {
            id: city.id,
            name: city.name,
            iata: city.iata || "",
            selected: city.id === selectedId,
            capital: !!city.capital,
            hub: city.hub ?? "",
            mean,
            spread,
            fill,
          },
        };
      });
  }, [cities, activeMetrics, surfaces]);

  // ── Initialize map ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(),
      center: [10, 25],
      zoom: 2.2,
      attributionControl: false,
      dragRotate: false,
    });
    mapRef.current = map;

    map.on("style.load", () => map.setProjection({ type: "globe" }));
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-left"
    );
    map.on("zoom", () => setZoom(map.getZoom()));
    map.on("move", () => {
      const c = map.getCenter();
      setCenter([c.lng, c.lat]);
    });

    map.on("load", () => {
      loadedRef.current = true;

      registerPhenomenonImages(map);

      // Unified routes (trip arcs + suggested shortlist arcs)
      map.addSource("routes", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      // Active route glow (behind main lines)
      map.addLayer({
        id: "route-glow",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["boolean", ["get", "active"], false], 8, 0],
          "line-opacity": ["case", ["boolean", ["get", "active"], false], 0.18, 0],
          "line-blur": 4,
        },
      });
      map.addLayer({
        id: "route-lines",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["boolean", ["get", "active"], false], 2.8, 1.4],
          "line-opacity": ["case", ["boolean", ["get", "suggested"], false], 0.45, 0.9],
          "line-dasharray": [
            "case",
            ["boolean", ["get", "suggested"], false],
            ["literal", [2, 2]],
            ["literal", [1, 0]],
          ],
        },
      });
      // Route endpoint markers
      map.addSource("route-endpoints", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "route-endpoint-pulse",
        type: "circle",
        source: "route-endpoints",
        paint: {
          "circle-radius": 8,
          "circle-color": ["get", "color"],
          "circle-opacity": 0.2,
          "circle-blur": 1,
        },
      });
      map.addLayer({
        id: "route-endpoint-markers",
        type: "circle",
        source: "route-endpoints",
        paint: {
          "circle-radius": ["case", ["boolean", ["get", "isOrigin"], false], 5, 3.5],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": getCSSVar("--bg") || "#f4ecd8",
        },
      });
      map.addLayer({
        id: "route-endpoint-labels",
        type: "symbol",
        source: "route-endpoints",
        layout: {
          "text-field": ["get", "iata"],
          "text-font": FONT,
          "text-size": 12,
          "text-offset": [0, -1.6],
          "text-anchor": "bottom",
          "text-allow-overlap": false,
        },
        paint: {
          // Ink-on-bg reads in both themes; the colored endpoint dot already
          // carries the trip identity — colored text against the halo did not.
          "text-color": getCSSVar("--ink") || "#1c1814",
          "text-halo-color": getCSSVar("--bg") || "#f4ecd8",
          "text-halo-width": 2,
        },
      });

      // Draw-mode cursor preview (dashed arc from last trip node to cursor)
      map.addSource("draw-preview", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "draw-preview-line",
        type: "line",
        source: "draw-preview",
        paint: {
          "line-color": getCSSVar("--accent") || "#c2680c",
          "line-width": 1.6,
          "line-dasharray": [2, 2],
          "line-opacity": 0.8,
        },
      });

      // City points
      map.addSource("city-points", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "metric-heat",
        type: "heatmap",
        source: "city-points",
        layout: { visibility: "none" },
        paint: {
          "heatmap-weight": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "mean"], 0],
            0,
            0,
            100,
            1,
          ],
          "heatmap-intensity": 0.9,
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 1, 12, 6, 40],
          "heatmap-opacity": 0.5,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(0,0,0,0)",
            0.3,
            "rgba(15,118,110,0.45)",
            0.6,
            getCSSVar("--hazard") || "#c2680c",
            1,
            getCSSVar("--warn") || "#b3261e",
          ],
        },
      });
      map.addLayer({
        id: "city-circles",
        type: "circle",
        source: "city-points",
        paint: {
          "circle-radius": cityCircleRadiusExpr(),
          "circle-color": cityCircleColorExpr(),
          "circle-stroke-width": 1,
          "circle-stroke-color": getCSSVar("--bg") || "#f4ecd8",
          "circle-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "city-labels",
        type: "symbol",
        source: "city-points",
        minzoom: 3,
        layout: {
          "text-field": ["get", "iata"],
          "text-font": FONT,
          "text-size": 10,
          "text-offset": [0.8, -0.6],
          "text-anchor": "left",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": getCSSVar("--ink") || "#1c1814",
          "text-halo-color": getCSSVar("--bg") || "#f4ecd8",
          "text-halo-width": 1.2,
        },
      });

      // Capitals + major hubs get their names early, in their accent color.
      map.addLayer({
        id: "city-labels-major",
        type: "symbol",
        source: "city-points",
        minzoom: 1.5,
        filter: [
          "any",
          ["boolean", ["get", "capital"], false],
          ["==", ["get", "hub"], "large"],
        ],
        layout: {
          "text-field": ["get", "name"],
          "text-font": FONT,
          "text-size": 11,
          "text-offset": [0.9, -0.7],
          "text-anchor": "left",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": [
            "case",
            ["boolean", ["get", "capital"], false],
            CAPITAL_COLOR,
            HUB_COLOR,
          ],
          "text-halo-color": getCSSVar("--bg") || "#f4ecd8",
          "text-halo-width": 1.6,
        },
      });

      // Conflict zones
      // Conflict zones — animated pulse + radiating alert burst.
      map.addSource("conflicts", { type: "geojson", data: conflictFeatures() });
      map.addLayer({
        id: "conflict-pulse",
        type: "circle",
        source: "conflicts",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": ["+", ["*", ["coalesce", ["get", "sev"], 1], 4], 4],
          "circle-color": getCSSVar("--warn") || "#b3261e",
          "circle-opacity": 0.3,
          "circle-stroke-width": 0,
        },
      });
      map.addLayer({
        id: "conflict-points",
        type: "symbol",
        source: "conflicts",
        layout: {
          visibility: "none",
          "icon-image": "conflict-burst",
          "icon-size": ["interpolate", ["linear"], ["get", "sev"], 1, 0.7, 3, 1.2],
          "icon-allow-overlap": true,
          "text-field": ["get", "label"],
          "text-font": FONT,
          "text-size": 9,
          "text-offset": [0, 1.5],
          "text-anchor": "top",
        },
        paint: {
          "text-color": getCSSVar("--warn") || "#b3261e",
          "text-halo-color": getCSSVar("--bg") || "#f4ecd8",
          "text-halo-width": 1.4,
        },
      });

      // Disaster events — animated shockwave pulse + type-specific glyphs.
      map.addSource("disasters", { type: "geojson", data: disasterFeatures() });
      map.addLayer({
        id: "disaster-pulse",
        type: "circle",
        source: "disasters",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": ["+", ["*", ["coalesce", ["get", "sev"], 1], 3], 3],
          "circle-color": getCSSVar("--hazard") || "#c2680c",
          "circle-opacity": 0.28,
          "circle-stroke-width": 0,
        },
      });
      map.addLayer({
        id: "disaster-points",
        type: "symbol",
        source: "disasters",
        layout: {
          visibility: "none",
          "icon-image": ["concat", "dis-", ["get", "type"]],
          "icon-size": ["interpolate", ["linear"], ["get", "sev"], 1, 0.75, 3, 1.25],
          "icon-allow-overlap": true,
          "icon-rotation-alignment": "viewport",
          "text-field": ["get", "label"],
          "text-font": FONT,
          "text-size": 9,
          "text-offset": [0, 1.6],
          "text-anchor": "top",
        },
        paint: {
          "text-color": getCSSVar("--hazard") || "#c2680c",
          "text-halo-color": getCSSVar("--bg") || "#f4ecd8",
          "text-halo-width": 1.4,
        },
      });
    });

    map.on("click", "city-circles", (e) => {
      if (useMeridianStore.getState().drawMode) return;
      const f = e.features?.[0];
      if (f?.properties?.id)
        useMeridianStore.getState().selectCity(f.properties.id as string);
    });
    map.on("mouseenter", "city-circles", () => {
      map.getCanvas().style.cursor = "crosshair";
    });
    map.on("mouseleave", "city-circles", () => {
      map.getCanvas().style.cursor = "";
    });

    const resize = () => map.resize();
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);
    map.once("load", resize);
    window.addEventListener("resize", resize);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
  }, []);

  // ── Push city features ──────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("city-points") as maplibregl.GeoJSONSource;
      if (src) src.setData({ type: "FeatureCollection", features: cityFeatures });
    };
    if (loadedRef.current) apply();
    else map.once("load", apply);
  }, [cityFeatures]);

  // ── Color / size nodes by the blended metric ────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !map.getLayer("city-circles")) return;
    const meshing = activeMetrics.length > 1;
    if (hasMetric) {
      // Fill = mean tinted by dominant signal (precomputed per feature).
      map.setPaintProperty("city-circles", "circle-color", [
        "coalesce",
        ["get", "fill"],
        getCSSVar("--ink") || "#1c1814",
      ]);
      map.setPaintProperty("city-circles", "circle-radius", [
        "case",
        ["boolean", ["get", "selected"], false],
        8,
        ["interpolate", ["linear"], ["coalesce", ["get", "mean"], 0], 0, 2.8, 100, 6.8],
      ]);
      // Ring surfaces disagreement between active signals (only when meshing).
      map.setPaintProperty(
        "city-circles",
        "circle-stroke-color",
        meshing ? DISCREPANCY_COLOR : getCSSVar("--bg") || "#f4ecd8"
      );
      map.setPaintProperty(
        "city-circles",
        "circle-stroke-width",
        meshing
          ? ["interpolate", ["linear"], ["coalesce", ["get", "spread"], 0], 0, 0.4, 25, 1.6, 60, 3.6]
          : 0.8
      );
      map.setPaintProperty(
        "city-circles",
        "circle-stroke-opacity",
        meshing
          ? ["interpolate", ["linear"], ["coalesce", ["get", "spread"], 0], 0, 0.12, 25, 0.55, 60, 0.95]
          : 0.5
      );
      map.setLayoutProperty("metric-heat", "visibility", "visible");
    } else {
      map.setPaintProperty("city-circles", "circle-color", cityCircleColorExpr());
      map.setPaintProperty("city-circles", "circle-radius", cityCircleRadiusExpr());
      map.setPaintProperty(
        "city-circles",
        "circle-stroke-color",
        getCSSVar("--bg") || "#f4ecd8"
      );
      map.setPaintProperty("city-circles", "circle-stroke-width", 1);
      map.setPaintProperty("city-circles", "circle-stroke-opacity", 0.9);
      map.setLayoutProperty("metric-heat", "visibility", "none");
    }
  }, [hasMetric, activeMetrics.length, cityFeatures]);

  // ── Fly to selected city ────────────────────────────────────────
  const selectedCityId = useMeridianStore((s) => s.selectedCityId);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedCityId) return;
    const city = cities.find((c) => c.id === selectedCityId);
    if (city)
      map.flyTo({
        center: [city.lng, city.lat],
        zoom: Math.max(map.getZoom(), 4),
        duration: 1200,
      });
  }, [selectedCityId, cities]);

  // ── Draw mode: click the globe to append the nearest airport city ─
  const drawMode = useMeridianStore((s) => s.drawMode);
  useEffect(() => {
    if (drawMode && !hasActiveTrip) useMeridianStore.getState().setDrawMode(false);
  }, [drawMode, hasActiveTrip]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = drawMode ? "crosshair" : "";
    if (!drawMode) {
      const src = map.getSource("draw-preview") as maplibregl.GeoJSONSource | null;
      if (src) src.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const nearestAirportCity = (lng: number, lat: number) => {
      const cs = useMeridianStore.getState().cities;
      let best: { c: (typeof cs)[number]; d: number } | null = null;
      for (const c of cs) {
        if (!c.iata) continue;
        const d = haversineKm([lng, lat], [c.lng, c.lat]);
        if (!best || d < best.d) best = { c, d };
      }
      return best && best.d <= 500 ? best.c : null;
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const c = nearestAirportCity(e.lngLat.lng, e.lngLat.lat);
      if (!c) return;
      useMeridianStore.getState().addCityToActiveTrip({
        cityId: c.id,
        name: c.name,
        iata: c.iata,
        lat: c.lat,
        lng: c.lng,
      });
    };

    let raf = 0;
    const onMove = (e: maplibregl.MapMouseEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const state = useMeridianStore.getState();
        const trip = state.trips.find((t) => t.id === state.activeTripId);
        const last = trip?.nodes[trip.nodes.length - 1];
        const src = map.getSource("draw-preview") as maplibregl.GeoJSONSource | null;
        if (!src || !last) return;
        src.setData({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: flightPath(
                  [last.lng, last.lat],
                  [e.lngLat.lng, e.lngLat.lat]
                ).segments[0],
              },
              properties: {},
            },
          ],
        });
      });
    };

    map.on("click", onClick);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [drawMode]);

  // ── Unified routes: trip arcs + suggested shortlist arcs ────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("routes") as maplibregl.GeoJSONSource;
      const epSrc = map.getSource("route-endpoints") as maplibregl.GeoJSONSource | null;
      if (!src) return;
      if (!layers.routes) {
        src.setData({ type: "FeatureCollection", features: [] });
        if (epSrc) epSrc.setData({ type: "FeatureCollection", features: [] });
        return;
      }
      const features: GeoJSON.Feature[] = [];
      const endpointFeatures: GeoJSON.Feature[] = [];

      // Large-hub airports for routing near-antipodal legs realistically.
      const hubList = useMeridianStore
        .getState()
        .cities.filter((c) => c.hub === "large" && c.iata)
        .map((c) => ({ coord: [c.lng, c.lat] as [number, number], label: c.iata! }));

      for (const trip of trips) {
        const color = resolveTripColor(trip.color);
        const isActive = trip.id === activeTripId;
        const isCandidate = trip.origin === "agent";

        for (let i = 0; i < trip.nodes.length - 1; i++) {
          const a = trip.nodes[i];
          const b = trip.nodes[i + 1];
          const path = flightPath([a.lng, a.lat], [b.lng, b.lat], hubList);
          for (const seg of path.segments) {
            features.push({
              type: "Feature",
              geometry: { type: "LineString", coordinates: seg },
              properties: {
                color,
                active: isActive,
                // Unconfirmed candidates render dashed/dim like suggested arcs;
                // the focused (active) candidate still glows so paging is visible.
                suggested: isCandidate,
              },
            });
          }
        }

        // Endpoint markers for each node in the trip
        for (let i = 0; i < trip.nodes.length; i++) {
          const node = trip.nodes[i];
          endpointFeatures.push({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [node.lng, node.lat],
            },
            properties: {
              color,
              iata: node.iata || "",
              name: node.name,
              isOrigin: i === 0,
              active: isActive,
            },
          });
        }
      }

      // Suggested arcs between consecutive shortlisted cities.
      const accent = getCSSVar("--accent") || "#c2680c";
      const pts = shortlist.filter((s) => s.lat && s.lng);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const path = flightPath([a.lng, a.lat], [b.lng, b.lat], hubList);
        for (const seg of path.segments) {
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: seg },
            properties: { color: accent, active: false, suggested: true },
          });
        }
      }

      src.setData({ type: "FeatureCollection", features });
      if (epSrc) epSrc.setData({ type: "FeatureCollection", features: endpointFeatures });
    };
    if (loadedRef.current) apply();
    else map.once("load", apply);
  }, [trips, activeTripId, layers.routes, shortlist, theme]);

  // ── Conflict / disaster visibility ──────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const vis = (id: string, on: boolean) => {
      if (map.getLayer(id))
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    vis("conflict-pulse", layers.conflict);
    vis("conflict-points", layers.conflict);
    vis("disaster-pulse", layers.disaster);
    vis("disaster-points", layers.disaster);
  }, [layers.conflict, layers.disaster]);

  // ── Animate phenomenon pulses + storm rotation ──────────────────
  const phenomenaActive = layers.conflict || layers.disaster;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !phenomenaActive) return;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const ms = t - start;
      const phase = (ms % 1800) / 1800; // expanding shockwave 0→1
      try {
        if (layers.disaster && map.getLayer("disaster-pulse")) {
          map.setPaintProperty("disaster-pulse", "circle-radius", [
            "+",
            ["*", ["coalesce", ["get", "sev"], 1], 3],
            phase * 26,
          ]);
          map.setPaintProperty("disaster-pulse", "circle-opacity", (1 - phase) * 0.42);
        }
        if (layers.disaster && map.getLayer("disaster-points")) {
          map.setLayoutProperty("disaster-points", "icon-rotate", [
            "case",
            ["==", ["get", "type"], "storm"],
            (ms / 14) % 360,
            0,
          ]);
        }
        if (layers.conflict && map.getLayer("conflict-pulse")) {
          map.setPaintProperty("conflict-pulse", "circle-radius", [
            "+",
            ["*", ["coalesce", ["get", "sev"], 1], 4],
            phase * 30,
          ]);
          map.setPaintProperty("conflict-pulse", "circle-opacity", (1 - phase) * 0.38);
        }
      } catch {
        /* layer not ready */
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phenomenaActive, layers.conflict, layers.disaster]);

  // ── City layer toggle ───────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const vis = layers.cities ? "visible" : "none";
    if (map.getLayer("city-circles"))
      map.setLayoutProperty("city-circles", "visibility", vis);
    if (map.getLayer("city-labels"))
      map.setLayoutProperty("city-labels", "visibility", vis);
    if (map.getLayer("city-labels-major"))
      map.setLayoutProperty("city-labels-major", "visibility", vis);
  }, [layers.cities]);

  // ── Theme repaint ───────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const timer = setTimeout(() => {
      const ocean = getCSSVar("--ocean");
      const land = getCSSVar("--land");
      const borderCountry = getCSSVar("--border-country");
      const ink = getCSSVar("--ink");
      const bg = getCSSVar("--bg");
      if (map.getLayer("background"))
        map.setPaintProperty("background", "background-color", ocean);
      if (map.getLayer("countries-fill"))
        map.setPaintProperty("countries-fill", "fill-color", land);
      if (map.getLayer("countries-border"))
        map.setPaintProperty("countries-border", "line-color", borderCountry);
      if (map.getLayer("city-circles") && !hasMetric) {
        map.setPaintProperty("city-circles", "circle-color", cityCircleColorExpr());
        map.setPaintProperty("city-circles", "circle-stroke-color", bg);
      }
      if (map.getLayer("city-labels")) {
        map.setPaintProperty("city-labels", "text-color", ink);
        map.setPaintProperty("city-labels", "text-halo-color", bg);
      }
      if (map.getLayer("city-labels-major")) {
        map.setPaintProperty("city-labels-major", "text-halo-color", bg);
      }
      if (map.getLayer("route-endpoint-labels")) {
        map.setPaintProperty("route-endpoint-labels", "text-color", ink);
        map.setPaintProperty("route-endpoint-labels", "text-halo-color", bg);
      }
      registerPhenomenonImages(map);
    }, 60);
    return () => clearTimeout(timer);
  }, [theme, hasMetric]);

  const handleZoomIn = useCallback(() => mapRef.current?.zoomIn({ duration: 300 }), []);
  const handleZoomOut = useCallback(() => mapRef.current?.zoomOut({ duration: 300 }), []);
  const handleZoomReset = useCallback(
    () => mapRef.current?.flyTo({ center: [10, 25], zoom: 2.2, duration: 800 }),
    []
  );

  const zoomPercent = Math.round((zoom / 22) * 100);

  return (
    <>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      <div className="globe-anno ga-tl">
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.22em",
            marginBottom: 6,
            color: "var(--ink)",
          }}
        >
          GLOBE
        </div>
        <div className="row">
          <span className="label">λ </span>
          <span className="val">{center[0].toFixed(1)}°</span>
        </div>
        <div className="row">
          <span className="label">φ </span>
          <span className="val">{center[1].toFixed(1)}°</span>
        </div>
        {hasMetric && (
          <div className="row" style={{ marginTop: 4 }}>
            <span className="label">LAYERS </span>
            <span className="val">{activeMetrics.length}</span>
          </div>
        )}
      </div>

      <div className="globe-anno ga-tr">
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.22em",
            marginBottom: 6,
            color: "var(--ink)",
          }}
        >
          VIEW
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <span className="label">VIS NODES </span>
          <span className="val">{cities.length}</span>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <span className="label">ZOOM </span>
          <span className="val">{zoom.toFixed(1)}</span>
        </div>
      </div>

      {hasMetric && (
        <div className="globe-legend">
          <div className="gl-title">ACTIVE SIGNALS</div>
          {activeMetrics.map((k) => (
            <div className="gl-row" key={k}>
              <span
                className="gl-sw"
                style={{ background: LAYER_COLORS[k as MetricKey] }}
              />
              {LAYER_LABELS[k as MetricKey]}
            </div>
          ))}
          {activeMetrics.length > 1 && (
            <div className="gl-note">
              <span className="gl-ring" />
              ring = signal disagreement
            </div>
          )}
        </div>
      )}

      <div className="globe-anno ga-bl">
        <div
          style={{
            fontFamily: "var(--display)",
            fontStyle: "italic",
            fontSize: 14,
            color: "var(--ink3)",
          }}
        >
          drag to rotate · scroll to zoom · ⌘K to search
        </div>
      </div>

      <div className="globe-anno ga-br">
        <div>LAST AGENT SWEEP</div>
        <div style={{ color: "var(--ink)", fontWeight: 700 }}>4 MIN AGO</div>
      </div>

      <div className="globe-tools">
        <button
          className={`globe-tool ${drawMode ? "on" : ""}`}
          onClick={() => hasActiveTrip && useMeridianStore.getState().setDrawMode(!drawMode)}
          disabled={!hasActiveTrip}
        >
          ✎ DRAW ROUTE
        </button>
        <LayersControl />
      </div>
      {drawMode && (
        <div className="draw-banner">
          DRAW MODE — click the globe to add the nearest airport · esc to exit
        </div>
      )}

      <div className="zoom-ctrl">
        <button onClick={handleZoomIn} title="Zoom in">
          +
        </button>
        <div className="zoom-readout">{zoomPercent}%</div>
        <button onClick={handleZoomOut} title="Zoom out">
          −
        </button>
        <button onClick={handleZoomReset} title="Reset zoom" style={{ fontSize: 11 }}>
          ⌖
        </button>
      </div>
    </>
  );
}

const GLOBE_LAYERS: { key: LayerKey; label: string }[] = [
  { key: "routes", label: "ROUTES" },
  { key: "cities", label: "CITIES" },
  { key: "weather", label: "WEATHER" },
  { key: "cost", label: "COST" },
  { key: "conflict", label: "CONFLICT" },
  { key: "disaster", label: "DISASTER" },
];

function LayersControl() {
  const { layers, toggleLayer } = useMeridianStore();
  const [open, setOpen] = useState(false);
  return (
    <div className="layers-ctrl">
      <button className={`globe-tool ${open ? "on" : ""}`} onClick={() => setOpen(!open)}>
        ◍ LAYERS
      </button>
      {open && (
        <div className="layers-pop">
          {GLOBE_LAYERS.map(({ key, label }) => (
            <button
              key={key}
              className={`layers-item ${layers[key] ? "on" : ""}`}
              onClick={() => toggleLayer(key)}
            >
              <span className="layers-dot" /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
