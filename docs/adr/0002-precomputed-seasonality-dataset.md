# Seasonality is a precomputed, committed dataset — not runtime climate fetching

Monthly Comfort Index scores are computed offline by a Bun script from Open-Meteo
historical monthly data averaged over a multi-year window, and committed as compact JSON
(scores + small tooltip fields only, not raw climate series) alongside airports.json.
Climate normals are static, so runtime fetching for ~4,661 cities would add a fragile
rate-limited dependency for zero benefit. We store the *score*, not the raw data, to
keep the file well under 1 MB. Hemisphere handling needs no special logic because real
monthly data already encodes it. Rejected: Open-Meteo Climate (CMIP6 projection) API —
projections are not normals; single-year data — noise, not a normal.
