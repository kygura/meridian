// Event sources that are computed from Meridian's own data at read time, with no network
// and nothing stored: the events follow the measured data as it changes (ADR 0021).

import { getCities } from "../cities.js";
import { measuredBusyness, visitorMonthsFor } from "../placeData.js";
import { peekCitySeasonality } from "../seasonality.js";
import type { SourceStatus, StoredEvent } from "./common.js";
import { tourismSeasonEvents } from "./tourismSeasons.js";

export interface ComputedSource {
  id: string;
  compute(): { events: StoredEvent[]; detail: Record<string, number | string> };
}

export const tourismSeasonSource: ComputedSource = {
  id: "tourism-seasons",
  compute() {
    const r = tourismSeasonEvents({
      cities: getCities(),
      busyness: (id, m) => measuredBusyness(id, m),
      comfort(id) {
        const p = peekCitySeasonality(id);
        return p.kind === "hit" && p.months.length === 12 ? p.months.map((x) => x.score) : undefined;
      },
      granularity: (id) => visitorMonthsFor(id)?.granularity,
    });
    return { events: r.events, detail: { measuredCities: r.measuredCities, withShoulderSeason: r.withShoulder } };
  },
};

export const COMPUTED: ComputedSource[] = [tourismSeasonSource];

export function computedStatus(src: ComputedSource, events: StoredEvent[], detail: Record<string, number | string>, at: string): SourceStatus {
  return { id: src.id, ok: true, count: events.length, detail, fetchedAt: at };
}
