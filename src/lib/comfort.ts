// The Comfort Index formula (ADR 0002, ADR 0014). Pure and shared by the server
// (scoring, backfill) and the client (the breakdown shown wherever the index is explained).
//
//   score = temperature comfort - rain penalty - air penalty, clamped to 0-100.
//
// Temperature contributes 100 inside the 18-26C comfort band, falling off linearly to 0 at
// -5C and 40C. Rain subtracts 0 at <=30mm/month, scaling to 35 at >=250mm/month. Air subtracts
// 0 at a monthly mean PM2.5 of <=10 ug/m3, scaling to 40 at >=75 ug/m3 (the WHO 24-hour interim target 1). A month with no
// air-quality figure has no air penalty applied (and says so), never an assumed one.

export const TEMP_COMFORT_MIN = 18;
export const TEMP_COMFORT_MAX = 26;
export const TEMP_FLOOR = -5;
export const TEMP_CEILING = 40;

export const PRECIP_FREE_MM = 30;
export const PRECIP_MAX_MM = 250;
export const PRECIP_MAX_PENALTY = 35;

export const AIR_FREE_UGM3 = 10;
export const AIR_MAX_UGM3 = 75;
export const AIR_MAX_PENALTY = 40;

export interface ComfortBreakdown {
  /** Temperature comfort, 0-100 (before penalties). */
  temp: number;
  /** Rain penalty, 0-35 points subtracted. */
  rain: number;
  /** Air-quality penalty, 0-40 points subtracted; 0 when `airKnown` is false. */
  air: number;
  /** False when no PM2.5 figure was available, so `air` is an absence rather than a clean result. */
  airKnown: boolean;
  /** Final Comfort Index, 0-100, integer. */
  score: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function tempComfort(tempC: number): number {
  let s: number;
  if (tempC >= TEMP_COMFORT_MIN && tempC <= TEMP_COMFORT_MAX) s = 100;
  else if (tempC < TEMP_COMFORT_MIN) s = (100 * (tempC - TEMP_FLOOR)) / (TEMP_COMFORT_MIN - TEMP_FLOOR);
  else s = (100 * (TEMP_CEILING - tempC)) / (TEMP_CEILING - TEMP_COMFORT_MAX);
  return clamp(s, 0, 100);
}

export function rainPenalty(precipMm: number): number {
  if (precipMm <= PRECIP_FREE_MM) return 0;
  if (precipMm >= PRECIP_MAX_MM) return PRECIP_MAX_PENALTY;
  return (PRECIP_MAX_PENALTY * (precipMm - PRECIP_FREE_MM)) / (PRECIP_MAX_MM - PRECIP_FREE_MM);
}

export function airPenalty(pm25: number): number {
  if (pm25 <= AIR_FREE_UGM3) return 0;
  if (pm25 >= AIR_MAX_UGM3) return AIR_MAX_PENALTY;
  return (AIR_MAX_PENALTY * (pm25 - AIR_FREE_UGM3)) / (AIR_MAX_UGM3 - AIR_FREE_UGM3);
}

export function comfortBreakdown(tempC: number, precipMm: number, pm25?: number | null): ComfortBreakdown {
  const temp = tempComfort(tempC);
  const rain = rainPenalty(precipMm);
  const airKnown = typeof pm25 === "number" && Number.isFinite(pm25);
  const air = airKnown ? airPenalty(pm25 as number) : 0;
  return { temp, rain, air, airKnown, score: Math.round(clamp(temp - rain - air, 0, 100)) };
}

/** The Comfort Index for a month (precip in mm/month) with an optional monthly-mean PM2.5. */
export function comfortScore(tempC: number, precipMm: number, pm25?: number | null): number {
  return comfortBreakdown(tempC, precipMm, pm25).score;
}

/** Weeks in an average month; converts a mm-per-week normal to the mm-per-month scale the formula uses. */
export const WEEKS_PER_MONTH = 365.25 / 12 / 7;

/** Comfort Index breakdown for one week-of-year normal (precip in mm/week). */
export function weeklyComfortBreakdown(tempC: number, precipMmPerWeek: number, pm25?: number | null): ComfortBreakdown {
  return comfortBreakdown(tempC, precipMmPerWeek * WEEKS_PER_MONTH, pm25);
}

export type AirBand = "clean" | "moderate" | "poor" | "unhealthy" | "hazardous";

/** Plain-language band for a PM2.5 mean (ug/m3). The cut-offs follow the US EPA PM2.5 bands, applied to a monthly mean. */
export function airBand(pm25: number): AirBand {
  if (pm25 <= 10) return "clean";
  if (pm25 <= 25) return "moderate";
  if (pm25 <= 55) return "poor";
  if (pm25 <= 100) return "unhealthy";
  return "hazardous";
}

export const AIR_BAND_LABEL: Record<AirBand, string> = {
  clean: "Clean air",
  moderate: "Moderate air",
  poor: "Poor air",
  unhealthy: "Unhealthy air",
  hazardous: "Hazardous air",
};

const MONTH_END_DOY = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

/** Calendar month (1-12) a week-of-year (1-52) mostly falls in (non-leap calendar, middle day of the week). */
export function monthOfWeek(week: number): number {
  const midDay = (week - 1) * 7 + 4;
  const i = MONTH_END_DOY.findIndex((e) => midDay <= e);
  return (i < 0 ? 11 : i) + 1;
}

/** Week-of-year (1-52) a day-of-year in the non-leap calendar falls in; the last 8 days join week 52. */
export function weekOfDayOfYear(doy: number): number {
  return Math.min(52, Math.floor((doy - 1) / 7) + 1);
}
