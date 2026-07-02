/** Trip identity palette — saturated but legible on both parchment and night themes. */
export const TRIP_COLORS: string[] = [
  "#b3261e", // vermilion
  "#0f766e", // teal
  "#6d28d9", // violet
  "#c2680c", // ochre
  "#1d4ed8", // cobalt
  "#be185d", // magenta
  "#4d7c0f", // olive
  "#0e7490", // petrol
  "#7c2d12", // rust
  "#a16207", // brass
  "#166534", // forest
  "#5b21b6", // indigo
];

const LEGACY: Record<string, string> = {
  a: "#b3261e",
  b: "#0f766e",
  c: "#6d28d9",
};

/** Map legacy "a"/"b"/"c" trip colors to hexes; pass real hexes through. */
export function resolveTripColor(color: string): string {
  return LEGACY[color] ?? color;
}

/** Random palette color, avoiding ones already used by other trips when possible. */
export function randomTripColor(used: string[]): string {
  const usedSet = new Set(used.map(resolveTripColor));
  const free = TRIP_COLORS.filter((c) => !usedSet.has(c));
  const pool = free.length > 0 ? free : TRIP_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}
