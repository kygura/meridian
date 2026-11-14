# Likeness tells the source of an experience from its lighter echoes

Builds on ADR 0008 (setting and character), ADR 0013 (place data) and the coast distance from ADR 0015.

The question this answers: "I want this kind of place. Where is it at its fullest, and which places are a smaller version of it?" Someone who loved Haarlem should learn that Venice is the canal city the others echo; someone choosing between Alpine valleys should see Tirol and Bolzano ahead of the Slovak Tatras, and see the Tatras too, since a lighter version can be the right choice on purpose (cheaper, fewer visitors).

## Profiles

Each city with a livability record gets a profile of seven **experience axes**, all 0-100 and all measured: mountains (relief within 15 km), water (sea or lake depth, ADR 0008), sea (100 on the coast, 0 at 40 km or more from it), heritage, photographed and notable (the character parts) and scale (population on a log scale, 20 thousand to 20 million). A missing value stays missing; a profile that covers less than 60% of what a query weighs is skipped. **Kind axes** say which sort of place it is without ranking it: the annual mean and the coldest month's mean temperature where the city has climate normals, and the absolute latitude everywhere.

Every axis is standardised against all cities (z-scores), so "stands out" means stands out against the average city in the dataset.

## Likeness and strength

A query is a **target**: vibes, places (seeds), or both. A vibe sets levels on a few axes, calibrated to the data ("peak" is the 95th percentile, "mid" the mean, "low" 1.25 standard deviations under it) and may set kind ranges (the tropics, a warm or a freezing coldest month). A seed contributes its whole profile and, unless a vibe sets one, a kind range around its latitude and climate.

- **Likeness** is the weighted cosine between the place and the target, over the target's axes, on standardised values: the same traits stand out, whatever their size. It is multiplied by the kind fit (1 inside the ranges, falling to 0 over a tolerance); with seeds a kind mismatch costs at most half.
- **Strength** is the projection of the place onto the target over its **highlights** (axes at least half a standard deviation from the mean), divided by the target's own: 1 is as strong as the target, more is stronger. Size counts as a highlight only when a vibe asks for it, so Seoul is not "more Kyoto" than Kyoto for being bigger.

Places with likeness of at least 0.85 (and strength of at least 0.35) are **alike**. Among them, those within 90% of the strongest are **sources**; the rest are **echoes**, each linked to the source it most resembles (cosine over all seven axes) with the highlights it falls shortest on, and what it offers instead where place data shows it (cheaper: affordability 10 points higher; fewer visitors: tourism 10 points lower). Seeds always appear, so a seed can turn out to be an echo of something stronger. Sources are listed strongest first, then best known (photographed plus notable) among near-ties, since capped axes make many sources tie; echoes by likeness times strength.

Regions (NUTS 2, Europe only) and countries are roll-ups of the city ranking: a group holding a source is a source, and an echo group points to the group of its lead city's source. For regions the pool is the cities that have a region, so the sources are European ones. `within` limits the pool to one country, and the sources are then the strongest in that country.

The engine is pure and shared (`src/lib/likeness.ts`); profiles are built once per process (`server/lib/likeness.ts`); `GET /api/likeness` serves it, keyless and deterministic. Plan › Sources is the screen; the city panel says whether a city is a source or whose echo it is.

## Known limits, accepted for v1

The axes are what Meridian measures, so likeness is as good as they are. Canals and lagoons are invisible (ADR 0008 misses shallow water), which is why Venice's echoes are found through heritage and the sea rather than canals. Character favours famous and large places (photos, articles), so for old towns a middling size is part of the vibe to keep megacities out. Climate is measured for a few hundred cities; elsewhere a vibe's climate falls back to latitude, which knows nothing of altitude or currents. Tourism and cost are national figures, so "cheaper" and "fewer visitors" only show across borders.

Rejected: embeddings of descriptions (opaque, and they would rank fame), hand-tagging places with vibes (does not scale to 5,800 cities and bakes in taste), and ranking sources by fame alone (the strongest mountain towns are in the Karakoram, not the best-known resorts; fame only breaks ties).
