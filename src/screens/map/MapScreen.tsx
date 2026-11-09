import "./map.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { useMeridianStore } from "../../store";
import { useUIStore, openCity } from "../../shell/uiStore";
import { navigate } from "../../lib/router";
import { refreshJourneys } from "../../lib/journalApi";
import { fetchRegions, type RegionSeason } from "../../lib/seasonalityApi";
import { Button, Fab, IconButton, Spinner, useIsDesktop, useJournalToken } from "../../ui";
import { IconMinus, IconPlus, IconRefresh } from "../../ui/icons";
import { useMapPrefs } from "../../shell/mapPrefs";
import { loadCountries, type CountryCollection } from "./countries";
import { buildStyle, CITY_LABEL_LAYERS, labelFeatures, labelText, repaintBasemap, tintCountries } from "./basemap";

// Arabic and Hebrew native names need letter joining and right-to-left order, which
// MapLibre gets from this plugin (self-hosted in public/vendor, BSD-2-Clause). Lazy:
// it loads only when a right-to-left label first appears.
if (typeof window !== "undefined" && maplibregl.getRTLTextPluginStatus() === "unavailable") {
  maplibregl.setRTLTextPlugin(`${window.location.origin}/vendor/mapbox-gl-rtl-text-0.3.0.js`, true).catch(() => {});
}

/** Chinese, Japanese and Korean labels are drawn with the device's own fonts: prefer a serif. */
const CJK_FONTS = "'Noto Serif CJK JP', 'Noto Serif JP', 'Hiragino Mincho ProN', 'Songti SC', 'Noto Serif KR', 'AppleMyungjo', 'Source Han Serif', serif";
import {
  applyOverlayPaint,
  buildBookings,
  buildCityData,
  buildOverlayData,
  buildPast,
  buildPlanned,
  cityFilter,
  describe,
  maxRankAt,
  overlayLayers,
  OVERLAY_SOURCES,
  PICK_LAYERS,
  type OverlayData,
  type PickDatum,
} from "./overlays";
import { haversineKm } from "../../lib/geo";
import { useMapColors } from "./useMapColors";
import LayerMenu from "./LayerMenu";
import MapFinder from "./MapFinder";
import { conflictCountries, eventData, metricColours, newsAnomalyData, runFinder, seedAnomalyData } from "./finder";
import { useAllCityClimate, useAnomalies, useMetricSurfaces, useMonthEvents } from "./useFinderData";
import { loadNews } from "../world/useNews";
import { activeThresholds, indexSurfaces, type MetricId } from "../../lib/cityMetrics";

export interface MapScreenProps {
  /**
   * True while the route is the map. The shell keeps MapScreen mounted on every route
   * (hidden with display:none off-map) so the map instance survives; call map.resize()
   * when this turns true, and pause expensive work while false.
   */
  active: boolean;
}

const START_CENTER: [number, number] = [10, 28];

/** Zoom at which the whole globe fills ~84% of the shorter side of the map. */
function fitGlobeZoom(el: HTMLElement): number {
  const side = Math.min(el.clientWidth || 800, el.clientHeight || 800);
  // MapLibre's globe radius in px is worldSize / 2π = 512·2^z / 2π.
  return Math.max(0.4, Math.log2((0.42 * side * 2 * Math.PI) / 512));
}
const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m) return iso;
  return DATE_FMT.format(new Date(Date.UTC(y, m - 1, d || 1)));
}

interface Tip {
  x: number;
  y: number;
  title: string;
  sub?: string;
}

/** Owner: map agent. Full-bleed under its own floating controls (no Page wrapper). */
export default function MapScreen({ active }: MapScreenProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const pickRef = useRef<OverlayData["pick"] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [zoom, setZoom] = useState(1.6);
  const [center, setCenter] = useState<[number, number]>(START_CENTER);
  const [countries, setCountries] = useState<CountryCollection | null>(null);
  const [countriesError, setCountriesError] = useState(false);
  const [regions, setRegions] = useState<RegionSeason[] | null>(null);
  const [regionsError, setRegionsError] = useState(false);
  const [regionsAttempt, setRegionsAttempt] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const colors = useMapColors();
  const isDesktop = useIsDesktop();
  const prefs = useMapPrefs((s) => s.layers);
  const month = useMapPrefs((s) => s.month);
  const climateMode = useMapPrefs((s) => s.climateMode);
  const climate = useMapPrefs((s) => s.climate);
  const metricPrefs = useMapPrefs((s) => s.metrics);
  const onlyMatches = useMapPrefs((s) => s.onlyMatches);
  const avoidConflicts = useMapPrefs((s) => s.avoidConflicts);
  const cityNames = useMapPrefs((s) => s.cityNames);
  const ticker = useMeridianStore((s) => s.ticker);

  const cities = useMeridianStore((s) => s.cities);
  const trips = useMeridianStore((s) => s.trips);
  const bookings = useMeridianStore((s) => s.bookings);
  const journeys = useMeridianStore((s) => s.journeys);
  const selectedCityId = useUIStore((s) => s.cityPanel?.cityId ?? null);
  const { token, unlocked } = useJournalToken();

  // ── Globe, created once ───────────────────────────────────────────
  useEffect(() => {
    const el = container.current;
    if (!el || mapRef.current) return;
    const startZoom = fitGlobeZoom(el);
    const map = new maplibregl.Map({
      container: el,
      style: buildStyle(
        colors,
        overlayLayers(colors, null, maxRankAt(startZoom), null, useMapPrefs.getState().onlyMatches),
        useMapPrefs.getState().cityNames
      ),
      localIdeographFontFamily: CJK_FONTS,
      center: START_CENTER,
      zoom: startZoom,
      minZoom: 0.4,
      maxZoom: 12,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    // The original Meridian globe (the style asks for it too; this survives setStyle).
    map.on("style.load", () => map.setProjection({ type: "globe" }));
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __meridianMap?: maplibregl.Map }).__meridianMap = map;
    setZoom(startZoom);

    let zoomRaf = 0;
    map.on("move", () => {
      if (zoomRaf) return;
      zoomRaf = requestAnimationFrame(() => {
        zoomRaf = 0;
        setZoom(Math.round(map.getZoom() * 4) / 4);
        const c = map.getCenter();
        setCenter([Math.round(c.lng * 10) / 10, Math.round(c.lat * 10) / 10]);
      });
    });
    map.on("load", () => setLoaded(true));
    map.on("movestart", () => setTip(null));

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (zoomRaf) cancelAnimationFrame(zoomRaf);
      map.remove();
      mapRef.current = null;
      setLoaded(false);
    };
    // Created once; theme changes repaint below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The wrapper is display:none off-map; resize when we come back.
  useEffect(() => {
    if (!active) {
      setTip(null);
      return;
    }
    const raf = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // ── Basemap data ─────────────────────────────────────────────────
  const [countriesAttempt, setCountriesAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setCountriesError(false);
    loadCountries()
      .then((fc) => live && setCountries(fc))
      .catch(() => live && setCountriesError(true));
    return () => {
      live = false;
    };
  }, [countriesAttempt]);

  useEffect(() => {
    if (!prefs.seasons || regions) return;
    let live = true;
    setRegionsError(false);
    const cached = useMeridianStore.getState().seasonalityRegions;
    if (cached) {
      setRegions(cached);
      return;
    }
    fetchRegions()
      .then((r) => {
        const store = useMeridianStore.getState();
        store.setSeasonalityRegions(r.regions);
        store.setSeasonalityWindow(r.window);
        if (live) setRegions(r.regions);
      })
      .catch(() => live && setRegionsError(true));
    return () => {
      live = false;
    };
  }, [prefs.seasons, regions, regionsAttempt]);

  // ── Finder: climate search, metric thresholds, events, anomalies ──
  const cityClimate = useAllCityClimate(prefs.seasons);
  const metricIds = useMemo(() => {
    if (!prefs.metrics) return [] as MetricId[];
    const ids = activeThresholds(metricPrefs.thresholds).map(([id]) => id);
    if (metricPrefs.colorBy !== "none") ids.push(metricPrefs.colorBy);
    return ids;
  }, [prefs.metrics, metricPrefs]);
  const { surfaces } = useMetricSurfaces(metricIds);
  const metricIndex = useMemo(() => indexSurfaces(surfaces, metricIds), [surfaces, metricIds]);
  const events = useMonthEvents(prefs.events, month);
  const anomalies = useAnomalies(prefs.anomalies);
  useEffect(() => {
    if (prefs.anomalies) void loadNews();
  }, [prefs.anomalies]);

  const excluded = useMemo(
    () => (prefs.anomalies && avoidConflicts && anomalies.data ? conflictCountries(anomalies.data.items) : null),
    [prefs.anomalies, avoidConflicts, anomalies.data]
  );
  const finder = useMemo(
    () =>
      runFinder({
        cities,
        month,
        climate: prefs.seasons ? climate : null,
        climateData: cityClimate.data,
        thresholds: prefs.metrics ? activeThresholds(metricPrefs.thresholds) : [],
        metricIndex,
        excluded,
      }),
    [cities, month, prefs.seasons, prefs.metrics, climate, cityClimate.data, metricPrefs.thresholds, metricIndex, excluded]
  );
  const styling = useMemo(
    () => ({
      filtering: finder.filtering && !finder.pending,
      matches: finder.matches,
      metric: prefs.metrics ? metricColours(metricIndex, metricPrefs.colorBy) : null,
      onlyMatches,
    }),
    [finder, prefs.metrics, metricIndex, metricPrefs.colorBy, onlyMatches]
  );
  const eventPoints = useMemo(() => (events.data ? eventData(events.data) : []), [events.data]);
  const anomalyPoints = useMemo(() => {
    if (!prefs.anomalies) return [];
    const seed = anomalies.data
      ? seedAnomalyData(
          anomalies.data.items.filter((a) => !a.months || a.months.includes(month)),
          month
        )
      : [];
    return [...seed, ...newsAnomalyData(ticker, cities)];
  }, [prefs.anomalies, anomalies.data, month, ticker, cities]);

  const tinted = useMemo(
    () =>
      countries
        ? tintCountries(countries, prefs.seasons ? regions : null, {
            mode: climateMode,
            month,
            filter: climate,
            ramps: colors.ramps,
            excluded: excluded ?? undefined,
          })
        : null,
    [countries, prefs.seasons, regions, month, climateMode, climate, colors.ramps, excluded]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !tinted) return;
    (map.getSource("countries") as maplibregl.GeoJSONSource | undefined)?.setData(tinted);
  }, [loaded, tinted]);

  const labels = useMemo(() => labelFeatures(cities), [cities]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource("city-labels") as maplibregl.GeoJSONSource | undefined)?.setData(labels);
    const vis = prefs.cities ? "visible" : "none";
    for (const id of CITY_LABEL_LAYERS)
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", vis);
        map.setLayoutProperty(id, "text-field", labelText(cityNames));
      }
  }, [loaded, labels, prefs.cities, cityNames]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && loaded) repaintBasemap(map, colors);
  }, [loaded, colors]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && loaded) applyOverlayPaint(map, colors, hoverId);
  }, [loaded, colors, hoverId]);

  // ── Journal (past trips) ─────────────────────────────────────────
  useEffect(() => {
    if (prefs.past && unlocked && journeys === null) refreshJourneys().catch(() => {});
  }, [prefs.past, unlocked, token, journeys]);

  // ── Trip overlays (native GeoJSON layers on the globe) ───────────
  const cityData = useMemo(() => buildCityData(cities), [cities]);
  const past = useMemo(() => (unlocked && journeys ? buildPast(journeys, cities) : null), [unlocked, journeys, cities]);
  const planned = useMemo(() => buildPlanned(trips, cities), [trips, cities]);
  const bookingData = useMemo(() => buildBookings(bookings, cities), [bookings, cities]);
  const maxRank = maxRankAt(zoom);

  const overlayData = useMemo(
    () =>
      buildOverlayData({
        colors,
        show: prefs,
        past,
        planned,
        bookings: bookingData,
        cities: cityData,
        selectedCityId,
        styling,
        events: eventPoints,
        anomalies: anomalyPoints,
      }),
    [colors, prefs, past, planned, bookingData, cityData, selectedCityId, styling, eventPoints, anomalyPoints]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    pickRef.current = overlayData.pick;
    for (const id of OVERLAY_SOURCES)
      (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(overlayData.sources[id]);
  }, [loaded, overlayData]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && loaded && map.getLayer("ov-cities")) map.setFilter("ov-cities", cityFilter(maxRank, selectedCityId, onlyMatches && styling.filtering));
  }, [loaded, maxRank, selectedCityId, onlyMatches, styling.filtering]);

  /** Topmost overlay object under a screen point (a few px of slop for thin lines). */
  const pickAt = useCallback((pt: maplibregl.Point): PickDatum | null => {
    const map = mapRef.current;
    const pick = pickRef.current;
    if (!map || !pick) return null;
    const layers = PICK_LAYERS.map(([id]) => id).filter((id) => map.getLayer(id));
    const r = 5;
    const feats = map.queryRenderedFeatures(
      [
        [pt.x - r, pt.y - r],
        [pt.x + r, pt.y + r],
      ],
      { layers }
    );
    if (!feats.length) return null;
    const rank = (id: string) => PICK_LAYERS.findIndex(([l]) => l === id);
    feats.sort((a, b) => rank(a.layer.id) - rank(b.layer.id));
    for (const f of feats) {
      const entry = PICK_LAYERS.find(([l]) => l === f.layer.id);
      const i = f.properties?.i;
      if (!entry || typeof i !== "number") continue;
      const d = pick[entry[1]][i] as PickDatum | undefined;
      if (d) return d;
    }
    return null;
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const canvas = map.getCanvas();
    let raf = 0;
    let last: maplibregl.MapMouseEvent | null = null;
    const hover = () => {
      raf = 0;
      if (!last) return;
      const e = last;
      const d = pickAt(e.point);
      if (!d) {
        setTip(null);
        setHoverId(null);
        canvas.style.cursor = "";
        return;
      }
      const text = describe(d, fmtDate);
      setTip(text ? { x: e.point.x, y: e.point.y, ...text } : null);
      setHoverId(
        d.kind === "city"
          ? d.id
          : d.kind === "arc" || d.kind === "stop"
            ? d.journeyId
            : d.kind === "booking"
              ? d.bookingId
              : d.kind === "event"
                ? `${d.eventId}|${d.cityId}`
                : d.kind === "anomaly"
                  ? d.id
                  : d.tripId
      );
      canvas.style.cursor = "pointer";
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(hover);
    };
    const onOut = () => {
      last = null;
      setTip(null);
      setHoverId(null);
      canvas.style.cursor = "";
    };
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const d = pickAt(e.point);
      if (!d) return;
      setTip(null);
      switch (d.kind) {
        case "city":
          openCity(d.id);
          break;
        case "stop":
          if (d.cityId) openCity(d.cityId);
          else navigate(`/trips/past/${encodeURIComponent(d.journeyId)}`);
          break;
        case "arc":
          navigate(`/trips/past/${encodeURIComponent(d.journeyId)}`);
          break;
        case "route":
          navigate(`/trips/plan/${encodeURIComponent(d.tripId)}`);
          break;
        case "node": {
          const city = useMeridianStore
            .getState()
            .trips.find((t) => t.id === d.tripId)
            ?.nodes.find((n) => n.name === d.name);
          if (city) openCity(city.cityId);
          break;
        }
        case "booking":
          navigate(d.tripId ? `/trips/plan/${encodeURIComponent(d.tripId)}` : "/plan/flights");
          break;
        case "event":
          openCity(d.cityId);
          break;
        case "anomaly":
          if (d.cityId) openCity(d.cityId);
          break;
      }
    };
    map.on("mousemove", onMove);
    map.on("mouseout", onOut);
    map.on("click", onClick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      map.off("mousemove", onMove);
      map.off("mouseout", onOut);
      map.off("click", onClick);
    };
  }, [loaded, pickAt]);

  // ── Bring the picked city into view ──────────────────────────────
  // Runs a frame later so a map that was just un-hidden has been resized first.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !active || !selectedCityId) return;
    const raf = requestAnimationFrame(() => {
      const city = useMeridianStore.getState().cities.find((c) => c.id === selectedCityId);
      if (!city) return;
      map.resize();
      const el = map.getContainer();
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const panelW = isDesktop ? Math.min(460, w / 2) : 0;
      const panelH = isDesktop ? 0 : h * 0.5;
      const pt = map.project([city.lng, city.lat]);
      // On the globe, a point past the horizon still projects somewhere on screen.
      const c = map.getCenter();
      const facing = haversineKm([c.lng, c.lat], [city.lng, city.lat]) < 6500;
      const inView = facing && pt.x > 24 && pt.x < w - panelW - 24 && pt.y > 24 && pt.y < h - panelH - 24;
      if (inView) return;
      map.easeTo({
        center: [city.lng, city.lat],
        zoom: Math.max(map.getZoom(), 3.2),
        // Centre the city in the part of the map the panel leaves visible.
        offset: [-panelW / 2, -panelH / 2],
        duration: 700,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedCityId, active, isDesktop]);

  const zoomBy = (d: number) => mapRef.current?.easeTo({ zoom: mapRef.current.getZoom() + d, duration: 250 });

  const pastLoading = prefs.past && unlocked && journeys === null;
  const years = past && past.arcs.length + past.stops.length > 0 ? { min: past.minYear, max: past.maxYear } : null;

  return (
    <div className="map-screen" data-active={active || undefined}>
      <div ref={container} className="map-canvas" aria-label="Map of your trips" role="region" />

      {!loaded ? (
        <div className="map-loading" role="status">
          <Spinner label="Loading map" />
        </div>
      ) : null}

      {tip ? (
        <div className="map-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          <span className="map-tip-title">{tip.title}</span>
          {tip.sub ? <span className="map-tip-sub">{tip.sub}</span> : null}
        </div>
      ) : null}

      {isDesktop ? (
        <dl className="map-readout" aria-hidden="true">
          <span className="map-kicker">Globe</span>
          <dt>λ</dt>
          <dd>{center[0].toFixed(1)}°</dd>
          <dt>φ</dt>
          <dd>{center[1].toFixed(1)}°</dd>
        </dl>
      ) : null}
      {isDesktop && !prefs.seasons && zoom < 3 ? <p className="map-hint">Drag to rotate · scroll to zoom</p> : null}

      <div className="map-controls">
        <LayerMenu colors={colors} years={years} pastLoading={pastLoading} />
        {isDesktop ? (
          <div className="map-zoom" role="group" aria-label="Zoom">
            <IconButton label="Zoom in" icon={<IconPlus />} variant="secondary" onClick={() => zoomBy(1)} />
            <span className="map-zoom-level" aria-hidden="true">
              {Math.round(((zoom - 0.4) / (12 - 0.4)) * 100)}%
            </span>
            <IconButton label="Zoom out" icon={<IconMinus />} variant="secondary" onClick={() => zoomBy(-1)} />
          </div>
        ) : null}
      </div>

      {countriesError ? (
        <div className="map-notice" role="alert">
          <span>Couldn’t load the map outlines.</span>
          <Button size="sm" variant="ghost" icon={<IconRefresh />} onClick={() => setCountriesAttempt((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : null}

      {prefs.seasons || prefs.metrics || prefs.events || prefs.anomalies ? (
        <MapFinder
          result={finder}
          regionsStatus={regionsError ? "error" : regions ? "ready" : "loading"}
          climateStatus={cityClimate.status}
          onRetry={() => {
            if (regionsError) setRegionsAttempt((n) => n + 1);
            if (cityClimate.status === "error") cityClimate.retry();
          }}
          anomaliesAsOf={anomalies.data?.asOf}
          eventCount={prefs.events && events.status === "ready" ? eventPoints.length : undefined}
        />
      ) : null}

      {/* Desktop already has "Log a trip" in the sidebar; the floating button is the phone's way in. */}
      {!isDesktop ? (
        <Fab icon={<IconPlus />} className="map-fab" onClick={() => useMeridianStore.getState().openQuickLog()}>
          Log a trip
        </Fab>
      ) : null}
    </div>
  );
}
