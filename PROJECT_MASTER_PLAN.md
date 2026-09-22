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
**Status: 🟡 YELLOW — core functionality real-database-verified; remaining gap is artifact provenance (Git history), not correctness**

| Round | Verdict | Key findings (independently verified, not taken from narrative) | Status |
|---|---|---|---|
| 1–3 (separate auditor session, reviewed here only where independently re-checked) | RED | **SPRINT23-04** (dependency-cruiser evasion via `require("node:"+"path")` in `migration-runner.ts`) — re-verified by me directly: file now uses a plain `import * as path from "node:path"`. **CLOSED.** | Closed |
| 4 (this session) | RED | Uploaded archive (SHA-256 `326d2face403654a...`) independently confirmed to contain **zero `.git` metadata** — checked via direct search, not inferred. Running `node scripts/check-migration-immutability.cjs <real baseline SHA>` myself against this archive reproduces the exact same failure reported previously (`Could not access '<sha>...HEAD'`) — same root cause, confirmed firsthand, not copied from a transcript. `PROJECT_MASTER_PLAN.md` bundled in this archive still shows Sprint 2.3 as "NOT STARTED," confirming the ledger has never actually been committed to the repo, only shared in chat. **New finding, not previously reported:** this exact archive predates a `.dependency-cruiser.cjs` change AI #1 described keeping intentionally in the same chat session (`path` added to `database-allowed-deps`) — that change is **absent** from the file as delivered. Whatever produced this zip did so either before that edit was made or without including it. Treat this archive as a stale snapshot, not the current repo state. | Open — need a fresh, verified-current archive |

| 5 (this session) | 🟢 **RESOLVED — SPRINT23-03 CLOSED, real execution proof obtained** | User ran the real-PostgreSQL migration integration suite to completion for the first time in this project's history: `Migration integration tests passed.` — fresh-database apply, idempotent rerun, failed-migration rollback, and genuine concurrent-lock serialization against real Postgres 16.15, all directly observed via terminal output, not a report. Root cause of the multi-minute hang that blocked this for the entire prior audit chain: **two real defects in the test's own throwaway probe migrations**, not in any approved production code. (1) Both the atomicity-probe and lock-probe migrations called `.createTable('x').inSchema('platform')`, which is not a valid Kysely chain — this threw immediately, meaning the atomicity assertion was previously passing for the wrong reason (nothing was ever created to roll back). Fixed by using a schema-qualified table name directly: `.createTable('platform.x')`. (2) The lock-probe migration called `require('kysely')` from inside an OS temp directory with no `node_modules` above it in the filesystem tree — Node's module resolution did not fail fast in this case and instead hung indefinitely. Fixed by removing the SQL-level `pg_sleep` (and the `kysely` import it needed) in favor of a plain `setTimeout`-based delay, which needs no external module. Diagnosis method: five progressively narrower standalone reproduction scripts (isolating pool-concurrency, `getMigrations()`-concurrency, failed-migration recovery, and table-reuse hypotheses in turn, each disproven with direct evidence before the real cause was found) — documented here so a future session doesn't have to re-derive this from scratch. | **CLOSED** |

**Still open, not related to code correctness:**
1. **SPRINT23-01/02 (Git provenance)** — no delivered archive has ever contained real Git history. The commit chain and the immutability check's behavior against real history remain unverified from the auditor's side. Fix: whoever has hands on the actual working directory must produce the archive with a direct `tar`/`zip` of the working tree (not `git archive`, not a re-zip of an already-extracted copy), and verify with `tar tzf archive.tar.gz | grep '\.git/'` before upload that `.git` entries are actually present. **Not blocking further code work, but blocking a fully independent audit.**
2. **PostgreSQL version deviation** — verification above ran against locally-installed PostgreSQL 16.15; approved version is 18.x. Not yet assessed for impact (migration DDL/locking used here is standard SQL, unlikely to differ, but not formally confirmed against 18.x).
3. **Ledger commit** — these findings still exist only in this chat-held copy of `PROJECT_MASTER_PLAN.md`, not in the repository. Per project rule, only the auditor updates this section — but "updates" only counts once it's actually committed by whoever has write access to the repo.
4. **Working tree has one uncommitted, verified-good change**: `tests/integration/migrations.integration.test.ts` (the two probe-migration fixes above). This needs to be committed before moving on.

---

## PART C — CURRENT STATUS

```
PHASE 1        ████████████████████  COMPLETE / FROZEN
PHASE 2.0      ████████████████████  COMPLETE
PHASE 2.1      ████████████████████  COMPLETE
PHASE 2.2      ████████████████████  APPROVED WITH CONDITIONS (execution-verified)
PHASE 2.3      ████████████████░░░░  CORE FUNCTIONALITY VERIFIED — pending Git-provenance audit
```

**Sprint 2.3 remaining work before full sign-off:** obtain and independently review an archive containing real `.git` history (never yet delivered across 5 rounds), confirm the immutability check against real commit history, and formally commit `PROJECT_MASTER_PLAN.md` into the actual repository (it has so far only ever existed as a chat-shared file, not as a tracked repo document).

**Standing rule for every future round:** the auditor verifies claims against actual source/tests/execution output, not completion reports. A claim of "tests pass" is not accepted until this document records the actual command output that proves it.
