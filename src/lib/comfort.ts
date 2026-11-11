// The Comfort Index formula (ADR 0002, ADR 0014). Pure and shared by the server
// (scoring, backfill) and the client (the breakdown shown wherever the index is explained).
//
//   score = temperature comfort - rain penalty - air penalty - desert penalty, clamped to 0-100.
//
// Temperature is the month's MEAN daily temperature (average of day high and night low). A
// 16-20C mean scores 100: afternoons around 21-27C. Above it the score falls away fast, since
// afternoons run 6-8C over the mean (more in deserts): a 26C mean is a ~33C afternoon, a 30C
// mean ~37C. Below it falls away more gently: cold can be dressed for. See TEMP_CURVE. Rain subtracts 0 at <=30mm/month, scaling to 35 at >=250mm/month. Air subtracts
// 0 at a monthly mean PM2.5 of <=10 ug/m3, scaling to 40 at >=75 ug/m3 (the WHO 24-hour interim target 1). A month with no
// air-quality figure has no air penalty applied (and says so), never an assumed one.
//
// Desert is a year-round term: a place that gets almost no rain all year is bare, dusty and
// sun-blasted even in its mildest month, which the month's temperature alone does not show.
// It subtracts 0 at >=400mm of rain a year, scaling to 45 at <=50mm a year (Cairo, Dubai,
// Lima's coast). It needs the whole year's rain, so callers without it pass nothing and no
// desert penalty applies.

/** [mean C, temperature comfort] points; linear between them, flat beyond the ends. */
export const TEMP_CURVE: ReadonlyArray<readonly [number, number]> = [
  [-10, 0],
  [-2, 8],
  [4, 25],
  [9, 50],
  [13, 78],
  [16, 100],
  [20, 100],
  [22, 85],
  [24, 65],
  [26, 45],
  [28, 28],
  [30, 15],
  [32, 6],
  [34, 0],
];

export const PRECIP_FREE_MM = 30;
export const PRECIP_MAX_MM = 250;
export const PRECIP_MAX_PENALTY = 35;

export const AIR_FREE_UGM3 = 10;
export const AIR_MAX_UGM3 = 75;
export const AIR_MAX_PENALTY = 40;

export const DESERT_FREE_MM_YEAR = 400;
export const DESERT_MAX_MM_YEAR = 50;
export const DESERT_MAX_PENALTY = 45;

export interface ComfortBreakdown {
  /** Temperature comfort, 0-100 (before penalties). */
  temp: number;
  /** Rain penalty, 0-35 points subtracted. */
  rain: number;
  /** Air-quality penalty, 0-40 points subtracted; 0 when `airKnown` is false. */
  air: number;
  /** False when no PM2.5 figure was available, so `air` is an absence rather than a clean result. */
  airKnown: boolean;
  /** Desert penalty, 0-45 points subtracted; 0 when the year's rain was not given. */
  desert: number;
  /** The year's rain this was judged on (mm), when given. */
  annualPrecipMm?: number;
  /** Final Comfort Index, 0-100, integer. */
  score: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function tempComfort(tempC: number): number {
  const first = TEMP_CURVE[0]!;
  const last = TEMP_CURVE[TEMP_CURVE.length - 1]!;
  if (!(tempC > first[0])) return first[1];
  if (tempC >= last[0]) return last[1];
  for (let i = 1; i < TEMP_CURVE.length; i++) {
    const [x1, y1] = TEMP_CURVE[i]!;
    if (tempC <= x1) {
      const [x0, y0] = TEMP_CURVE[i - 1]!;
      return clamp(y0 + ((y1 - y0) * (tempC - x0)) / (x1 - x0), 0, 100);
    }
  }
  return last[1];
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

export function desertPenalty(annualPrecipMm: number): number {
  if (annualPrecipMm >= DESERT_FREE_MM_YEAR) return 0;
  if (annualPrecipMm <= DESERT_MAX_MM_YEAR) return DESERT_MAX_PENALTY;
  return (DESERT_MAX_PENALTY * (DESERT_FREE_MM_YEAR - annualPrecipMm)) / (DESERT_FREE_MM_YEAR - DESERT_MAX_MM_YEAR);
}

/** A year's rain (mm) from 12 monthly totals, or 52 weekly ones; undefined unless every value is a number. */
export function annualRain(precips: ReadonlyArray<number | null | undefined>): number | undefined {
  if (precips.length !== 12 && precips.length !== 52) return undefined;
  let sum = 0;
  for (const p of precips) {
    if (typeof p !== "number" || !Number.isFinite(p)) return undefined;
    sum += p;
  }
  return precips.length === 52 ? sum * (365.25 / 364) : sum;
}

export function comfortBreakdown(tempC: number, precipMm: number, pm25?: number | null, annualPrecipMm?: number | null): ComfortBreakdown {
  const temp = tempComfort(tempC);
  const rain = rainPenalty(precipMm);
  const airKnown = typeof pm25 === "number" && Number.isFinite(pm25);
  const air = airKnown ? airPenalty(pm25 as number) : 0;
  const yearKnown = typeof annualPrecipMm === "number" && Number.isFinite(annualPrecipMm);
  const desert = yearKnown ? desertPenalty(annualPrecipMm as number) : 0;
  return {
    temp,
    rain,
    air,
    airKnown,
    desert,
    ...(yearKnown ? { annualPrecipMm: annualPrecipMm as number } : {}),
    score: Math.round(clamp(temp - rain - air - desert, 0, 100)),
  };
}

/** The Comfort Index for a month (precip in mm/month) with an optional monthly-mean PM2.5. */
export function comfortScore(tempC: number, precipMm: number, pm25?: number | null, annualPrecipMm?: number | null): number {
  return comfortBreakdown(tempC, precipMm, pm25, annualPrecipMm).score;
}

/** Weeks in an average month; converts a mm-per-week normal to the mm-per-month scale the formula uses. */
export const WEEKS_PER_MONTH = 365.25 / 12 / 7;

/** Comfort Index breakdown for one week-of-year normal (precip in mm/week). */
export function weeklyComfortBreakdown(tempC: number, precipMmPerWeek: number, pm25?: number | null, annualPrecipMm?: number | null): ComfortBreakdown {
  return comfortBreakdown(tempC, precipMmPerWeek * WEEKS_PER_MONTH, pm25, annualPrecipMm);
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

export interface BreakdownRow {
  key: "temp" | "rain" | "air" | "desert";
  label: string;
  /** Points added (temperature) or taken off (rain, air), rounded. */
  points: number;
  /** "+71", "−17", "0", or "n/a" when air quality is unknown. */
  text: string;
  /** What the points come from: "22°C", "140 mm a month", "PM2.5 42 µg/m³ (Poor air)". */
  note: string;
}

/** The three terms of the Comfort Index as display rows, for every place the index is explained. */
export function breakdownRows(b: ComfortBreakdown, tempC: number, precipMm: number, pm25?: number | null, rainUnit = "mm a month"): BreakdownRow[] {
  const take = (v: number) => (Math.round(v) === 0 ? "0" : `−${Math.round(v)}`);
  // Desert shows only where it takes something off: elsewhere it is noise.
  const desert: BreakdownRow[] =
    b.annualPrecipMm !== undefined && Math.round(b.desert) > 0
      ? [{ key: "desert", label: "Desert", points: -Math.round(b.desert), text: take(b.desert), note: `${Math.round(b.annualPrecipMm)} mm of rain a year` }]
      : [];
  return [
    { key: "temp", label: "Temperature", points: Math.round(b.temp), text: `+${Math.round(b.temp)}`, note: `${Math.round(tempC)}°C` },
    { key: "rain", label: "Rain", points: -Math.round(b.rain), text: take(b.rain), note: `${Math.round(precipMm)} ${rainUnit}` },
    b.airKnown
      ? { key: "air", label: "Air", points: -Math.round(b.air), text: take(b.air), note: `PM2.5 ${Math.round(pm25 as number)} µg/m³ (${AIR_BAND_LABEL[airBand(pm25 as number)]})` }
      : { key: "air", label: "Air", points: 0, text: "n/a", note: "No air-quality data for this place yet, so nothing is taken off" },
    ...desert,
  ];
}
