# Decision Log — meridian

> Append-only. Newest at the bottom. Each entry is immutable. This is the
> provenance spine: it lets the wiki agent detect contradictions against past
> decisions, and it records every human ruling on a tension.

---

### 2026-06-14 — wiki initialized

The comprehension wiki was scaffolded for this project. No code has been
compiled into pages yet.

### 2026-10-30 — journal & replay: tensions T1–T5 opened

Opened T1–T5 from `spec-journal.md` §12 with the planner defaults taken in this build: T1 bookings stay ungated (separate change); T2 in-app chat stays mock-capable, ingestion via scheduled task; T3 on-demand only, nightly backfill not built; T4 labeled proxy; T5 monthly. Defaults stand until ruled. Recorded ADR 0004 (token gate, R1 fail-closed and R2 bookings ungated) and ADR 0005 (deterministic replay).
