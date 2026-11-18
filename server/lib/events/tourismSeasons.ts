// Tourism seasons (ADR 0021), derived from Meridian's own data and not fetched.
// A city with measured month-by-month visitor nights (server/lib/placeData.ts) gets one
// recurring "Peak season" over the months at 80 or more of 100, and one "Shoulder season"
// over the months next to the peak that are comfortable (Comfort Index 60 or more,
// seasonality.ts). A city with only the comfort-curve crowd proxy gets nothing here: a proxy
// is not a measurement of how many visitors come.

import type { City } from "../../../src/types.js";
import { orderMonths } from "../../../src/lib/eventKinds.js";
import type { StoredEvent } from "./common.js";

export const PEAK_BUSYNESS = 80;
export const SHOULDER_COMFORT = 60;

export interface SeasonInputs {
  cities: City[];
  /** 0-100 busyness of a month (1-12) from measured nights, undefined without measured data. */
  busyness(cityId: string, month: number): number | undefined;
  /** The 12 monthly Comfort Index scores, January first, when the city's climate is known. */
  comfort(cityId: string): number[] | undefined;
  /** "region" or "country": how local the measured nights are. */
  granularity(cityId: string): string | undefined;
}

export interface SeasonResult {
  events: StoredEvent[];
  /** Cities with measured monthly busyness, which is all that get events. */
  measuredCities: number;
  withShoulder: number;
}

const prev = (m: number) => (m === 1 ? 12 : m - 1);
const next = (m: number) => (m === 12 ? 1 : m + 1);

export function tourismSeasonEvents(inp: SeasonInputs): SeasonResult {
  const events: StoredEvent[] = [];
  let measured = 0;
  let withShoulder = 0;
  for (const c of inp.cities) {
    const busy: number[] = [];
    for (let m = 1; m <= 12; m++) {
      const b = inp.busyness(c.id, m);
      if (b === undefined) break;
      busy.push(b);
    }
    if (busy.length !== 12) continue;
    measured++;
    const peak = new Set<number>();
    busy.forEach((b, i) => b >= PEAK_BUSYNESS && peak.add(i + 1));
    if (peak.size === 0 || peak.size === 12) continue;
    const peakMonths = orderMonths(peak);
    const level = inp.granularity(c.id) ?? "region";
    events.push({
      id: `season-peak-${c.id}`,
      title: "Peak season",
      kind: "season",
      cityIds: [c.id],
      month: peakMonths[0]!,
      months: peakMonths,
      recurring: true,
      tags: ["peak-season"],
      note: `Busiest months by nights in tourist accommodation (${level} level).`,
      source: "meridian",
      feed: "tourism-seasons",
    });
    const comfort = inp.comfort(c.id);
    if (!comfort || comfort.length !== 12) continue;
    const shoulder = new Set<number>();
    for (let m = 1; m <= 12; m++) {
      if (peak.has(m)) continue;
      if ((peak.has(prev(m)) || peak.has(next(m))) && comfort[m - 1]! >= SHOULDER_COMFORT) shoulder.add(m);
    }
    if (shoulder.size === 0) continue;
    withShoulder++;
    const months = orderMonths(shoulder);
    events.push({
      id: `season-shoulder-${c.id}`,
      title: "Shoulder season",
      kind: "season",
      cityIds: [c.id],
      month: months[0]!,
      months,
      recurring: true,
      tags: ["shoulder-season"],
      note: `Comfortable months (Comfort Index ${SHOULDER_COMFORT} or more) next to the peak, so fewer visitors than the peak.`,
      source: "meridian",
      feed: "tourism-seasons",
    });
  }
  return { events, measuredCities: measured, withShoulder };
}
