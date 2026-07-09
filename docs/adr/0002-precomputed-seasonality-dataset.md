---
status: amended 2026-07-09 — see below
---

# Seasonality is a precomputed, committed dataset — not runtime climate fetching

Monthly Comfort Index scores are computed offline by a Bun script from Open-Meteo
historical monthly data averaged over a multi-year window, and committed as compact JSON
(scores + small tooltip fields only, not raw climate series) alongside airports.json.
Climate normals are static, so runtime fetching for ~4,661 cities would add a fragile
rate-limited dependency for zero benefit. We store the *score*, not the raw data, to
keep the file well under 1 MB. Hemisphere handling needs no special logic because real
monthly data already encodes it. Rejected: Open-Meteo Climate (CMIP6 projection) API —
projections are not normals; single-year data — noise, not a normal.

**Amendment (user directive, mid-build):** the bulk backfill hit Open-Meteo's hourly
quota at 60 cities, and the user directed on-demand fetching instead. The committed
dataset is now a *seed cache*: when a city we actually surface (selected, shortlisted,
in a trip, agent-found) misses the cache, the server fetches its multi-year daily
history live, aggregates and scores it with the same formula, persists it to the cache,
and serves it. Bulk precompute remains available (`bun run build:seasonality`) but is an
optimization, not a coverage requirement. Quota exhaustion degrades gracefully
(temporarily-unavailable response, retry later) — scores are never fabricated.
