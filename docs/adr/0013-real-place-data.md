# Cost, internet, health, stability and crowds are measured, and a missing value is a gap

Before this, the map's cost, internet and crowds surfaces were tagged `source: "synthesized"`, and the score's economics, stability and nomadInfra parts were hashes of the city name (`hashStr` / `pseudoScore` in `server/lib/scoring.ts`). They looked like data and were not. All of that is removed. `scripts/build-place-data.ts` now builds `data/country-data.json` and `data/city-data.json` from open sources, every value carrying its source, year and granularity. Scores are worked out from those files at read time (`server/lib/placeData.ts`, scales in `server/lib/placeDataMath.ts`). A city a source does not cover has `null` for that part, never a stand-in, and the UI shows the gap.

## Sources

| Fact | Source (licence) | Granularity |
|---|---|---|
| Cost index | Eurostat correction coefficients, `prc_colc_tot` (EU) and `prc_colc_ext` (outside), Brussels = 100 (CC BY 4.0) | city, 181 of 189 stations matched to a city |
| Cost index, elsewhere | World Bank price level of household consumption: PPP factor over exchange rate (CC BY 4.0), re-based so Belgium = 100 | country |
| Monthly cost, one person | index / 100 times Belgian household consumption per person (Eurostat `nama_10_pc`) divided by 12 | an **estimate**, labelled as one; granularity follows the index |
| Rent, 1-bedroom | Eurostat `prc_colc_rents`, flat with one bedroom, EUR | city, 41 cities |
| Rent, elsewhere | not shown as a figure. The ICP housing price level is kept for reference; checked against Eurostat rents it has a median error of 31%, which is too loose to show | none |
| Internet | Ookla Open Data speed-test tiles (CC BY-NC-SA 4.0), quarter 2025 Q3, tiles within a population-scaled radius of the centre, test-weighted; at least 30 tests | city |
| Healthcare | UHC service coverage index (WHO, via World Bank), physicians and hospital beds per 1,000 | country |
| Stability | Worldwide Governance Indicators, political stability estimate (World Bank); homicide rate from ADR 0008 stays in Quality | country |
| Visitors | UN Tourism international arrivals (via Our World in Data) over World Bank population | country |
| Crowd seasonality | Eurostat nights in tourist accommodation by month (`tour_occ_nin2m`), 2022-25, NUTS 2 region of the city, else the country | region or country (Europe only) |
| Crowd seasonality, city signal | English Wikipedia page views by month, 2017-19 and 2022-25, as a sign of interest (stored, not scored) | city, the 1,000 most populous cities with an article |

Rejected: Numbeo and similar crowd-sourced cost indexes (terms forbid scraping, and licence), Global Peace Index (not openly licensed), a made-up city adjustment on country price levels (no real basis; city granularity exists only where Eurostat measured it).

## Scales

All are documented in `placeDataMath.ts` and the user-facing score reads them: affordability is `100 - logscale(monthly cost, 600, 4500 EUR)`; internet is `logscale(download, 5, 300 Mbps)`; stability is the WGI estimate mapped linearly from -2.5..2.5; health is the UHC index; crowds is `logscale(arrivals per resident, 0.01, 5)`. A monthly seasonal index takes per-day rates relative to each year's mean, the median across years, rescaled to 100. These cut-offs are judgements, stated here so they can be argued with.

The overall score is the weighted mean of the parts that exist (economics 25, quality 20, stability 20, health 15, nomadInfra 10, climate 10), and is `null` with fewer than three parts. Metric ids (`economics`, `stability`, `nomadInfra` and so on) did not change.

## Crowds

`server/lib/crowd.ts` keeps its month-relative peak index, but it comes from measured nights (or Wikipedia views) where there are any, with `basis: "nights"`. Only where neither exists does it fall back to the comfort curve, labelled `basis: "comfort"`, which is a guess.

## Coverage (5,878 cities)

| Value | Cities |
|---|---|
| Cost index, city (Eurostat) | 181 |
| Cost index, country (World Bank) | 5,077 |
| Rent, city | 41 (751 more can read their capital's rent for reference only) |
| Internet, fixed | 5,139 |
| Internet, mobile | 4,659 |
| UHC index | 5,662 |
| Physicians / hospital beds | 5,727 / 5,682 |
| Political stability | 5,723 |
| Arrivals per resident | 4,917 |
| Monthly nights, region / country | 642 / 643 |
| Monthly Wikipedia views | 920 |
| Overall score (3+ parts) | 5,735 |

About 800 cities have no cost figure because their country has no World Bank price level. Everything outside Europe has no monthly nights.

## Checks that did not look good

The Wikipedia page-view pattern correlates with measured nights at a median of only 0.21 across 64 cities (25% above 0.5, 30% below 0). Page views are therefore kept in `city-data.json` as a labelled sign of interest but feed no score and no crowd peak; only measured nights do. The full-run builder takes hours because Wikimedia rate-limits; `PAGEVIEW_MAX` (default unlimited, the committed data used 1,000) caps it, and downloads are cached in `data/cache/realdata` (ignored by git).

## Other invented numbers found, and left alone

Not part of this change, listed so they are not mistaken for data: `estimateForOption` in `server/routes/agent.ts` (trip price and dates from a seeded hash, shown in trip options), `mockFlightEstimate` in `server/lib/agent/tools.ts` (source `"mock"`, used when no flight provider is configured), the mock offers in `server/lib/booking.ts` (labelled test mode), and the flat per-night lodging and ground-transport formulas on trips (labelled estimates, ADR 0010).
