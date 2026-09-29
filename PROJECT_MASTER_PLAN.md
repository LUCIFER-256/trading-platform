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

### Phase 4.1 — HTTP Transport Boundary planning decisions (awaiting approval)

**Phase boundary and routes.** Phase 4.1 is the first network-reachable listener and adapts, but never duplicates, Phase 4's application/database authentication and authorization decisions. Its only routes are `GET /v1/auth/csrf`, `POST /v1/auth/login`, and `POST /v1/auth/logout`; all other paths and methods receive the same generic `404` response. No ledger, account, trading, registration, reset-redemption, public API, or frontend route is added. Login and logout call the existing opaque-session service and protected database functions; the transport adapter may validate transport syntax and map safe outcomes, but never evaluates roles, account scope, credential versions, or session validity itself.

**Named deployment topology and TLS.** Phase 4.1 uses NGINX Open Source 1.30.5, deployed from the pinned `nginx:1.30.5-alpine` image digest, as the sole internet-facing reverse proxy. It is not behind a cloud load balancer in this phase. The topology is `browser → NGINX :443 → /run/trading-platform/api.sock → Node API → private PostgreSQL`; Node exposes only that Unix-domain socket, never a TCP port. The socket directory is owned by the API identity, is not world-accessible, and grants the NGINX identity only the access needed to connect. NGINX terminates TLS 1.2/1.3, owns certificate renewal, redirects port 80 to the canonical HTTPS origin, and sends HSTS. Node ignores `Forwarded`, `X-Forwarded-For`, and `X-Forwarded-Proto`; NGINX strips those incoming headers and Node does not infer client identity or HTTPS from any forwarded header. This socket-only boundary, rather than a spoofable header, establishes that Node traffic came through the local trusted proxy.

The deployment renderer substitutes the approved canonical hostname for `api.example.invalid` before `nginx -t`; an empty, wildcard, HTTP, or non-canonical hostname fails deployment. Certificates are mounted read-only at the named paths. The following is the required NGINX configuration shape:

```nginx
http {
    limit_req_zone $binary_remote_addr zone=api_by_ip:10m rate=120r/m;
    limit_req_zone $binary_remote_addr zone=login_by_ip:10m rate=10r/m;
    limit_req_zone $binary_remote_addr zone=csrf_by_ip:10m rate=30r/m;
    limit_req_status 429;
    server_tokens off;

    server {
        listen 80 default_server;
        server_name _;
        return 308 https://api.example.invalid$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name api.example.invalid;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_certificate /etc/trading-platform/tls/fullchain.pem;
        ssl_certificate_key /etc/trading-platform/tls/privkey.pem;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        client_max_body_size 8k;
        large_client_header_buffers 2 4k;
        client_header_timeout 15s;
        client_body_timeout 25s;
        keepalive_timeout 5s;
        send_timeout 20s;
        proxy_read_timeout 25s;
        proxy_send_timeout 25s;
        proxy_request_buffering off;
        limit_req zone=api_by_ip burst=20 nodelay;

        location = /v1/auth/login {
            limit_req zone=login_by_ip burst=9 nodelay;
            proxy_pass http://unix:/run/trading-platform/api.sock:/;
            proxy_set_header Host api.example.invalid;
            proxy_set_header Forwarded "";
            proxy_set_header X-Forwarded-For "";
            proxy_set_header X-Forwarded-Proto "";
        }

        location = /v1/auth/csrf {
            limit_req zone=csrf_by_ip burst=5 nodelay;
            proxy_pass http://unix:/run/trading-platform/api.sock:/;
            proxy_set_header Host api.example.invalid;
            proxy_set_header Forwarded "";
            proxy_set_header X-Forwarded-For "";
            proxy_set_header X-Forwarded-Proto "";
        }

        location / {
            proxy_pass http://unix:/run/trading-platform/api.sock:/;
            proxy_set_header Host api.example.invalid;
            proxy_set_header Forwarded "";
            proxy_set_header X-Forwarded-For "";
            proxy_set_header X-Forwarded-Proto "";
        }
    }
}
```

NGINX error pages for `400`, `413`, `431`/NGINX's header-overflow status, and `429` must be internal JSON locations returning the same safe envelopes specified below; they must never return NGINX's stock HTML error pages. NGINX cannot emit an interceptable response for its own incomplete-header timeout because it must complete parsing before it can select an upstream: slow/incomplete request headers therefore close with no response body. This standard, safe, RFC-permitted NGINX behavior is a known limitation of reverse-proxy architectures, not a defect. `proxy_request_buffering off` streams complete-header request bodies to Node, so Node's 15-second body timeout returns the proper JSON `408`. The production image is digest-pinned rather than floating; its version and digest are recorded in deployment configuration and reviewed on upgrades.

**Local HTTPS development.** Local development uses the same NGINX-to-Unix-socket topology and does not weaken `Secure` cookies. The certificate tool is `mkcert`. Each developer installs it by the approved operating-system package method, then performs the one-time local trust-store setup with `mkcert -install`. The development certificate is then created with `mkcert -cert-file .local/tls/localhost.pem -key-file .local/tls/localhost-key.pem localhost 127.0.0.1 ::1`. `.local/tls/` is ignored by Git and never copied to production. Browsers therefore reach `https://localhost`, including in black-box tests; HTTP is only the redirect path.

**Cookie transport and CSRF.** The authenticated cookie is named `__Host-platform_session`, contains only the opaque `selector.secret` value, and is always `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` with no `Domain` attribute. Logout clears it with the same name, path, and security attributes plus `Max-Age=0`, even if its selector is already invalid, avoiding a session-validity oracle. `Secure` is unconditional in every environment. The `__Host-` prefix enforces host-only scope, `Secure`, and `Path=/` in supporting browsers.

An independent 256-bit `__Host-platform_csrf` cookie is also `Secure; SameSite=Strict; Path=/` with no `Domain`; it is deliberately not `HttpOnly` because same-origin browser code must copy it into `X-CSRF-Token`. `GET /v1/auth/csrf` issues it with `Max-Age=600`; successful login rotates it with `Max-Age=28800`. SameSite Strict is necessary but not sufficient defense in depth: every state-changing request, including login and logout, requires both an exact allowed `Origin` and constant-time equality between the CSRF cookie and header. Missing/mismatched Origin and missing/mismatched CSRF token return the identical `403 {"error":"request_rejected"}` response.

**Origin and CORS.** `PLATFORM_ALLOWED_ORIGINS` is a required comma-separated list of exact HTTPS origins; startup rejects wildcard, path-bearing, credential-bearing, HTTP, or empty values. Phase 4.1 supports no cross-origin access and emits no `Access-Control-Allow-*` headers. A mismatched or absent Origin on a state-changing request produces the generic `403` above, without revealing the expected origin, proxy topology, or route policy. Cross-origin preflight receives no CORS permission.

**Request parsing and time limits.** Node independently enforces an 8 KiB total header/request-line limit, at most 64 headers, a 2 KiB request-target/query limit, and an 8 KiB `application/json; charset=utf-8` body limit. It accepts neither multipart nor compressed/streaming request bodies. Header completion is limited to 10 seconds, body completion to 15 seconds, total request work to 20 seconds, and idle keep-alive to 5 seconds. Declared or streamed oversized bodies return `413`; malformed framing, invalid UTF-8, malformed JSON, unknown fields, and unsupported content types return `400`; slow/incomplete request bodies return JSON `408 {"error":"request_timeout"}`. Slow/incomplete request headers close with no response body because NGINX must fully parse them before selecting Node; this is standard, safe, RFC-permitted behavior rather than a defect. NGINX's 15-second header and 25-second body/proxy timeouts are bounded backstops, while `proxy_request_buffering off` allows Node to enforce the body timeout first.

**Rate limiting: exact algorithm and present scope.** The only Phase 4.1 HTTP limiter is NGINX's `limit_req` leaky-bucket algorithm keyed by `$binary_remote_addr`; there is no Node-side authenticated-session limiter in this phase. The prior proposal for a session-selector limiter is explicitly forward-looking and is neither implemented nor tested while logout is the only authenticated route. Any later authenticated route requires a new approval for its limiter, including whether it needs distributed state. The database's transactional per-login-identifier failure/lockout policy remains the credential authority; it is not an HTTP rate-limiting algorithm. NGINX's all-route limiter is 120 requests/minute with a 20-request immediate burst, login is 10 requests/minute with a nine-request immediate burst, and CSRF issuance is 30 requests/minute with a five-request immediate burst. `nodelay` means accepted burst requests are not queued. In a fresh login limiter state, the normal 10/minute slot plus nine excess slots accepts ten immediate login attempts; the eleventh immediate attempt is `429`, and one slot becomes available every six seconds. The black-box boundary test uses a fresh NGINX instance and a single client address so this sequence is deterministic. NGINX returns `429 {"error":"rate_limited"}` with a bounded `Retry-After`; database lockout still records only requests that passed the edge limiter.

**Transport error mapping and response hardening.** Every API response is JSON with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. Responses are: malformed input `400 {"error":"invalid_request"}`; missing/invalid session `401 {"error":"authentication_required"}`; authorization denial `403 {"error":"forbidden"}`; CSRF/origin rejection `403 {"error":"request_rejected"}`; unknown route/method `404 {"error":"not_found"}`; oversized body `413 {"error":"request_too_large"}`; oversized headers `431 {"error":"request_headers_too_large"}`; rate limit `429 {"error":"rate_limited"}`; `DatabaseInfrastructureError` or unavailable database `503 {"error":"service_unavailable"}`; and unexpected failure `500 {"error":"internal_error"}`. Classification uses stable error categories/SQLSTATEs, never message matching. Responses and logs never include stack traces, SQL messages, schema names, hosts, cookies, credentials, CSRF tokens, request bodies, or client-supplied correlation identifiers.

**Required black-box verification.** The HTTP suite starts a real Node API, a real NGINX 1.30.5 container using the configuration above, a real test TLS certificate trusted by the client, and PostgreSQL 18.6. It uses a real HTTPS client and never calls handlers directly or mocks the HTTP server/proxy. It proves cookie flags on actual `Set-Cookie` headers; port-80 redirect and absence of a public Node port; missing/mismatched/cross-origin CSRF rejection; absent CORS permission on an origin mismatch; the fresh-state ten-login-accepted/eleventh-login-`429` leaky-bucket boundary; malformed JSON, invalid content type, declared/chunked body overflow, header overflow, slow-header connection closure without a response, and slow-body JSON `408`; safe `503` mapping after real database unavailability; and valid/revoked session behavior through the real cookie parser and Phase 4 database authority path. Typecheck, unit tests, architecture validation, this black-box suite, the PostgreSQL integration suite, and migration immutability validation remain mandatory before review.

**Explicitly deferred.** `apps/web`, WebSocket/SSE/streaming and protocol upgrades, public or third-party APIs, API keys/OAuth, public registration, self-service reset, ledger/account/trading endpoints, a cloud load balancer, and any Node-native TLS or public TCP listener remain out of scope.

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
PHASE 4        ████████████████████  COMPLETE — SIGNED OFF (Authentication & Authorization)
PHASE 4.1      ░░░░░░░░░░░░░░░░░░░░  NOT STARTED (HTTP Transport Boundary)
```

**Phase 4 summary (commit `7898d0e`, on top of approved plan):** Argon2id credentials, database-backed opaque sessions, account-scoped RBAC, immutable audit trail, and — critically — the Phase 3 actor-reference gap closed structurally: `post_ledger_transaction` no longer accepts a caller-supplied actor at all, deriving it from a verified session inside PostgreSQL. Deliberately no HTTP listener — that's Phase 4.1. Two real defects found and fixed during implementation, both via real PostgreSQL runs, not assumption: (1) database-level privilege separation was initially incomplete — several SECURITY DEFINER functions still executable by PUBLIC, no restricted runtime role existed — fixed with two least-privilege roles (`platform_runtime` for normal operation, `platform_provisioner` holding *only* bootstrap execution), independently verified by connecting to Postgres as the actual restricted role and proving both direct ledger writes and bootstrap execution are rejected; (2) the fixed `search_path` (a deliberate hardening measure) broke an unqualified call to `pgcrypto.digest()`, fixed by explicit schema-qualification without weakening the search-path protection that caused the failure. One authorization ambiguity resolved with reasoning, not assertion: a global `SUPER_ADMIN` does **not** implicitly gain account-scoped read access (account data stays account-scoped; global authority is limited to ledger posting and password-reset issuance) — both directions of this behavior are now proven by tests.

**Phase 4 explicitly deferred, not yet built:** any network-reachable API surface (Phase 4.1), self-service password reset (currently privileged-operator-issued only, pending a verified notification channel), and public user registration.

**Phase 3 summary (commit `28fcdc3`, on top of approved plan):** identity/configuration tables (`users`, `accounts`, `strategies`, `strategy_configurations`, `risk_configurations`, `broker_connections`), asset/wallet tables, and an immutable double-entry ledger with a PostgreSQL-side posting function. Independently verified against real PostgreSQL 18.6: balanced-entry enforcement via deferred constraint triggers (fires at commit, correctly atomic whether called directly or inside an explicit transaction), row-level locking in stable order preventing double-spend races, both idempotency outcomes (identical retry returns original; conflicting retry rejected), concurrent-posting correctness, and configuration-revision immutability (added during final review after AI #1 caught its own gap against the approved plan — versioned revisions were mutable, now correctly locked via triggers). Money represented as `NUMERIC(38,18)` with strict input canonicalization (no rounding, reject-on-imprecision). Assets deliberately not linked to Phase 2.4's instrument catalog, per the approved plan's reasoning. One minor, non-blocking type-safety inconsistency noted (`assetId` untyped vs. branded `WalletId`) for future cleanup.

**Phase 3 explicitly deferred, not yet built:** authentication (actor references are asserted values, not verified identities, until Phase 4), reserved funds/margin/P&L (require order/execution workflows that don't exist yet), multi-currency conversion, and any network-reachable API surface.

**Phase 2.4 summary (commit `3bbc1a8`, on top of approved plan `16e8e1a`):** four catalog tables (`markets`, `providers`, `instruments`, `provider_instrument_symbols`) with `RESTRICT` foreign keys, natural-key uniqueness via normalized slugs, case-sensitive C-collated provider symbols, enabled/disabled lifecycle state, and `updated_at` triggers — all independently verified against real PostgreSQL 18.6. Two real defects found and fixed during review: (1) initial migration used `bigserial` IDs, contradicting the already-approved UUIDv7 decision — fixed via PostgreSQL 18's native `uuidv7()` function rather than a hand-rolled equivalent (which was also found to have a subtle entropy flaw in its random-bit sourcing, now moot); (2) the atomic/concurrent-lock integration sub-tests broke when a second, non-idempotent real migration was introduced — fixed by decoupling those structural probes from real production migrations entirely, using self-contained synthetic fixtures instead, so this class of failure can't recur as future sprints add normal migrations. Local dev environment was upgraded from PostgreSQL 16.15 to 18.6 in the process, closing a previously-deferred version-deviation item from the ledger.

**Phase 2.4 explicitly deferred, not yet built:** instrument precision/tick-size/lot-size/margin/leverage (needs provider selection first), corporate-action handling, provider credentials/adapters, and the operator-facing selection UI.

**Next up per the phase map: Phase 3 — Domain Model & Financial Core.** This is where the platform starts handling real financial semantics — balance, position, P&L, fees, the ledger/transaction model. Given the project's own priority order (financial correctness first), expect this phase's plan review to be the most rigorous yet.

**Standing rule for every future round:** the auditor verifies claims against actual source/tests/execution output, not completion reports. A claim of "tests pass" is not accepted until this document records the actual command output that proves it.
