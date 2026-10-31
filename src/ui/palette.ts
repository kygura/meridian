import { useMemo } from "react";
import { useResolvedTheme } from "../shell/theme";

// Read colour tokens from CSS for canvas code (MapLibre styles, deck.gl layers),
// which cannot use var(). Re-read when the resolved theme changes.

/** Current value of a CSS variable on <html>, e.g. readToken("--accent"). */
export function readToken(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** "#2563eb" or "rgb(…)"/"rgba(…)" -> [r, g, b, a] (0-255) for deck.gl. */
export function toRgba(color: string, alpha = 255): [number, number, number, number] {
  const c = color.trim();
  if (c.startsWith("#")) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split("").map((x) => x + x).join("");
    const n = parseInt(hex.slice(0, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : alpha;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [r, g, b, a === undefined || Number.isNaN(a) ? alpha : Math.round(a * 255)];
  }
  return [0, 0, 0, alpha];
}

export const MAP_TOKENS = [
  "--bg",
  "--surface",
  "--text",
  "--muted",
  "--border",
  "--accent",
  "--success",
  "--warning",
  "--danger",
  "--map-land",
  "--map-water",
  "--map-border",
  "--map-label",
  "--map-arc",
  "--map-dot",
  "--ramp-0",
  "--ramp-1",
  "--ramp-2",
  "--ramp-3",
  "--ramp-4",
  "--ramp-5",
  "--ramp-6",
] as const;

export type MapToken = (typeof MAP_TOKENS)[number];

/** Token values for canvas drawing, refreshed when the theme flips. */
export function usePalette(): { theme: "light" | "dark"; get: (name: MapToken | string) => string } {
  const theme = useResolvedTheme();
  return useMemo(() => {
    const cache = new Map<string, string>();
    return {
      theme,
      get: (name: string) => {
        if (!cache.has(name)) cache.set(name, readToken(name));
        return cache.get(name)!;
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
}

/** The sequential ramp as CSS var names, low to high. */
export const RAMP_VARS = ["--ramp-0", "--ramp-1", "--ramp-2", "--ramp-3", "--ramp-4", "--ramp-5", "--ramp-6"] as const;
/** The diverging ramp, most negative to most positive. */
export const DIVERGING_VARS = ["--div-neg-3", "--div-neg-2", "--div-neg-1", "--div-0", "--div-pos-1", "--div-pos-2", "--div-pos-3"] as const;

/** Pick a ramp step (0..6) for a 0..1 value. */
export function rampStep(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.min(6, Math.round(t * 6)));
}
