// Quality of life and beauty per city (data/livability.json, built by
// scripts/build-livability.ts). Read once, lazily; the file ships with the server.

import { readFileSync } from "fs";
import { join } from "path";
import { getCities } from "./cities.js";
import type { MetricSurface } from "../../src/types.js";

export interface LivabilityRecord {
  /** 0-100: how good it is to live there. */
  quality: number | null;
  qualityParts: { hdi: number | null; happiness: number | null; safety: number | null; air: number | null };
  /** Share of the quality weight measured at the city itself (0-1). */
  local: number;
  /** 0-100: natural setting (mountains, sea, lakes). */
  setting: number | null;
  settingParts: { relief: number; water: number } | null;
  /** 0-100: built character (heritage, how photographed, notable places). */
  character: number | null;
  characterParts: { heritage: number | null; photos: number | null; notable: number | null };
  /** 0-100: setting and character, half each. */
  beauty: number | null;
  raw: Record<string, number | string | boolean | undefined>;
}

interface LivabilityFile {
  version: number;
  builtAt: string;
  sources: Record<string, string>;
  cities: Record<string, LivabilityRecord>;
}

let file: LivabilityFile | null | undefined;

function load(): LivabilityFile | null {
  if (file !== undefined) return file;
  try {
    file = JSON.parse(readFileSync(join(process.cwd(), "data/livability.json"), "utf-8")) as LivabilityFile;
  } catch {
    console.warn("[livability] data/livability.json missing — run scripts/build-livability.ts");
    file = null;
  }
  return file;
}

/** Test seam: re-read the file on next use. */
export function resetLivability(): void {
  file = undefined;
}

export function livabilityFor(cityId: string): LivabilityRecord | null {
  return load()?.cities[cityId] ?? null;
}

export function livabilitySources(): { builtAt: string | null; sources: Record<string, string> } {
  const f = load();
  return { builtAt: f?.builtAt ?? null, sources: f?.sources ?? {} };
}

/** Compact rows for the live-vs-love chart: [cityId, quality, beauty, setting, character]. */
export function livabilityRows(): [string, number, number, number | null, number | null][] {
  const f = load();
  if (!f) return [];
  const rows: [string, number, number, number | null, number | null][] = [];
  for (const [id, r] of Object.entries(f.cities))
    if (r.quality !== null && r.beauty !== null) rows.push([id, r.quality, r.beauty, r.setting, r.character]);
  return rows;
}

function surface(id: "quality" | "beauty", label: string, pick: (r: LivabilityRecord) => number | null, unit: string): MetricSurface {
  const f = load();
  const values: MetricSurface["values"] = [];
  for (const c of getCities()) {
    const r = f?.cities[c.id];
    const v = r ? pick(r) : null;
    if (v === null || v === undefined) continue;
    values.push({
      locationId: c.id,
      lat: c.lat,
      lng: c.lng,
      raw: v,
      unit,
      normalized: v,
      label: v >= 70 ? "High" : v >= 45 ? "Medium" : "Low",
    });
  }
  return {
    id,
    label,
    category: id,
    source: f ? "meridian-livability" : "unavailable",
    updatedAt: f?.builtAt ?? new Date(0).toISOString(),
    granularity: "city",
    confidence: "medium",
    values,
  };
}

/** How good it is to live there: HDI, happiness, safety, air (see the build script). */
export const qualitySurface = () => surface("quality", "Quality of Life", (r) => r.quality, "index");
/** How beautiful it is: natural setting and built character. */
export const beautySurface = () => surface("beauty", "Beauty", (r) => r.beauty, "index");
