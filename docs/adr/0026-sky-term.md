# The Comfort Index sees a dull sky

Extends ADR 0014 (the air term was added the same way) and amends ADR 0025's known side effect. Leaves the temperature curve (ADR 0018, 0023), the rain and air terms and the desert term as they are.

**Why.** ADR 0025 scaled the desert term down for mild ocean climates, which is right for the Canary Islands. It also lifted Lima's coast: the month's temperature is 16 to 18 °C, rain is about 1 mm, and the warmest month's mean is 23.5 °C, so the desert share is 0 and July scores 100. But Lima's winter is the garúa: a grey sea fog with about 1 to 2 hours of sun a day for months. Nothing in the stored normals (temperature, rain, PM2.5) can see that. The index needs a term for how much sun a month actually gets.

**Data.** Open-Meteo's archive API, `daily=sunshine_duration` (seconds of sunshine per day), as its own one-variable call per climate cell, like the air call and not part of the 3-variable weather call. Window 2022-01-01 to 2024-12-31 (`SKY_START`, `SKY_END`, `SKY_WINDOW` "2022-2024"): 3 years, enough for a normal of a quantity that varies little year to year, and cheap. Seconds are converted to hours, then aggregated like the other variables: the mean of each year's monthly mean for the 12 months, and the smoothed week-of-year mean for the 52 weeks.

**Storage.** The cell gains `m.s` and `w.s` (hours a day ×10, integers, the same quantisation as `a`) and `sq`, the date the sunshine was fetched (like `aq`). The file stays version 1 and backward compatible: a cell without `s` decodes exactly as it did, and `skyWindow` on the file is optional (the parser does not need it). `decodeMonths` and `decodeWeeks` pass the cell's `sunH` to the formula and out to every reader; `MonthSeasonality`, `WeekSeasonality`, `SeasonMonth`, `SeasonWeek` and the region aggregates carry an optional `sunH`.

**Cost.** One call weighs `weightOf(1, 1096)` = 7.9, the same as the air call. A cell costs about 94 weighted calls instead of 86 (weather 78.3, air 7.9, sky 7.9), 9% more. Closing the sky gap on all cells already on file is about 7.9 × 5,463 = 43,000 weighted calls, six days of the free tier at our 7,000-a-day ceiling. A cell with weather and air but no `s` is planned as `needsSky`, in its own tier after the air-only and stale cells, so new cells and air still come first. Sky is fetched after weather and air in `runBackfill`, writes nothing when its call fails or is limited, and a cell that has had its sunshine fetched (`sq`) is not asked for again. The nightly job uses the same code and the dry-run arithmetic in `scripts/backfill-climate.ts` includes `SKY_WEIGHT`.

**Formula.** Sky takes off 0 at 6 hours of sun a day or more, scaling linearly to 25 points at 2 hours or less (`SKY_FREE_H` 6, `SKY_MAX_H` 2, `SKY_MAX_PENALTY` 25): 4 h/day costs 12.5. Weekly values are already per day, so no conversion. Like air, a month or week with no sunshine figure takes nothing off and shows no Sky row; it is never assumed. When known, the breakdown shows a "Sky" row after Air, e.g. "1.5 h of sun a day". 6 h and 2 h are the edges of what reads as a bright and a grey month: 6 h of a day's 12 is half the sky clear, 2 h is under a sixth. The cap of 25 is smaller than rain (35) and air (40): a grey month is a lesser harm than a flooded or smoky one.

**Effect.**

| Place | Month | Sun | Before | After |
|---|---|---|---|---|
| Lima (monthly means 23 to 16.5 °C, rain ~1 mm) | July | 1.5 h/day | 100 | 75 |
| Canary-like (Arrecife, Fuerteventura; sunshine expected, not yet measured here) | any | 6 h/day or more | unchanged | unchanged |
| Any place without a sunshine figure yet | any | unknown | unchanged | unchanged |

The stored scores change only as the backfill reaches each cell; until then the Comfort Index is exactly what it was. Lima's dull months now land at 75 or below, its bright months are unaffected, and a sunny climate such as the Canaries' (6 hours or more a day) pays nothing. The Canaries' real figures arrive with the backfill; the 8 hours used in the tests is an assumption to check against them.

**Not done.** The on-demand live fetch for a city outside the backfill (`fetchCityLive`) does not fetch sunshine: it would add a call per request against the quota, and the nightly job fills the cell in time. Observed-weather and replay scores have no sunshine figure and score as before.

Rejected:

- **Adding `sunshine_duration` to the weather call.** A fourth variable over ten years weighs about 104 instead of 78, 33% more for every cell, to fetch seven more years of a quantity we only need three of. The separate call costs 7.9.
- **`cloud_cover` instead.** It is cheaper to reason about but less direct: a clear sky at dusk and a thin high haze both read as partial cover, while sunshine duration is the number of hours of direct sun, which is what a visit is for.
- **A list of exempt (or penalised) places.** That would be a judgement in the data, not a measurement, and would miss the next fog coast (Arica, Swakopmund, San Francisco in July) and the next sunny island.
- **Restoring the desert penalty for coastal deserts.** It would re-penalise the sunny Canaries to catch grey Lima, the opposite of what ADR 0025 set out to do.
