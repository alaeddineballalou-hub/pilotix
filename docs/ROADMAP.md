# Pilotix — Engineering Roadmap

Goal: protect merchants, make stock and COD money exactly right, and keep improving Pilotix through small, safe releases.

- Rules for doing the work: [AGENTS.md](../AGENTS.md)
- How a change goes live: [CLAUDE.md](../CLAUDE.md)

Status: **not started.** All baselines are *Unmeasured* until Phase 0 is complete. No delivery date is set before discovery.

---

## Owner decisions

| Decision | Value | Status |
|---|---|---|
| Max restore time (RTO) | **2 hours** | ✅ Set |
| Max data loss (RPO) | **15 minutes** | ✅ Set |
| Time split: plan / merchant requests & fixes | **70 / 30**, reviewed after Phase 0 | ✅ Set |
| High-risk reviewer | Different AI model from the builder, or the owner | ✅ Set |
| Cost / time cap per autonomous run | _owner to set_ | ☐ Open |
| Thresholds for the 8 weekly indicators | _set after Phase 0 baselines_ | ☐ Open |
| Legal advice on Algerian privacy (Law 18-07) | Owner consults a qualified local advisor before Phase 1 privacy work | ☐ Open |
| Protect `main` (PR + required review) instead of direct push | Decide during Phase 3; until then CLAUDE.md applies | ☐ Open |

---

## Phase 0 — Safety net and discovery

**Why first:** every later change is risky without a way back and a map of what exists.

1. **Read-only discovery.** Produce `docs/system-map.md`: apps (`server`, `web`, `extension`, `wa-extension`), packages (`core`, `shared`), `mobile/` (Capacitor/Android), database, migrations, jobs, API routes, identity and roles, feature flags, courier integrations, CI and environments, runtime versions. List where each business rule lives and every place it's duplicated. Reuse `docs/AUDIT_2026-10.md` and `docs/LEGACY_INVENTORY.md` where still accurate.
2. **Baseline.** Record the commit, setup commands, build/type errors, existing tests and failures, and the slowest critical pages/APIs.
3. **Issue register** `docs/issues.md`: ranked critical / high / medium / low, each with file, impact and proposed fix.
4. **Staging.** Isolated, staging-only credentials, synthetic or approved sanitized data. Confirm no secrets in code, logs or fixtures.
5. **Restore rehearsal.** Restore a backup into an isolated database, compare record counts and key relationships, start the app, run a smoke test.
   - Must restore service in **< 2 hours (RTO)** with **≤ 15 minutes data loss (RPO)**.
   - Measure elapsed restore time, and the gap between the simulated incident time and the newest recoverable committed data.
   - If either target is missed: assign remediation; the recovery gate **stays failed** until a repeat rehearsal passes.
   - Write a rollback runbook and list migrations that need forward recovery.
6. **Essential alerts** (before changing anything): error-rate spike, failed jobs, stalled courier sync, database unavailable.
   - Each alert has a numeric threshold or explicit failure condition, time window, owner, delivery destination and response runbook.
   - Test delivery in staging and record the result. Owner approves production alert config. Production coverage confirmed before phased releases begin.
7. **Minimum CI**: reproducible install, lint, typecheck, build, existing tests, plus one order journey (create + confirm, check saved state). Track existing CI failures with severity, owner and recovery action — keep them visible.
8. **Capture current critical screens and behavior** before any deeper refactor.
9. **Fill in** the canonical owners table and missing commands in `AGENTS.md`.

Exit — all MUST exist:
- [ ] Commit-pinned system map and baseline checks
- [ ] Ranked issue register
- [ ] Staging smoke test
- [ ] Restore record meeting RTO/RPO
- [ ] Alert delivery evidence
- [ ] CI blocking a change that breaks the order journey
- [ ] Forecast for Phases 1–4 based on what was found

---

## Phase 1 — Tenant isolation and feature access

**Why:** a cross-tenant data leak is the one bug that can destroy merchant trust overnight.

1. **Access matrix** `docs/access-matrix.md`: tenant × role × feature × action × surface, from the verified inventory. Every discovered role and scope (owner/admin, Boutique, Agence, Utilisateurs and operational roles). Surfaces: menu and action visibility, direct routes, APIs, exports, files, jobs, reports, notifications, mobile. Unverified surfaces listed explicitly.
2. **Server enforcement**: permissions and feature state checked on the server. Unknown or revoked access = deny. Cached grants invalidated when a role, permission or feature assignment changes.
3. **Tests**: authorized access, denied access, revocation, agency boundaries, and tenant A denied on every inventoried route for tenant B's resources.
4. **Feature registry**: stable IDs, owner, lifecycle state, dependent views, permissions, APIs, jobs and integrations.
   **Scan test:** disable Scan for one tenant → direct access denied, stale grants revoked, in-flight work that uses Scan handled, other tenants unaffected, authorized history still readable; re-enable restores access. Same checklist for activation, change, deprecation, retirement.
5. **Security quick wins**: session expiry, secrets, webhook authenticity, upload validation, public checkout rate limits.
6. **Privacy**: inventory access to customer phone numbers and addresses, audit sensitive exports, define retention / export / deletion with the owner — after local legal advice.

Exit:
- [ ] Role and surface matrix
- [ ] Automated cross-tenant denial + permitted-access tests in CI
- [ ] Scan lifecycle evidence
- [ ] Remediation register; zero unresolved critical security findings; no material gap in critical access coverage

---

## Phase 2 — Orders, stock and money

**Why:** wrong stock and wrong money are what merchants feel every day.

1. **Capture current behavior first.** Trace real order states, courier mappings, retries, historical rules and merchant-approved workflows. Preserve verified states even if they differ from the ideal flow.
2. **Order transition table** (server-side): actor, scope, preconditions, timestamps, audit event, side effects, idempotency. Covers Nouvelles, En cours, Confirmées, En préparation, En dispatch, Dispatchées, En livraison, Livrées, Retours, Échanges, cancellations and suspected fake orders.
3. **Stock**: verify when stock is reserved, released and eligible for resale. Atomic changes, duplicate protection, safe concurrency, reconciliation from stock movements to totals.
4. **Money**: fees, commissions, salaries, courier charges and COD settlement in one deterministic domain module. Integer minor units or fixed-precision decimals, explicit currency and rounding, preserved historical rules. Reconcile orders → cash collected → payouts by tenant and period.
5. **Couriers** (ZR Express, Yalidine, others found): provider adapters, explicit status and wilaya/commune mappings, authenticated updates, idempotency, bounded retries. Track delayed, duplicate and failed messages; reconcile uncertain outcomes. A retried state change never duplicates a stock or money effect.
6. **Historical mismatches**: see AGENTS.md §6 — report per tenant, owner approves each correction, dated traceable adjustment entries, originals preserved, no double application.

Exit:
- [ ] Full synthetic order: Boutique → Confirmation → Dépôt → Livraison → Finance → Statistiques
- [ ] Same with cancellation, return, exchange, concurrent updates and replay
- [ ] Stock and ledger balances reconcile **exactly** after documented rounding
- [ ] Persisted state, event counts, balances and role checks attached

---

## Phase 3 — Make the safeguards permanent

**Why:** locks in Phases 1–2 so the fixes don't decay as features keep shipping.

1. **Critical suite (5–10 journeys) in CI**: create → confirm → stock reserved; dispatch → courier update; delivery → COD settlement; cancellation; return or exchange; denied access; Scan disabled.
2. **Change-type checks**: unit/integration for changed rules; contract checks for changed APIs and payloads; **Android smoke test for any change touching an API Android uses**; migration + recovery checks for migrations; visual checks for changed screens; pre-existing data and older clients tested when contracts change.
3. **Candidate protection**: CI passes on the exact commit; dependency and secret scanning; registry and policy validation; migration validation. Quarantined checks have an owner, expiry and equivalent evidence for critical paths.
4. **Decide on protected `main`** (owner decision): PR + required review vs the current direct-push flow in CLAUDE.md.
5. **Hotfix lane**: urgent defects jump the queue, but still get a regression test, the same reviewer as their change type, and owner-controlled release. A risky change needs a tested flag rollback or tested candidate rollback first.

Exit:
- [ ] Required checks block a deliberately broken critical journey
- [ ] Rollback rehearsed in staging; documented when app rollback suffices vs forward fix

---

## Phase 4 — Performance where merchants feel it

**Why:** speed matters, but only after correctness. Fix measured bottlenecks, not guesses.

1. Profile Confirmation, Dépôt lists, Statistiques and ordinary internal APIs with realistic data volumes, concurrent roles, cache state and Algerian network conditions. Pin commits, dependencies, datasets and workload; repeat runs; keep raw results.
2. Test Android critical flows on low-end hardware and constrained connections.
3. Inspect query plans and N+1 patterns; benchmark each fix against the measured bottleneck.
4. Re-verify access control and financial correctness after every optimization. An independent reviewer repeats consequential benchmarks.

| Metric | Target |
|---|---|
| Ordinary API p95 | < 200 ms for a defined endpoint mix and workload |
| Public web LCP | < 2.5 s under the agreed mobile profile (field p75 when available; lab results labelled) |
| N+1 / duplicate requests in critical paths | 0, counts recorded before and after |
| Android | Device, network, startup, navigation, offline recovery recorded |

Exit:
- [ ] Baseline vs candidate with sample size, variability, absolute deltas, regressions and missed targets
- [ ] Remaining actions have an owner

---

## Phase 5 — Growth and technology decisions (only with a measured need)

**Why last:** these are investments, not fixes.

- **Keep the verified stack by default** (dashboard, backend, Capacitor/Android). Change it only with a measured problem, a tested benefit and a rollback path.
- **Next.js** only for selected public storefronts/landing pages with a measured SEO or performance need; reuse the backend; reversible route change; independent verification.
- **Languages & infra**: strict TypeScript for new packages and shared contracts, SQL for data access, shared CSS for design primitives. Redis, queues, Rust, Go or new services only for proven bottlenecks after simpler options fail. Record accepted / deferred / rejected with measurements.
- **Pilotix Doctor**: deterministic counters for errors, courier sync delay, queue backlog, failed jobs — with scope, timestamp, threshold and source. Internal view only when it has a clear operational use. No sensitive merchant data.

---

## Release standard

### 6 hard gates — each Pass / Fail / Unverified

| # | Gate | Proven by |
|---|---|---|
| 1 | Tenant and role isolation verified across inventoried critical surfaces | Access-matrix + cross-tenant tests in CI |
| 2 | Stock and finance reconcile in representative scenarios | Reconciliation report + journey tests |
| 3 | Restore meets RTO/RPO, basic alerts verified, rollback rehearsed | Restore record, alert delivery, rollback rehearsal |
| 4 | Required CI checks pass on the exact candidate commit | CI run link |
| 5 | No unresolved critical security, data-integrity or product defect | Issue register |
| 6 | Critical journeys pass with design and workflow parity | Critical suite + screenshots |

**Fail or Unverified blocks readiness.** All six must pass before the plan recommends release. Production release still needs the owner's yes (CLAUDE.md).

### 8 weekly indicators

| Business | Technical |
|---|---|
| Confirmation rate | API p95 latency |
| Delivery rate | Error rate |
| Return rate | Courier sync delay |
| Order → confirmation time | Failed jobs per day |

Each has a written numerator, denominator, population and time window before the first comparison. Record baseline, latest and trend. Escalation thresholds are set after Phase 0.

---

## Team

| Role | Who | Does |
|---|---|---|
| Owner | You | Priorities, business rules, production actions |
| Builder | Main agent session | Implements one scoped branch, records decisions, produces tests and evidence |
| Tester | Separate agent session | Acceptance checks, regressions, invalid states, cross-module behavior |
| Guardian | Agent + owner | Tenant scope, permissions, security, privacy |
| Money & data | Agent + owner | Stock, settlements, schema changes, recovery, reconciliation |
| Auditor | **Different AI model from the builder, or the owner** | Reviews and reruns checks on every change touching money, permissions or migrations; verifies final release evidence |

- Assign owner and reviewer before work begins. The builder can never audit its own change.
- No auditor available for a high-risk change → hold it, continue independent work.
- Each work item carries scope, affected contracts, baseline, checks, artifacts, rollback and stop criteria. Each run has a time or cost cap and resumes from a durable checkpoint.

## Weekly checkpoint — `docs/weekly/YYYY-MM-DD.md`

- Shipped (commits)
- Gate status (6)
- Indicators (8): baseline / latest / trend
- Next work
- Blocked + decision needed from owner

## Starter skills (add more only after a task repeats 3 times)

| # | Skill | Purpose |
|---|---|---|
| 01 | `pilotix-discovery` | System map, baseline, ranked findings |
| 02 | `pilotix-change` | Map affected surfaces, scope the fix, verify evidence, prepare rollback |
| 03 | `pilotix-permissions` | Tenant, role, feature and server enforcement |
| 04 | `pilotix-orders-stock` | Transitions, inventory effects, replays, reconciliation |
| 05 | `pilotix-finance` | Precision, formulas, balances, history |
| 06 | `pilotix-couriers` | Mappings, retries, reconciliation |
| 07 | `pilotix-testing` | Fixtures and targeted suite coverage |
| 08 | `pilotix-release` | Gates, staging, rollback, owner sign-off |

## First work package

In order: read-only discovery → pinned baseline and ranked issue register → isolated restore rehearsal → essential alerts → minimum CI and the first order regression. Then forecast the next phases from what was found.
