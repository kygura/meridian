import { useEffect, useState } from "react";
import { useResolvedTheme } from "../../shell/theme";
import { readToken, toRgba } from "../../ui/palette";

// Canvas colours for the MapLibre globe, read from tokens.css (the original atlas
// palette: parchment land and ocean, ink borders, graticule, burnt-orange accent).
// The shell writes html[data-theme] in an effect that runs after ours, so read on the
// next frame.

export type RGBA = [number, number, number, number];

export interface MapColors {
  theme: "light" | "dark";
  /** Page colour around the globe. */
  bg: string;
  land: string;
  water: string;
  border: string;
  grat: string;
  equator: string;
  label: string;
  halo: string;
  /** City dots: ink. */
  dot: string;
  /** Paper: casings and dot strokes. */
  paper: string;
  accent: string;
  /** Booked flights. */
  success: string;
  /** Sequential ramp, low to high (7 steps) as CSS colour strings. */
  ramp: string[];
  /** Year colours for past journeys: oldest -> newest. */
  yearFrom: RGBA;
  yearTo: RGBA;
}

function read(theme: "light" | "dark"): MapColors {
  const t = (n: string, fallback: string) => readToken(n) || fallback;
  const dark = theme === "dark";
  const ramp = [0, 1, 2, 3, 4, 5, 6].map((i) => t(`--ramp-${i}`, "#888888"));
  const ink = t("--ink", dark ? "#eef2f8" : "#1c1814");
  return {
    theme,
    bg: t("--bg", dark ? "#0b0f17" : "#f4ecd8"),
    land: t("--land", dark ? "#1f2738" : "#d6c6a2"),
    water: t("--ocean", dark ? "#0e1320" : "#e9dcbe"),
    border: t("--border-country", dark ? "rgba(238,242,248,0.45)" : "rgba(28,24,20,0.5)"),
    grat: t("--grat", dark ? "rgba(238,242,248,0.08)" : "rgba(28,24,20,0.10)"),
    equator: t("--equator", dark ? "rgba(238,242,248,0.22)" : "rgba(28,24,20,0.22)"),
    label: t("--map-label", dark ? "#b8c2d6" : "#3a342b"),
    halo: t("--land", dark ? "#1f2738" : "#d6c6a2"),
    dot: t("--map-dot", ink),
    paper: t("--surface", dark ? "#161c2c" : "#fbf5e6"),
    accent: t("--accent", dark ? "#f59e0b" : "#c2680c"),
    success: t("--success", dark ? "#2dd4bf" : "#0f766e"),
    ramp,
    // Oldest trips fade toward muted ink; the newest burn in the accent.
    yearFrom: toRgba(t("--muted", dark ? "#8a94a9" : "#6b624f")),
    yearTo: toRgba(t("--accent", dark ? "#f59e0b" : "#c2680c")),
  };
}

export function useMapColors(): MapColors {
  const theme = useResolvedTheme();
  const [colors, setColors] = useState<MapColors>(() => read(theme));
  useEffect(() => {
    const raf = requestAnimationFrame(() => setColors(read(theme)));
    return () => cancelAnimationFrame(raf);
  }, [theme]);
  return colors;
}

export function mixRgba(a: RGBA, b: RGBA, t: number, alpha = 255): RGBA {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
    alpha,
  ];
}

export function withAlpha(c: RGBA, alpha: number): RGBA {
  return [c[0], c[1], c[2], alpha];
}

/** RGBA tuple -> CSS colour for MapLibre paint properties. */
export function cssColor(c: RGBA): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${+(c[3] / 255).toFixed(3)})`;
}
