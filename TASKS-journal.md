# TASKS — Journal & Replay build

**Destination:** Meridian keeps a token-gated journal of past journeys, fingerprints them
from real data, ranks similar destination×month windows with sliders, ingests imports via
a review queue, and alerts on watched windows — typecheck/test/build green.

Spec: `spec-journal.md` (planner rulings §14). Type contract: `src/types.ts` "Journal & Replay".
Baseline commit: `f82c64c`.

Harness: Claude Code (cloud). Planner: claude-opus-5-5 @ medium. Roster: opus, sonnet,
haiku (native Agent), fable (no evidence → unverified, not used). Single provider →
reviewer = different family from implementer. No bridges.

| Role | Model @ effort |
|---|---|
| planner | opus-5-5 (this session) |
| discussion | sonnet @ high |
| designer | opus |
| heavy | opus |
| worker | sonnet |
| ui-impl | sonnet |
| grunt | haiku |
| reviewer | opposite family of implementer |
| drift-check | haiku |

## Decisions so far
- Types contract written by planner in src/types.ts; LayerKey gains "journeys".
- Rulings R1–R6 in spec-journal.md §14 (fail-closed token, bookings ungated, 1-based months, lazy booking promotion, FX fallback, observed-weather cache).

## Tasks
### Wave 1
- [done] A — server journal core: auth, atomic store, journal CRUD, settings, FX (opus)
- [done] E — fingerprint + crowd + replay engine, pure/DI (opus)
- [done] D — DESIGN-journal.md (opus designer)
- [done] G — ADR 0004/0005, CONTEXT.md, tensions, gmail task prompt (haiku)
### Wave 2
- [done] I — import queue: store, dedupe, city resolution, clustering, accept/merge/discard, booking promotion, routes (sonnet)
- [done] R — replay + fingerprint routes, fingerprint recompute on save (opus, continue E)
- [done] U1 — journal client: api, router, nav, timeline, detail, quick log, unlock (sonnet)
### Wave 3
- [done] P — .eml/.mbox JSON-LD parser, Timeline JSON parser, upload routes, fixtures (sonnet)
- [done] W — watches/alerts/webhook, events.json, agent journal tools + mock path (sonnet)
- [done] U2 — Replay page (opus? sonnet)
- [done] U3 — Globe journeys layer + scrubber + log from globe (sonnet)
### Wave 4
- [done] U4 — inbox UI + uploads + photo EXIF + alerts list/ticker + TopBar badge (sonnet)
### Gate
- [done] V — typecheck/test/build, review-risk/reliability, finalizer, ponytail, spec review, drift
- G done (haiku): docs; import task uses id "<source>:<sourceRef>", Money on wire = {amount,currency} — import schema must accept partial Money.
- A done (opus, 1st try): 185 tests; Frankfurter host is api.frankfurter.dev/v1.
- D done (opus): DESIGN-journal.md; 7 gaps ruled in spec §14 R7 (dense grid, normalTempC, cityIds, alerts under /api/watches/alerts, cluster merge, PATCH city resolve, upload routes).
- E+R done (opus): engine + routes, 347 tests; R8 normals fallback + async fingerprint. Open-Meteo 429 at smoke time.
- I done (sonnet impl, opus review 9+ findings, sonnet fix): 363 tests; exact-name + airport-radius city resolution, merge lock.
- U1 done (sonnet impl, haiku drift 13 + opus logic findings, sonnet fix): 366 tests, build green, Playwright smoke ok. dist/ is tracked — agents restore it after builds.
- P,W done: 499 tests. U2,U3 done: 499 tests + build. U4 done: 529 tests, exifr 7.1.3, CORS PATCH added by planner.
- Gate running: 5 areas x 2 lenses + spec/done-criteria checker, adversarial verify per finding, per-area fixes, recheck.
- V done: 101 candidate findings, 64 confirmed (adversarial verify), fixed by per-area agents; 573 tests; P1-P4 done-criteria PASS live. Planner reverted a paid Render cron block (opened T6 instead).
