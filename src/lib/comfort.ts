// The Comfort Index formula (ADR 0002, ADR 0014). Pure and shared by the server
// (scoring, backfill) and the client (the breakdown shown wherever the index is explained).
//
//   score = temperature comfort - rain penalty - air penalty - desert penalty, clamped to 0-100.
//
// Temperature is the month's MEAN daily temperature (average of day high and night low). A
// 16-20C mean scores 100: afternoons around 21-27C. Above it the score falls away, reaching 0 at a
// 36C mean; ADR 0023 eased the hot side so humid tropical months (27-28C means, small day-night
// range) read fair rather than poor, while deserts stay low through the desert term. Below 16C it
// falls away gently: cold can be dressed for. See TEMP_CURVE. Rain subtracts 0 at <=30mm/month,
// scaling to 35 at >=250mm/month; in a month hotter than the 16-20C band the heat score has
// already counted the mugginess, so rain takes off less (down to 60% of it as the heat score
// falls to 0) rather than counting the same humidity twice. A cool monsoon keeps the full
// penalty. Air subtracts
// 0 at a monthly mean PM2.5 of <=10 ug/m3, scaling to 40 at >=75 ug/m3 (the WHO 24-hour interim target 1). A month with no
// air-quality figure has no air penalty applied (and says so), never an assumed one.
//
// Desert is a year-round term: a place that gets almost no rain all year is bare, dusty and
// sun-blasted even in its mildest month, which the month's temperature alone does not show.
// It subtracts 0 at >=400mm of rain a year, scaling to 45 at <=50mm a year (Cairo, Dubai,
// Lima's coast). It needs the whole year's rain, so callers without it pass nothing and no
// desert penalty applies.
//
// Not every dry place is a desert to live in (ADR 0025). An ocean-cooled one (the Canaries, Cape
// Verde, Lima's coast) is dry but mild all year: trade winds, no summer furnace, little gap between
// seasons. So the penalty is scaled by how hot and continental the year is, from the same monthly
// means: the warmest month's mean (none at <=24C, all at >=28C) or the gap between the warmest and
// coldest months (none at <=9C, all at >=15C), whichever is larger. Cairo, the Gulf, Phoenix and the
// Gobi keep the full penalty; Lanzarote keeps none. Without the year's temperatures it applies in full.

/** [mean C, temperature comfort] points; linear between them, flat beyond the ends. */
export const TEMP_CURVE: ReadonlyArray<readonly [number, number]> = [
  [-10, 0],
  [-2, 8],
  [4, 25],
  [9, 50],
  [13, 78],
  [16, 100],
  [20, 100],
  [22, 88],
  [24, 76],
  [26, 64],
  [28, 50],
  [30, 36],
  [32, 22],
  [34, 9],
  [36, 0],
];

export const PRECIP_FREE_MM = 30;
export const PRECIP_MAX_MM = 250;
export const PRECIP_MAX_PENALTY = 35;
/** In heat, rain counts for less: at a 0 temperature score it keeps this share; at 100 (or any cool month) all of it. */
export const HOT_RAIN_SHARE = 0.6;

export const AIR_FREE_UGM3 = 10;
export const AIR_MAX_UGM3 = 75;
export const AIR_MAX_PENALTY = 40;

export const DESERT_FREE_MM_YEAR = 400;
export const DESERT_MAX_MM_YEAR = 50;
export const DESERT_MAX_PENALTY = 45;
/** Warmest-month mean (C): no desert penalty at or below the first, all of it at or above the second. */
export const DESERT_HEAT_FREE_C = 24;
export const DESERT_HEAT_FULL_C = 28;
/** Warmest minus coldest month mean (C): same, for continental deserts with mild summers (the Gobi). */
export const DESERT_SWING_FREE_C = 9;
export const DESERT_SWING_FULL_C = 15;

/** What the desert term needs from the whole year: its rain, and where known its warmest and coldest month means. */
export interface YearClimate {
  precipMm: number;
  warmestC?: number;
  coldestC?: number;
}

export interface ComfortBreakdown {
  /** Temperature comfort, 0-100 (before penalties). */
  temp: number;
  /** Rain penalty, 0-35 points subtracted (less in a hot month, see HOT_RAIN_SHARE). */
  rain: number;
  /** Air-quality penalty, 0-40 points subtracted; 0 when `airKnown` is false. */
  air: number;
  /** False when no PM2.5 figure was available, so `air` is an absence rather than a clean result. */
  airKnown: boolean;
  /** Desert penalty, 0-45 points subtracted; 0 when the year's rain was not given. */
  desert: number;
  /** The year's rain this was judged on (mm), when given. */
  annualPrecipMm?: number;
  /** Share of the desert penalty kept (0-1) after the ocean-climate scaling; absent when the year's temperatures were unknown. */
  desertShare?: number;
  /** The warmest month's mean (C) the share was judged on, when known. */
  warmestC?: number;
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

/** Share of the rain penalty that applies: all of it at or below 20C, less as the heat score falls. */
export function rainShare(tempC: number, temp = tempComfort(tempC)): number {
  if (!(tempC > 20)) return 1;
  return HOT_RAIN_SHARE + (1 - HOT_RAIN_SHARE) * (temp / 100);
}

export function airPenalty(pm25: number): number {
  if (pm25 <= AIR_FREE_UGM3) return 0;
  if (pm25 >= AIR_MAX_UGM3) return AIR_MAX_PENALTY;
  return (AIR_MAX_PENALTY * (pm25 - AIR_FREE_UGM3)) / (AIR_MAX_UGM3 - AIR_FREE_UGM3);
}

/** The desert penalty from the year's rain alone, before the ocean-climate scaling. */
export function desertPenalty(annualPrecipMm: number): number {
  if (annualPrecipMm >= DESERT_FREE_MM_YEAR) return 0;
  if (annualPrecipMm <= DESERT_MAX_MM_YEAR) return DESERT_MAX_PENALTY;
  return (DESERT_MAX_PENALTY * (DESERT_FREE_MM_YEAR - annualPrecipMm)) / (DESERT_FREE_MM_YEAR - DESERT_MAX_MM_YEAR);
}

const ramp = (v: number, free: number, full: number) => clamp((v - free) / (full - free), 0, 1);

/** Share of the desert penalty a dry place keeps: 1 for a hot or continental year, 0 for a mild ocean one; 1 when unknown. */
export function desertShare(warmestC?: number, coldestC?: number): number {
  if (typeof warmestC !== "number" || !Number.isFinite(warmestC)) return 1;
  const heat = ramp(warmestC, DESERT_HEAT_FREE_C, DESERT_HEAT_FULL_C);
  const swing = typeof coldestC === "number" && Number.isFinite(coldestC) ? ramp(warmestC - coldestC, DESERT_SWING_FREE_C, DESERT_SWING_FULL_C) : 1;
  return Math.max(heat, swing);
}

/** The year the desert term reads, from 12 months or 52 weeks; undefined unless every rain value is known. */
export function climateYear(rows: ReadonlyArray<{ tempC?: number | null; precipMm?: number | null }>): YearClimate | undefined {
  const precipMm = annualRain(rows.map((r) => r.precipMm));
  if (precipMm === undefined) return undefined;
  const temps = rows.map((r) => r.tempC).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  if (temps.length !== rows.length) return { precipMm };
  return { precipMm, warmestC: Math.max(...temps), coldestC: Math.min(...temps) };
}

function asYear(year?: number | YearClimate | null): YearClimate | undefined {
  if (typeof year === "number") return Number.isFinite(year) ? { precipMm: year } : undefined;
  return year && Number.isFinite(year.precipMm) ? year : undefined;
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

export function comfortBreakdown(tempC: number, precipMm: number, pm25?: number | null, yearIn?: number | YearClimate | null): ComfortBreakdown {
  const temp = tempComfort(tempC);
  const rain = rainPenalty(precipMm) * rainShare(tempC, temp);
  const airKnown = typeof pm25 === "number" && Number.isFinite(pm25);
  const air = airKnown ? airPenalty(pm25 as number) : 0;
  const year = asYear(yearIn);
  const share = year && year.warmestC !== undefined ? desertShare(year.warmestC, year.coldestC) : undefined;
  const desert = year ? desertPenalty(year.precipMm) * (share ?? 1) : 0;
  return {
    temp,
    rain,
    air,
    airKnown,
    desert,
    ...(year ? { annualPrecipMm: year.precipMm } : {}),
    ...(share !== undefined ? { desertShare: share, warmestC: year!.warmestC } : {}),
    score: Math.round(clamp(temp - rain - air - desert, 0, 100)),
  };
}

/** The Comfort Index for a month (precip in mm/month) with an optional monthly-mean PM2.5. */
export function comfortScore(tempC: number, precipMm: number, pm25?: number | null, year?: number | YearClimate | null): number {
  return comfortBreakdown(tempC, precipMm, pm25, year).score;
}

/** Weeks in an average month; converts a mm-per-week normal to the mm-per-month scale the formula uses. */
export const WEEKS_PER_MONTH = 365.25 / 12 / 7;

/** Comfort Index breakdown for one week-of-year normal (precip in mm/week). */
export function weeklyComfortBreakdown(tempC: number, precipMmPerWeek: number, pm25?: number | null, year?: number | YearClimate | null): ComfortBreakdown {
  return comfortBreakdown(tempC, precipMmPerWeek * WEEKS_PER_MONTH, pm25, year);
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

function desertNote(b: ComfortBreakdown): string {
  const rain = `${Math.round(b.annualPrecipMm as number)} mm of rain a year`;
  if (b.desertShare === undefined || b.desertShare >= 1 || b.warmestC === undefined) return rain;
  return `${rain}; a mild ocean climate (warmest month ${Math.round(b.warmestC)}°C) keeps ${Math.round(b.desertShare * 100)}% of the penalty`;
}

/** The three terms of the Comfort Index as display rows, for every place the index is explained. */
export function breakdownRows(b: ComfortBreakdown, tempC: number, precipMm: number, pm25?: number | null, rainUnit = "mm a month"): BreakdownRow[] {
  const take = (v: number) => (Math.round(v) === 0 ? "0" : `−${Math.round(v)}`);
  // Desert shows only where it takes something off: elsewhere it is noise.
  const desert: BreakdownRow[] =
    b.annualPrecipMm !== undefined && Math.round(b.desert) > 0
      ? [{ key: "desert", label: "Desert", points: -Math.round(b.desert), text: take(b.desert), note: desertNote(b) }]
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
