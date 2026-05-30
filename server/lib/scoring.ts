import type { City, MeridianScore } from "../../src/types.js";

/**
 * Simple deterministic hash from a string, returns a number 0-1.
 */
function hashStr(s: string, seed: number = 0): number {
  let h = seed | 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  // Map to 0-1
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Generate a pseudo-score in a range, deterministic by city name + metric key.
 */
function pseudoScore(city: City, metric: string, min = 30, max = 95): number {
  const val = hashStr(`${city.name}-${city.country}-${metric}`, metric.length);
  return Math.round(min + val * (max - min));
}

/**
 * Climate comfort approximation based on latitude.
 * Closer to equator = warmer; mid-latitudes score highest for comfort.
 */
function climateFromLat(lat: number): number {
  const absLat = Math.abs(lat);
  // Peak comfort around 20-30 degrees latitude
  if (absLat <= 30) return Math.round(70 + (30 - absLat));
  if (absLat <= 50) return Math.round(90 - (absLat - 30) * 1.5);
  return Math.round(60 - (absLat - 50));
}

export function computeScore(city: City): MeridianScore {
  const economics = pseudoScore(city, "economics", 35, 90);
  const quality = pseudoScore(city, "quality", 30, 95);
  const climate = Math.min(100, Math.max(0, climateFromLat(city.lat)));
  const stability = pseudoScore(city, "stability", 25, 95);
  const nomadInfra = pseudoScore(city, "nomadInfra", 20, 90);

  return { overall: 0, economics, quality, climate, stability, nomadInfra };
}

export function computeNormalized(score: MeridianScore): number {
  const weighted =
    score.economics * 0.3 +
    score.quality * 0.25 +
    score.climate * 0.15 +
    score.stability * 0.2 +
    score.nomadInfra * 0.1;

  return Math.round(weighted);
}

export function computeFullScore(city: City): MeridianScore {
  const score = computeScore(city);
  score.overall = computeNormalized(score);
  return score;
}
