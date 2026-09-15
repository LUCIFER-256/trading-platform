# TRADING PLATFORM — MASTER PLAN & AUDIT LEDGER

This is the single authoritative document for this project. It merges the master development plan with a running, factual audit log. It does not live only in a chat thread — it should be committed to the repository at `docs/MASTER_PLAN.md` and updated at the end of every audit round, by the auditor (AI #2), before sign-off.

**Rule for this document itself:** AI #1 (the builder) does not edit the Audit Ledger section. Only the auditor updates it, based on verified evidence — not on completion reports.

---

## PART A — THE PLAN

### 0. The final system

One trading platform, not a collection of bots. Supports multiple asset classes via adapters (Forex, Crypto, Stocks, Indices, Commodities, Futures, others). The operator selects Market → Instrument → Strategy → Timeframe → Risk configuration → Paper/Live mode at runtime. Only the active configuration is processed.

Core execution flow (fixed, non-negotiable):

```
MARKET DATA → MARKET/INSTRUMENT FILTER → STRATEGY ENGINE → SIGNAL
→ RISK ENGINE → APPROVE/REJECT → ORDER ENGINE → EXECUTION ADAPTER
→ BROKER/EXCHANGE → ORDER/FILL → PORTFOLIO ENGINE → RECONCILIATION
```

**A strategy never places an order, directly or indirectly.**

### 1. Development philosophy

Priority order, in this order, always:

1. Financial correctness
2. Security
3. Auditability
4. Determinism
5. Failure safety — when uncertain: **STOP / HOLD / RECONCILE**, never "assume it failed" or "assume it succeeded"
6. Modular architecture
7. Controlled AI development (see workflow below)

### 2. Development workflow (the loop every phase follows)

```
YOU → MASTER ARCHITECTURE/REQUIREMENTS
 → AI #1 PLAN
 → YOU APPROVE
 → AI #1 IMPLEMENT
 → AI #2 INDEPENDENT AUDIT
 → YOU ADJUDICATE
 → AI #1 FIX
 → AI #2 RE-AUDIT
 → YOU SIGN OFF
 → NEXT PHASE
```

No agent unilaterally decides: architecture, financial semantics, security policy, live-trading permissions, broker behavior, risk rules, or accounting behavior. These require explicit sign-off.

### 3–41. Phase map

| Phase | Objective | Live trading? |
|---|---|---|
| 1 | Architecture foundation | ❌ |
| 2 | PostgreSQL/database foundation (2.0 decisions → 2.1 tech → 2.2 runtime → 2.3 migrations → 2.4 catalog → 2.5 hardening) | ❌ |
| 3 | Domain model + financial core (ledger, precision, no raw `number` for money) | ❌ |
| 4 | Authentication/authorization (browser never determines authority) | ❌ |
| 5 | Market-data engine (provider → adapter → normalization → validation) | ❌ |
| 6 | Strategy engine (signal-only, no broker/DB/HTTP/credential access) | ❌ |
| 7 | Risk engine (signal → approve/reject; kill switch cannot be overridden by strategy) | ❌ |
| 8 | Order engine (Signal → Risk Decision → Order Intent; Intent ≠ broker receipt) | ❌ |
| 9 | Execution adapters (broker-specific detail stays out of the core engine) | ❌ |
| 10 | Paper trading (reuses real strategy/risk/order/portfolio pipeline) | ❌ |
| 11 | Portfolio/accounting (position derived from fills, never from strategy intent) | ❌ |
| 12 | Reconciliation (internal vs external state; discrepancy ≠ silent overwrite) | ❌ |
| 13 | Backtesting (lookahead/survivorship bias controls; train/validate/OOS/paper/live separation) | ❌ |
| 14 | Worker/orchestration (bounded concurrency, active-scope-only processing) | ❌ |
| 15 | Monitoring/alerts/audit | ❌ |
| 16 | Production frontend (control panel over an already-authoritative backend) | ❌ |
| 17 | Security/penetration/failure testing | ❌ |
| 18 | Controlled live-trading readiness | ⚠️ |
| 19 | Limited live deployment | ✅ |
| 20 | Production expansion | ✅ |

Key recurring principles carried through every phase: `UNKNOWN` external order state → reconciliation, never auto-classified as failed or successful; idempotency keys on every mutating operation; fail-closed on uncertainty everywhere (market data gone → stop new decisions; broker gone → block new execution; DB failure → fail closed; risk engine unavailable → no orders; kill switch → no new orders); frontend/strategy/risk-engine/API-request are never sufficient authority for live execution — only the execution boundary, independently, is.

### Sprint 2.3 migration governance decisions — plan only

**Status: planned; no migration runner or migration files exist yet.** These are requirements for the Sprint 2.3 implementation and approval gate.

#### Migration atomicity

PostgreSQL supports transactional DDL, and Kysely 0.29.5 defaults `disableTransactions` to `false`. However, Kysely's `migrateToLatest()` places the complete pending batch in one transaction; it does **not** give each migration its own transaction. It is therefore not the planned execution primitive for this project.

The Sprint 2.3 runner will apply pending migrations one at a time through Kysely `migrateUp()` with transactions enabled and with no `disableTransactions` option. Each migration's DDL and its Kysely migration-journal entry must commit together or roll back together. A crash or failure during one migration must leave the schema as it was before that migration began. A subsequent migration must not begin until the previous migration committed. Migrations requiring PostgreSQL operations that cannot run inside a transaction are out of scope; they require a separate, explicitly approved design rather than silently disabling transactions.

This has not yet been enabled because no migration runner exists. Sprint 2.3 tests must prove failure atomicity against real PostgreSQL using `TEST_DATABASE_URL`.

#### Live-migration governance

Running migrations against a live database is a privileged, server-side operational change. It is **not** an ordinary deploy command and must not be executable from the frontend, an HTTP route, an application import side effect, or an unapproved CI job.

Before any live database is targeted, the migration command must require a deliberate deployment-time authorization gate: an explicit live target, an environment-separated server-side approval value supplied only by the protected deployment environment, and a reviewed release artifact. The command must fail closed if any of those conditions is absent. This requirement begins with Sprint 2.3; it is not deferred to Phase 18. Phase 18 will add live-trading authorization and operational governance, but cannot weaken this earlier database-change gate.

No such command or authorization mechanism has been implemented yet.

#### Audit-trail gap

Sprint 2.3 will not have the Phase 15 audit system. Kysely's migration journal records migration name and execution timestamp, but does not establish who initiated a run, the deployment authorization, release identity, or operator intent. There will therefore be no platform audit record of who ran migrations or when beyond Kysely's journal timestamp.

This is an accepted, known Sprint 2.3 limitation, not an oversight. The live-migration gate above reduces accidental execution but is not a substitute for an audit trail. Phase 15 must provide the durable operator/deployment audit capability; until then, any external deployment-system evidence is outside the platform's own audit record.

---

## PART B — AUDIT LEDGER

Format per entry: **Phase/Sprint | Date/round | Verdict | Findings (ID, severity, status) | Evidence basis**

### PHASE 1 — Architecture Foundation
**Status: ✅ COMPLETE / FROZEN — signed off**

| Round | Verdict | Key findings | Status |
|---|---|---|---|
| 1 | ORANGE | Boundary enforcement via substring-matching test (brittle); `contracts.test.ts` mislabeled as integration test; missing timestamp/order-ID/error-taxonomy decisions | All addressed |
| 2 | — | dependency-cruiser referenced but file not yet verifiable; open-decisions.md restructured correctly; contracts.test.ts relabeled correctly | Boundary-tool verification carried into Phase 2 |
| 3 | — | runtime-mode test coverage expanded proactively (all 4 modes tested, not just 2) | Improvement noted |

**Carried-forward item at time of freeze:** dependency-cruiser config unverified (no file delivered). Resolved in Sprint 2.2, round 5 (see below).

### SPRINT 2.2 — PostgreSQL Connection, Pool & Transaction Infrastructure
**Status: 🟢 APPROVE WITH CONDITIONS — verified by real execution, 2 non-blocking items open**

| Round | Verdict | Key findings this round | Status |
|---|---|---|---|
| 1 | ORANGE | **SPRINT22-01** (HIGH): no `pool.on('error', ...)` handler — idle-client background error could crash the process, unhandled. **SPRINT22-02** (HIGH): `.dependency-cruiser.cjs` referenced by `package.json` but absent from repo — `npm test` cannot pass as configured. SPRINT22-03–06 (test-quality gaps, LOW/MEDIUM). SPRINT22-07 (INFO): rollback-itself-fails path untested. | 01 fixed next round; 02 open |
| 2 | ORANGE | SPRINT22-01 closed: pool error handler added, `"degraded"` client status introduced, `createSafePoolErrorCause` strips to whitelisted SQLSTATE only. Test-quality gaps 03/04/06 closed as a side effect. New open question: pool degradation is one-way with no documented recovery path. SPRINT22-02 still open (2nd instance). | 02 still open |
| 3 (resend) | ORANGE | No changes at all — byte-identical resend of round 2's repo state, now wrapped in the formal audit template. SPRINT22-02 still open (3rd instance). New minor finding **SPRINT22-08** (MEDIUM): `README.md` now references `.nvmrc`, which is also absent. | 02, 08 still open |
| 4 | ORANGE (upgraded confidence) | AI #1 directly answered "does `.dependency-cruiser.cjs` exist? No" and delivered both missing files. `cause` removed entirely from `DatabaseInfrastructureError`, replaced with whitelisted `sqlState` + `operation` enum — stronger than requested. Ruleset independently hand-verified against the real import graph: zero violations, correctly matches `architecture.md`. `tsPreCompilationDeps: true` catch confirmed necessary and correct (every cross-package import is `import type`). Backreference syntax (`pathNot: '^apps/$1/'`) confirmed valid against official dependency-cruiser docs. **Not yet executed for real** — sandbox had no network egress on either side. | 02 unverified-but-credible |
| 5 (real execution) | 🟢 **APPROVE WITH CONDITIONS** | User ran `npm install && npm test` for real, on Node 22.23.2 (after diagnosing that Node 18 fails via `ERR_REQUIRE_ESM` — kysely 0.29.5 is ESM-only, and Node's `require(esm)` is only stable/unflagged from 20.19+/22.12+). **All tests passed for real; `depcruise` validated 18 modules / 22 dependencies, 0 violations.** SPRINT22-02 formally **CLOSED** — first genuine execution-verified pass in the whole audit chain. | 02 CLOSED |

**Open, non-blocking conditions carried into Sprint 2.3:**
- **SPRINT22-07** (LOW/INFO): no test for the case where the transaction callback throws *and* the subsequent ROLLBACK also fails (double-failure path; depends on Kysely's internal handling, undocumented and unverified).
- **Undocumented recovery path** (MEDIUM, from round 2): once a `DatabaseClient` enters `"degraded"` status from a background pool error, there is no path back to `"ready"` short of `close()`. No documented operator procedure exists for this. Worth a direct question to AI #1 on whether this is intentional design (fail-closed conservatism) or an oversight.

### SPRINT 2.3 — Database Migrations
**Status: ⬜ NOT STARTED**

---

## PART C — CURRENT STATUS

```
PHASE 1        ████████████████████  COMPLETE / FROZEN
PHASE 2.0      ████████████████████  COMPLETE
PHASE 2.1      ████████████████████  COMPLETE
PHASE 2.2      ████████████████████  APPROVED WITH CONDITIONS (execution-verified)
PHASE 2.3      ░░░░░░░░░░░░░░░░░░░░  NOT STARTED
```

**Before Sprint 2.3 begins**, the two open Sprint 2.2 conditions above should get an explicit answer from AI #1 — not necessarily fixed, but acknowledged and either resolved or formally accepted as a known limitation.

**Standing rule for every future round:** the auditor verifies claims against actual source/tests/execution output, not completion reports. A claim of "tests pass" is not accepted until this document records the actual command output that proves it.
