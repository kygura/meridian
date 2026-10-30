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
- [frontier] A — server journal core: auth, atomic store, journal CRUD, settings, FX (opus)
- [frontier] E — fingerprint + crowd + replay engine, pure/DI (opus)
- [frontier] D — DESIGN-journal.md (opus designer)
- [frontier] G — ADR 0004/0005, CONTEXT.md, tensions, gmail task prompt (haiku)
### Wave 2
- [blocked A] I — import queue: store, dedupe, city resolution, clustering, accept/merge/discard, booking promotion, routes (sonnet)
- [blocked A,E] R — replay + fingerprint routes, fingerprint recompute on save (opus, continue E)
- [blocked A,D] U1 — journal client: api, router, nav, timeline, detail, quick log, unlock (sonnet)
### Wave 3
- [blocked I] P — .eml/.mbox JSON-LD parser, Timeline JSON parser, upload routes, fixtures (sonnet)
- [blocked R,I] W — watches/alerts/webhook, events.json, agent journal tools + mock path (sonnet)
- [blocked R,U1] U2 — Replay page (opus? sonnet)
- [blocked U1] U3 — Globe journeys layer + scrubber + log from globe (sonnet)
### Wave 4
- [blocked P,W,U1] U4 — inbox UI + uploads + photo EXIF + alerts list/ticker + TopBar badge (sonnet)
### Gate
- V — typecheck/test/build, review-risk/reliability, finalizer, ponytail, spec review, drift
