// The Meridian score: six parts, each computed from a measured dataset (ADR 0008, ADR 0013).
// A part with no data for the city is null, never a stand-in number. The overall score is the
// weighted mean of the parts that exist, and is itself null when fewer than MIN_PARTS do.

import type { City, MeridianScore } from "../../src/types.js";
import { livabilityFor } from "./livability.js";
import { placeFacts } from "./placeData.js";
import { peekCitySeasonality } from "./seasonality.js";

/** Weights of the overall score. They sum to 1; missing parts are left out and the rest reweighted. */
export const SCORE_WEIGHTS = {
  economics: 0.25,
  quality: 0.2,
  stability: 0.2,
  health: 0.15,
  nomadInfra: 0.1,
  climate: 0.1,
} as const;

export type ScorePart = keyof typeof SCORE_WEIGHTS;

/** Fewest parts an overall score is worked out from. */
export const MIN_PARTS = 3;

/** Year-round Comfort Index: mean of the twelve monthly scores, when climate data is already on hand. */
function climateScore(cityId: string): number | null {
  const peek = peekCitySeasonality(cityId);
  if (peek.kind !== "hit" || peek.months.length !== 12) return null;
  return Math.round(peek.months.reduce((a, m) => a + m.score, 0) / 12);
}

export function computeScore(city: City): MeridianScore {
  const facts = placeFacts(city);
  return {
    overall: null,
    // Affordability from the estimated monthly cost (Eurostat city coefficient or World Bank price level).
    economics: facts.scores.cost,
    // Quality of life from data/livability.json.
    quality: livabilityFor(city.id)?.quality ?? null,
    climate: climateScore(city.id),
    // Political stability (World Bank WGI) and the homicide rate.
    stability: facts.scores.stability,
    // Internet speed measured in the city (Ookla).
    nomadInfra: facts.scores.connectivity,
    // Healthcare coverage (WHO UHC index).
    health: facts.scores.health,
    parts: 0,
  };
}

export function computeNormalized(score: MeridianScore): number | null {
  let sum = 0;
  let weight = 0;
  let parts = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as ScorePart[]) {
    const v = score[key];
    if (typeof v !== "number") continue;
    sum += v * SCORE_WEIGHTS[key];
    weight += SCORE_WEIGHTS[key];
    parts++;
  }
  return parts >= MIN_PARTS && weight > 0 ? Math.round(sum / weight) : null;
}

export function computeFullScore(city: City): MeridianScore {
  const score = computeScore(city);
  score.parts = (Object.keys(SCORE_WEIGHTS) as ScorePart[]).filter((k) => typeof score[k] === "number").length;
  score.overall = computeNormalized(score);
  return score;
}
