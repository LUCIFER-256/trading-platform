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

### Phase 2.4 — Market/Instrument Catalog planning decisions

Phase 2.4 establishes platform-owned catalog identities and provider-symbol mappings. It does not establish any financial instrument rules: tick size, lot/contract size, quantity/notional bounds, margin, leverage, sessions, or price/quantity precision are entirely deferred, with no nullable placeholder columns.

**Identity and uniqueness**

- A market has a platform-owned `market_code`: a normalized lowercase ASCII slug, unique across markets (for example, `forex`). This is the market's natural key; its generated primary key remains the relational key.
- A provider has a platform-owned `provider_code`: a normalized lowercase ASCII slug, unique across providers (for example, `oanda`). It identifies the catalogued provider only; it is not a credential, connection, adapter, or provider-selection commitment.
- An instrument has a platform-owned `instrument_code`, not a provider symbol. It is a normalized lowercase ASCII slug in the format `^[a-z0-9]+(?:-[a-z0-9]+)*$`; examples include `eur-usd`, `btc-usdt`, and `aapl`. Its canonical identity is the pair `(market_id, instrument_code)`, enforced as unique. The generated instrument primary key is the stable identifier referenced by the rest of the platform.
- The provider mapping stores the provider's external symbol exactly as supplied. It is compared case-sensitively and is unique within a provider. No provider-symbol normalization, case folding, aliasing, or historical remapping is implied or performed in Phase 2.4; those require an approved provider-specific policy later.
- The mapping table also has a unique `(provider_id, instrument_id)` constraint. The Phase 2.4 model therefore permits one current symbol for one provider/instrument pair. A future requirement for aliases or history must add explicit effective-dating/versioning rather than weakening this constraint silently.

**Retirement, deletion, and selection**

- Catalog records are retired by an enabled/disabled lifecycle state, not by normal hard deletion. Foreign keys from instruments to markets and from mappings to both instruments and providers use `ON DELETE RESTRICT` (equivalently, immediate no-action behavior): a referenced market, instrument, or provider cannot be deleted. This intentionally preserves catalog referential integrity and auditability.
- Disabling a market does not mutate the enabled state of its instruments or mappings. It does, however, make every descendant instrument functionally ineligible for runtime selection through every path. A valid selection requires an enabled market, enabled instrument, and enabled provider mapping. Re-enabling a market restores eligibility only for descendants that remain individually enabled.
- This eligibility rule controls new selection/new activity only. The behavior of existing orders or positions when an item is disabled remains deferred until those records and workflows exist.

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
**Status: 🟢 GREEN — fully independently verified: real commit history, real PostgreSQL execution, real architecture/immutability checks. SIGNED OFF.**

| Round | Verdict | Key findings (independently verified, not taken from narrative) | Status |
|---|---|---|---|
| 1–3 (separate auditor session, reviewed here only where independently re-checked) | RED | **SPRINT23-04** (dependency-cruiser evasion via `require("node:"+"path")` in `migration-runner.ts`) — re-verified by me directly: file now uses a plain `import * as path from "node:path"`. **CLOSED.** | Closed |
| 4 (this session) | RED | Uploaded archive (SHA-256 `326d2face403654a...`) independently confirmed to contain **zero `.git` metadata** — checked via direct search, not inferred. Running `node scripts/check-migration-immutability.cjs <real baseline SHA>` myself against this archive reproduces the exact same failure reported previously (`Could not access '<sha>...HEAD'`) — same root cause, confirmed firsthand, not copied from a transcript. `PROJECT_MASTER_PLAN.md` bundled in this archive still shows Sprint 2.3 as "NOT STARTED," confirming the ledger has never actually been committed to the repo, only shared in chat. **New finding, not previously reported:** this exact archive predates a `.dependency-cruiser.cjs` change AI #1 described keeping intentionally in the same chat session (`path` added to `database-allowed-deps`) — that change is **absent** from the file as delivered. Whatever produced this zip did so either before that edit was made or without including it. Treat this archive as a stale snapshot, not the current repo state. | Open — need a fresh, verified-current archive |

| 5 (this session) | 🟢 **RESOLVED — SPRINT23-03 CLOSED, real execution proof obtained** | User ran the real-PostgreSQL migration integration suite to completion for the first time in this project's history: `Migration integration tests passed.` — fresh-database apply, idempotent rerun, failed-migration rollback, and genuine concurrent-lock serialization against real Postgres 16.15, all directly observed via terminal output, not a report. Root cause of the multi-minute hang that blocked this for the entire prior audit chain: **two real defects in the test's own throwaway probe migrations**, not in any approved production code. (1) Both the atomicity-probe and lock-probe migrations called `.createTable('x').inSchema('platform')`, which is not a valid Kysely chain — this threw immediately, meaning the atomicity assertion was previously passing for the wrong reason (nothing was ever created to roll back). Fixed by using a schema-qualified table name directly: `.createTable('platform.x')`. (2) The lock-probe migration called `require('kysely')` from inside an OS temp directory with no `node_modules` above it in the filesystem tree — Node's module resolution did not fail fast in this case and instead hung indefinitely. Fixed by removing the SQL-level `pg_sleep` (and the `kysely` import it needed) in favor of a plain `setTimeout`-based delay, which needs no external module. Diagnosis method: five progressively narrower standalone reproduction scripts (isolating pool-concurrency, `getMigrations()`-concurrency, failed-migration recovery, and table-reuse hypotheses in turn, each disproven with direct evidence before the real cause was found) — documented here so a future session doesn't have to re-derive this from scratch. | **CLOSED** |

| 6 (this session) | 🟢 **SPRINT23-01/02 CLOSED — independent Git-provenance audit completed** | First archive in the entire Sprint 2.3 audit chain (6 attempts) to actually contain real `.git` history, after two prior same-session attempts failed for unrelated reasons (a stale re-upload, then a malformed `tar` invocation despite passing the uploader's own pre-check — root cause of that second failure not conclusively identified, but the working repository itself was confirmed intact throughout via direct `git log` inspection before the archive was rebuilt). Independently verified, from scratch, by the auditor: `git log --oneline` shows the exact real commit chain `cedb671 → 22eb681 → dfc92bf → 660d4a5 → 47f7cde`, clean working tree, 129 real git objects. `node scripts/check-migration-immutability.cjs` run directly by the auditor against the real baseline SHA exits 0 — and critically, `git diff --name-status` against that same baseline was also run independently and shows exactly one file, marked `A` (added): `packages/database/src/migrations/20260915090000_create_platform_schema.ts`. This confirms the check passes for the correct reason (one legitimately added migration, nothing modified/deleted/renamed), not vacuously. `PROJECT_MASTER_PLAN.md` checksum in the archive (`68f3b31f...`) matches exactly what the auditor produced. Both probe-migration fixes from Round 5 confirmed present in the actual committed file. | **CLOSED** |

**Also closed this session, previously an unclosed loose end:** the `.dependency-cruiser.cjs` change AI #1 described keeping intentionally (adding `path` to `database`'s allowed dependencies) was independently reviewed against the real file. It turned out to be a more substantial, well-designed rewrite than described: `database-may-depend-only-on-approved-contracts-and-drivers` now enforces an explicit allowlist (core/shared/self, kysely/pg, bare fs/path) instead of the old rule's narrower internal-only check, paired with a new reciprocal rule (`postgres-drivers-must-remain-inside-database`) preventing any package outside `database` from importing `pg`/`kysely` directly. This is a genuine security-boundary improvement, already proven against the real codebase via the user's own clean `npm test` run (0 violations, 23 modules/35 dependencies). No action needed — confirmed correct, not reverted.

**Remaining open items, none blocking:**
1. **PostgreSQL version deviation** — real-database verification (Round 5) ran against locally-installed PostgreSQL 16.15; approved version is 18.x. Migration DDL/locking used is standard SQL, unlikely to differ, but not formally confirmed against 18.x. Low priority — revisit before production deployment, not before Sprint 2.4.
2. **Sprint 2.2 carried-forward conditions** (rollback-double-failure edge case documented but see Sprint 2.2 section; degraded-state one-way recovery, documented as intentional) — both already answered, no further action needed unless requirements change.

---

## PART C — CURRENT STATUS

```
PHASE 1        ████████████████████  COMPLETE / FROZEN
PHASE 2.0      ████████████████████  COMPLETE
PHASE 2.1      ████████████████████  COMPLETE
PHASE 2.2      ████████████████████  APPROVED WITH CONDITIONS (execution-verified)
PHASE 2.3      ████████████████████  COMPLETE — SIGNED OFF
PHASE 2.4      ░░░░░░░░░░░░░░░░░░░░  NOT STARTED (Market/Instrument Catalog)
```

**Sprint 2.3 is done.** Next up per the phase map: Phase 2.4 — Market/Instrument Catalog (Market → Instrument → Provider symbol mapping; do not prematurely assume instrument-specific rules like tick size, lot size, or margin — those get designed deliberately when this phase starts, not guessed at now).

**Standing rule for every future round:** the auditor verifies claims against actual source/tests/execution output, not completion reports. A claim of "tests pass" is not accepted until this document records the actual command output that proves it.
