// Quality of life and beauty (GET /api/livability, /api/livability/:cityId).
// Pure helpers plus two small fetchers; no React.

import { apiUrl } from "./api";

/** [cityId, quality, beauty, setting, character] */
export type LivabilityRow = [string, number, number, number | null, number | null];

export interface LivabilityDetail {
  cityId: string;
  quality: number | null;
  qualityParts: { hdi: number | null; happiness: number | null; safety: number | null; air: number | null };
  local: number;
  setting: number | null;
  settingParts: { relief: number; water: number } | null;
  character: number | null;
  characterParts: { heritage: number | null; photos: number | null; notable: number | null };
  beauty: number | null;
  raw: {
    hdi?: number;
    happiness?: number;
    homicides?: number;
    pm25?: number;
    pm25Local?: boolean;
    reliefM?: number;
    seaShare?: number;
    lake?: "3km" | "10km";
    heritageKm?: number;
    photos?: number;
    notable?: number;
  };
  builtAt: string | null;
  sources: Record<string, string>;
}

let rowsPromise: Promise<{ rows: LivabilityRow[]; builtAt: string | null; sources: Record<string, string> }> | null = null;

/** All cities' scores, fetched once per session. */
export function fetchLivabilityRows() {
  rowsPromise ??= fetch(apiUrl("/api/livability"))
    .then((r) => {
      if (!r.ok) throw new Error(`livability ${r.status}`);
      return r.json();
    })
    .catch((e) => {
      rowsPromise = null;
      throw e;
    });
  return rowsPromise;
}

export async function fetchLivability(cityId: string): Promise<LivabilityDetail | null> {
  const r = await fetch(apiUrl(`/api/livability/${encodeURIComponent(cityId)}`));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`livability ${r.status}`);
  return r.json();
}

export type BeautyAxis = "beauty" | "setting" | "character";

export const AXIS_LABEL: Record<BeautyAxis, string> = {
  beauty: "Beauty",
  setting: "Natural setting",
  character: "Built character",
};

/** The y value of a row for the chosen beauty axis. */
export function axisValue(row: LivabilityRow, axis: BeautyAxis): number | null {
  return axis === "beauty" ? row[2] : axis === "setting" ? row[3] : row[4];
}

export type Quadrant = "both" | "beauty" | "living" | "neither";

/** Which corner of live vs love a city sits in, split at `cut` on both axes. */
export function quadrant(quality: number, beauty: number, cut = 60): Quadrant {
  if (quality >= cut) return beauty >= cut ? "both" : "living";
  return beauty >= cut ? "beauty" : "neither";
}

export const QUADRANT_LABEL: Record<Quadrant, string> = {
  both: "Beautiful and liveable",
  beauty: "Stunning, harder to live in",
  living: "Comfortable, plainer",
  neither: "Less of both, by these measures",
};

/** "Best of both": ranked by the weaker of the two scores, then their sum. */
export function bestOfBoth(rows: LivabilityRow[], axis: BeautyAxis = "beauty", n = 20): LivabilityRow[] {
  return rows
    .filter((r) => axisValue(r, axis) !== null)
    .sort((a, b) => {
      const wa = Math.min(a[1], axisValue(a, axis)!);
      const wb = Math.min(b[1], axisValue(b, axis)!);
      return wb - wa || b[1] + axisValue(b, axis)! - (a[1] + axisValue(a, axis)!);
    })
    .slice(0, n);
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** Plain-language facts behind a city's scores, for the city panel. */
export function livabilityFacts(d: LivabilityDetail): { quality: string[]; setting: string[]; character: string[] } {
  const r = d.raw;
  const quality: string[] = [];
  if (r.hdi !== undefined) quality.push(`Human development ${r.hdi.toFixed(3)} (country)`);
  if (r.happiness !== undefined) quality.push(`Life satisfaction ${r.happiness.toFixed(1)} / 10 (country)`);
  if (r.homicides !== undefined) quality.push(`${r.homicides < 10 ? r.homicides.toFixed(1) : Math.round(r.homicides)} homicides per 100,000 (country)`);
  if (r.pm25 !== undefined) quality.push(`Fine particles ${r.pm25} µg/m³ ${r.pm25Local ? "(measured here)" : "(country average)"}; WHO guideline 5`);
  const setting: string[] = [];
  if (r.reliefM !== undefined) setting.push(r.reliefM >= 100 ? `${fmt(r.reliefM)} m of relief within 15 km` : "Flat surroundings");
  if (r.seaShare) setting.push("On the sea");
  if (r.lake) setting.push(r.lake === "3km" ? "Lake within 3 km" : "Lake within 10 km");
  const character: string[] = [];
  if (r.heritageKm !== undefined) character.push(r.heritageKm <= 1 ? "A World Heritage site in town" : `World Heritage site ${r.heritageKm} km away`);
  if (r.photos !== undefined) character.push(r.photos >= 2000 ? "Heavily photographed centre" : r.photos >= 200 ? "Well photographed centre" : "Rarely photographed");
  if (r.notable !== undefined) character.push(`${fmt(r.notable)}${r.notable >= 500 ? "+" : ""} notable places within 5 km`);
  return { quality, setting, character };
}
