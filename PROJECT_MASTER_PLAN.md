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

### Phase 4 — Authentication & Authorization planning decisions (awaiting approval)

**Phase boundary.** Phase 4 establishes credentials, database-backed opaque sessions, account-scoped authorization, auth audit records, and the database-enforced replacement for the Phase 3 asserted ledger actor. It deliberately does **not** open an HTTP listener. A narrow Phase 4.1 transport-boundary review must precede any HTTP endpoint and covers TLS termination, cookie transport, CSRF, origin policy, request limits, HTTP rate limiting, and transport error mapping. The Phase 4 `apps/api` application service has no listener; Phase 4.1 adapts that service without reimplementing its authority checks.

**Credentials, resets, and first privileged identity.** Passwords use Argon2id (not bcrypt): each stored PHC hash has a generated salt and at least `m=19456 KiB`, `t=2`, `p=1`; plaintext passwords, reset secrets, and reversible password encryption are never stored or logged. A forward migration adds a current password-credential row with credential version, immutable password-credential history, and one-time reset-token rows containing only a digest, issuer, expiry, and consumed/revoked state. Changing or resetting a password atomically increments the credential version, replaces the hash, revokes every active session, and emits an immutable audit event. Existing Phase 3 users have no credential and fail closed until explicitly provisioned.

Password-reset issuance is a server-side CLI command, `npm run auth:issue-password-reset -- --target-user-code <code> --token-output <new-path>`, with no HTTP listener. It requires a controlling TTY and prompts for the issuing `SUPER_ADMIN`'s user code and password without echo; the CLI authenticates that principal, creates a short-lived internal session solely to invoke the protected reset function, and revokes that command session before exit. It refuses a disabled/missing target, expired/disabled issuer, non-empty output target, insecure output-directory ownership/mode, or an issuer without current `SUPER_ADMIN` authority. It writes a 256-bit, single-use reset secret only to the newly-created `0600` output file and prints only the target code and audit-event ID. The operator conveys that secret via an approved out-of-band channel; it never appears in command arguments, environment variables, logs, audit metadata, or stdout. The protected database function derives the issuer from the authenticated command session, stores only the reset-secret digest with a 15-minute expiry, invalidates prior active reset tokens for that user, and appends `password_reset_issued` with issuer, subject, time, and correlation ID. Redemption and all failed redemption attempts are likewise audited.

The first `SUPER_ADMIN` is created only by `npm run auth:bootstrap-super-admin -- --user-code <new-code>`. It requires a controlling TTY, entry and confirmation of a new password without echo, `PLATFORM_AUTH_BOOTSTRAP=enabled`, and a separate provisioning database credential that is unavailable to the runtime API process. The new migration creates a one-row `auth_bootstrap_state` record and a protected bootstrap function executable only by that provisioning role. In a single transaction the function takes an advisory lock plus a row lock, requires `completed_at is null` and zero active global `SUPER_ADMIN` grants, creates/enables the named user and credential, grants the global role, marks bootstrap complete, and appends a `super_admin_bootstrapped` audit event with the subject but no fictitious human actor. It rejects every later invocation permanently, including if the environment gate is mistakenly left enabled. Normal later super-admin grants use the audited authorization path and cannot invoke the bootstrap function.

**Sessions and authorization.** Authentication uses server-side opaque sessions rather than JWTs. A session selector plus a 256-bit CSPRNG secret is issued; only the secret digest, user, credential-version snapshot, issue/idle/absolute expiry, and revocation data are stored. Sessions expire after 30 minutes idle or eight hours absolute; logout, explicit revocation, password change/reset, and user disablement invalidate them immediately. Authorization is RBAC with mandatory account scope: `USER`, `ADMIN`, `TRADING_OPERATOR`, `RISK_OPERATOR`, and `AUDITOR` are granted per account; `SUPER_ADMIN` is global. Account is the multi-tenant boundary. `accounts.user_id` remains owner, but each access still requires an active account grant (or global super-admin), never a client-supplied account/user/role assertion. Only `SUPER_ADMIN` has Phase 4's `ledger.post.deposit`, `ledger.post.withdrawal`, and `ledger.post.manual_adjustment` permissions; account administrators do not.

`account_role_assignments` follows the established soft-disable convention. Each grant is an append-only assignment row with `enabled`, `revoked_at`, `revoked_by_user_id`, and revocation reason; revocation disables the row and deletion is rejected by a database trigger. Re-granting creates a new active assignment while the prior disabled record remains. A partial unique constraint permits at most one active grant for a `(user, account, role)` tuple. Role changes are immutable audit events and immediately affect permission evaluation.

**Closing the Phase 3 financial actor gap.** A forward migration adds immutable `actor_user_id` and `actor_session_id` foreign keys to new ledger transactions; historical Phase 3 rows retain their asserted legacy text. It replaces the posting function so it accepts a session selector and secret but **no** `actor_reference`, user ID, or role. PostgreSQL verifies the secret digest, session expiry/revocation, credential version, user enablement, wallet-derived account, and the event permission itself; it then derives and persists the actor fields and a canonical display reference. The runtime database role receives only required views and protected-function execution, not direct ledger-write privileges; object ownership/migration privileges remain separate. Thus a caller cannot turn a supplied actor string, role, or account ID into authority.

**Failed-login and audit policy.** Authentication returns a generic failure for unknown, disabled, locked, and wrong-password attempts, and performs an equivalent Argon2id verification path for unknown users. Per login identifier: attempt 3 delays 30 seconds, attempt 4 delays two minutes, attempt 5 locks for 15 minutes, and subsequent failures within 24 hours lock for one hour. A privacy-preserving source-network fingerprint is limited to 20 failures per 15 minutes and then blocked for one hour. State transitions are database-recorded atomically, so concurrent attempts cannot evade the limit. Login, logout, failure, lockout, credential changes, reset issuance/redemption, session lifecycle, user disablement, and role changes are append-only audited; raw passwords, session/reset secrets, source addresses, and user-agent strings are excluded from event metadata. Financial ledger records remain permanent. Authentication/authorization audit records have a minimum seven-year retention period; legal hold prevents deletion, and a later retention worker may purge only records past that period under an approved operational policy.

**Argon2id test policy.** Production Argon2id parameters are constants in the production hasher factory; no runtime environment variable, test mode, or request can lower them. Unit and high-volume integration tests inject a separately constructed, lower-cost Argon2id test hasher so they still exercise the actual Argon2id algorithm and all credential/session/lockout paths without multiplying the full suite's wall-clock time. A mandatory production-parameter smoke test in every test run calls the production factory itself, asserts its encoded parameters, and hashes plus verifies both correct and incorrect passwords. Separate tests prove production wiring cannot accept the test policy. This permits fast behavioral tests without allowing a test configuration to become a production configuration.

**Architecture enforcement.** `.dependency-cruiser.cjs` gains an `api-may-depend-only-on-phase4-boundaries` allowlist: `apps/api` may import only itself, `packages/shared`, `packages/core`, `packages/database`, the Argon2 implementation, and specifically enumerated Node built-ins required by the CLI/auth service (such as `node:crypto`, `node:fs`, `node:path`, and `node:readline`). It gains an explicit `api-must-not-depend-on-domain-engines` rule forbidding `market-data`, `strategies`, `risk`, `trading`, `portfolio`, and `execution`, and a Phase 4 `worker-must-not-depend-on-auth-or-database` rule preventing `apps/worker` from acquiring access to `apps/api` or `packages/database` before its own approved phase. The existing `postgres-drivers-must-remain-inside-database`, `web-must-not-depend-on-database`, and app-to-app rules remain unchanged; `apps/web` gains no API/auth/database access, and no other application gains permissions as a side effect of the API allowlist.

**Required real-PostgreSQL verification.** PostgreSQL 18.6 integration tests must prove actual schema constraints and behavior: Argon2id verification, valid/expired/revoked sessions, credential-version invalidation, database-level rejection of forged session secrets and wrong-account/wrong-role access, immediate role-revocation enforcement, direct ledger-write rejection, database-derived ledger actors, concurrent lockout correctness, reset single-use/expiry behavior, and immutable audit/grant records. The verification chain is typecheck, unit tests, architecture check, one disposable PostgreSQL 18.6 integration run, and migration-immutability validation against signed Phase 3 commit `28fcdc3`.

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
PHASE 2.4      ████████████████████  COMPLETE — SIGNED OFF (Market/Instrument Catalog)
PHASE 3        ████████████████████  COMPLETE — SIGNED OFF (Domain Model & Financial Core)
PHASE 4        ░░░░░░░░░░░░░░░░░░░░  NOT STARTED (Authentication & Authorization)
```

**Phase 3 summary (commit `28fcdc3`, on top of approved plan):** identity/configuration tables (`users`, `accounts`, `strategies`, `strategy_configurations`, `risk_configurations`, `broker_connections`), asset/wallet tables, and an immutable double-entry ledger with a PostgreSQL-side posting function. Independently verified against real PostgreSQL 18.6: balanced-entry enforcement via deferred constraint triggers (fires at commit, correctly atomic whether called directly or inside an explicit transaction), row-level locking in stable order preventing double-spend races, both idempotency outcomes (identical retry returns original; conflicting retry rejected), concurrent-posting correctness, and configuration-revision immutability (added during final review after AI #1 caught its own gap against the approved plan — versioned revisions were mutable, now correctly locked via triggers). Money represented as `NUMERIC(38,18)` with strict input canonicalization (no rounding, reject-on-imprecision). Assets deliberately not linked to Phase 2.4's instrument catalog, per the approved plan's reasoning. One minor, non-blocking type-safety inconsistency noted (`assetId` untyped vs. branded `WalletId`) for future cleanup.

**Phase 3 explicitly deferred, not yet built:** authentication (actor references are asserted values, not verified identities, until Phase 4), reserved funds/margin/P&L (require order/execution workflows that don't exist yet), multi-currency conversion, and any network-reachable API surface.

**Phase 2.4 summary (commit `3bbc1a8`, on top of approved plan `16e8e1a`):** four catalog tables (`markets`, `providers`, `instruments`, `provider_instrument_symbols`) with `RESTRICT` foreign keys, natural-key uniqueness via normalized slugs, case-sensitive C-collated provider symbols, enabled/disabled lifecycle state, and `updated_at` triggers — all independently verified against real PostgreSQL 18.6. Two real defects found and fixed during review: (1) initial migration used `bigserial` IDs, contradicting the already-approved UUIDv7 decision — fixed via PostgreSQL 18's native `uuidv7()` function rather than a hand-rolled equivalent (which was also found to have a subtle entropy flaw in its random-bit sourcing, now moot); (2) the atomic/concurrent-lock integration sub-tests broke when a second, non-idempotent real migration was introduced — fixed by decoupling those structural probes from real production migrations entirely, using self-contained synthetic fixtures instead, so this class of failure can't recur as future sprints add normal migrations. Local dev environment was upgraded from PostgreSQL 16.15 to 18.6 in the process, closing a previously-deferred version-deviation item from the ledger.

**Phase 2.4 explicitly deferred, not yet built:** instrument precision/tick-size/lot-size/margin/leverage (needs provider selection first), corporate-action handling, provider credentials/adapters, and the operator-facing selection UI.

**Next up per the phase map: Phase 3 — Domain Model & Financial Core.** This is where the platform starts handling real financial semantics — balance, position, P&L, fees, the ledger/transaction model. Given the project's own priority order (financial correctness first), expect this phase's plan review to be the most rigorous yet.

**Standing rule for every future round:** the auditor verifies claims against actual source/tests/execution output, not completion reports. A claim of "tests pass" is not accepted until this document records the actual command output that proves it.
