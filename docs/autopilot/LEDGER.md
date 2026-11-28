# Autopilot ledger

Statuses: `todo` · `doing` · `held` (waits for a decision) · `blocked` (failed review / no safe path) · `done`.
Runs take the first runnable `todo` from the top. Procedure: [RUNNER.md](RUNNER.md).

## Phase 0 — Safety net and discovery

| ID | Task | Needs | Decisions | Risk | Status | Commit / evidence |
|---|---|---|---|---|---|---|
| P0-01 | Read-only discovery → `docs/system-map.md` (apps, packages, mobile, DB, migrations, jobs, routes, roles, feature flags, couriers, CI, environments; where each business rule lives + duplicates). Reuse `docs/AUDIT_2026-10.md`, `docs/LEGACY_INVENTORY.md`. | — | — | normal | todo | |
| P0-02 | Baseline at a pinned commit → `docs/baseline.md`: install, typecheck, test, build, CI scripts results; slowest critical pages/APIs on local staging. | P0-01 | — | normal | todo | |
| P0-03 | Ranked issue register → `docs/issues.md` (critical/high/medium/low, file, impact, fix). | P0-01 | — | normal | todo | |
| P0-04 | Fill AGENTS.md §5 owners and §10 missing commands from the map. | P0-01 | — | normal | todo | |
| P0-05 | Local staging script: compose + migrate + `seed:demo` + smoke test, one command → `scripts/staging-local.sh`, documented. | P0-02 | — | normal | todo | |
| P0-06 | Restore rehearsal: restore a backup into an isolated local DB, counts + relationships + smoke test; measure vs RTO 2 h / RPO 15 min → `docs/recovery.md` + rollback runbook. | P0-05 | D2 | high | todo | |
| P0-07 | Essential alerts (error spike, failed jobs, stalled courier sync, DB down): thresholds, window, owner, destination, runbook; tested on staging → `docs/alerts.md`. Production config only with owner yes. | P0-05 | D3 | normal | todo | |
| P0-08 | CI: lint (if present) + first order journey test (create + confirm, persisted state) required in `build.yml`. | P0-02 | — | high | todo | |
| P0-09 | Capture critical screens and behavior on local staging → `docs/baseline-screens/`. | P0-05 | — | normal | todo | |
| P0-10 | Forecast: turn the findings into concrete Phase 1–4 rows in this ledger; propose indicator definitions + thresholds as decision. | P0-03, P0-08 | — | normal | todo | |

## Phase 1 — Tenant isolation and feature access

| ID | Task | Needs | Decisions | Risk | Status | Commit / evidence |
|---|---|---|---|---|---|---|
| P1-* | Expanded by P0-10 from ROADMAP Phase 1. Privacy rows need D4. | P0-10 | D4 (privacy rows) | high | todo | |

## Phase 2 — Orders, stock and money

| ID | Task | Needs | Decisions | Risk | Status | Commit / evidence |
|---|---|---|---|---|---|---|
| P2-* | Expanded by P0-10 from ROADMAP Phase 2. Each historical-data correction = its own decision. | P1 done | per correction | high | todo | |

## Phase 3 — Make the safeguards permanent

| ID | Task | Needs | Decisions | Risk | Status | Commit / evidence |
|---|---|---|---|---|---|---|
| P3-* | Expanded by P0-10 from ROADMAP Phase 3. | P2 done | D5 (protect main) | high | todo | |

## Phase 4 — Performance

| ID | Task | Needs | Decisions | Risk | Status | Commit / evidence |
|---|---|---|---|---|---|---|
| P4-* | Expanded by P0-10 from ROADMAP Phase 4. | P3 done | — | normal | todo | |

## Phase 5 — Growth

Only rows with a measured need, added by earlier tasks. Each new technology = a decision.
