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

### Phase 5 — Market-Data Engine planning decisions (APPROVED 2026-10-11; full text in `docs/phase-5-plan.md`)

**Scope.** One public, unauthenticated Coinbase Exchange spot adapter (BTC-USD and ETH-USD initially): `ticker`, `matches` and `heartbeat` over WebSocket plus REST product assertions; durable immutable observations and quality evidence; a PostgreSQL-clock effective-state view that fails closed; one active engine guarded by an advisory lock; catalog provisioning and an operator halt-clear tool. No HTTP routes, no strategy dependency, no order book, no backfill, no second provider, and no execution use of the ticker bid/ask (quote-as-of-last-trade, research only).

**Approved decisions (dated 2026-10-07, re-confirmed 2026-10-11).** (1) Reconnect gaps: durable record plus automatic re-baseline; humans clear only in-session integrity halts. (2) Ticker quotes are research-only. (3) Delivery is PostgreSQL durable state plus `NOTIFY`; strategies stay database-free. (4) Dedicated writer role `platform_market_data`, never `platform_runtime`. (5) Separate `platform_catalog_provisioner`. (6) `platform_owner` only with the exact ownership/grant statements in the plan. (7) Heartbeat timeout 5,000 ms. (8) No persistence before written Coinbase terms clearance. (9) `ws@8.22.0` exact pin, subject to a recorded `npm audit`.

**Approved 2026-10-11 at the recommended values.** Ingestion age 10,000 ms; event age 10,000 ms; future skew 2,000 ms; max initial event delay 5,000 ms; price jump 2,000 bp; reset tolerance 100 bp and expiry 300,000 ms; circuit 5 failures/60 s, cool-down 30 s, half-open 10 s; heartbeat-ahead rule 4 heartbeats over 2,500 ms; circuit-close settling 4 heartbeats over 3,000 ms; advisory-lock probe 1,000 ms; `maxPayload` 64 KiB; retention indefinite and unpartitioned; operator session by interactive login. **N1:** `market_data.halt.clear` joins the global-SUPER_ADMIN branch of `platform.require_authenticated_session` (a one-line Phase 4 function change, auditor-verified against the real migration). **N2:** quarantine stores normalized candidate price/size; a clear requires the typed candidate price and creates a durable, expiring, restart-surviving jump reset. **N3:** `platform_market_data_consumer` reads only the effective-state view. **G-1 to G-8** (the plan's gap register) adopted as the auditor recommended, including the new writer-only `open_market_data_halt` function.

**Still open (external gates, not approved by this record).** Written Coinbase Market Data Terms clearance (only the user can obtain it); deployment-host reconfirmation of the 5,000 ms heartbeat timeout; the actual `npm audit` result for `ws@8.22.0`.

**Sprints.** 5.0 approvals and legal gate; 5.1 contracts, catalog, security and **all function bodies, audited against real PostgreSQL 18.x**; 5.2 adapter and validation; 5.3 persistence and effective state; 5.4 sandbox/production read-only smoke. Nothing is implemented yet.

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

### PHASE 5 — Market-Data Engine (PLAN REVIEW)
**Status: 🟢 PLAN APPROVED 2026-10-11 — planning only; no code, migration or execution exists yet. Implementation audits (Sprints 5.0–5.4) not started.**

Eight plan-review rounds. Auditor scores in order: 5.5, 6.5, 7.5, 8, 7, 6.5, 7, 7. The scores fell after revision 4 because later revisions dropped settled content and introduced new defects; the plan was therefore assembled by the auditor from the named sources (user instruction "Option A"), designing nothing new, with a visible change list. Final text: `docs/phase-5-plan.md`.

| Finding (all independently identified, not taken from reports) | Disposition |
|---|---|
| Gap rule based on ticker `sequence` +1 | Replaced. Spike evidence: ticker sequence deltas were never +1 (heartbeat deltas 174–2,783). Integrity now uses `matches.trade_id` +1 (an assumption, 0 breaks in 6,784 sampled matches, not a documented guarantee) and heartbeat `last_trade_id`. |
| Write authority granted to `platform_runtime` | Replaced by dedicated roles and definer functions; runtime has no Phase 5 access. |
| Fail-open staleness | Replaced by a database-clock effective-state view that fails closed on missing policy, NULLs, base state, stale ingestion/event, and clock anomaly. |
| `current_timestamp` used for freshness and defaults | Confirmed frozen within a transaction by real execution on PostgreSQL 18.6; `clock_timestamp()` everywhere. |
| Event-time CHECK double-counted microseconds (numeric `/`) | Confirmed by execution; replaced by integer `div`/`mod`, nine boundary samples round-tripped exactly on 18.6. |
| NULL in a quality-bucket primary key | Confirmed by execution that PK columns reject NULL; surrogate key plus `UNIQUE … NULLS NOT DISTINCT`. |
| Human halt for every reconnect gap | Option B: automatic re-baseline; human halts only for in-session violations. |
| Price-jump clear dead-ended | Typed-price confirmation plus durable, expiring reset; first in-band tick skips the jump check; unexpired resets survive restart. |
| Assembly manifest defects (found in round 8) | Invalid partial indexes (subquery predicates); revoke of `platform_runtime`'s Phase 4 EXECUTE on `require_authenticated_session`; fail-open view on NULLs; bucket guard that either blocked its own writer or was vacuous inside a definer function; ~29 settled tests and the policy/view/increment DDL dropped; stale sections. All corrected in the plan (change list C-01…C-20). |
| No write path for human halts carrying candidate values (found in assembly) | New writer-only `open_market_data_halt` (G-1), approved. |
| N1 function body supplied from memory | Mechanically compared with the real Phase 4 migration: identical plus the single permission-line change. Migration must use the real text, not AI #1's re-indented copy. |

**Evidence basis.** (a) Read-only public-feed spikes run by the user on 2026-10-02 and 2026-10-07 from scripts the auditor wrote (no prices or sizes recorded): BTC ≈5.75–6.4 matches/s, ETH ≈1.8–2.4/s; heartbeat gap p50 ≈1,000 ms, max 3,426 ms; event lag p99 up to 2,967 ms; six fractional timestamp digits; two of three captures closed by the server after ≈56–64 s, cause unknown. (b) `phase5-sql-checks.sql` executed by the user on PostgreSQL 18.6 (temp objects only). (c) Mechanical checks by the auditor: N1 text diff; all 155 distinct test names from four sources accounted for; no subquery index predicates. (d) **Not executed by anyone:** all Phase 5 DDL, grants, triggers and function bodies (none yet exist); sandbox/production smoke; `npm audit`; deployment-host heartbeat; Coinbase documentation statements on heartbeat and rate limits come from AI #1's report and were not re-fetched by the auditor.

**Open items carried into implementation (none blocking Sprint 5.0):**
1. Written Coinbase terms clearance — hard gate before persistence activates.
2. Deployment-host reconfirmation of the 5,000 ms heartbeat timeout.
3. Recorded `npm audit` for `ws@8.22.0` (advisory ranges quoted are not an exhaustive scan).
4. Every function body (including the new `open_market_data_halt`, and the idempotency-conflict path that must open a halt while still raising `23505`) must be written and audited against real PostgreSQL 18.x in Sprint 5.1.
5. The auditor-drafted `platform_owner` catalog INSERT/UPDATE column grants are provisional until the Sprint 5.1 privilege snapshot; the blanket `revoke … in schema platform from public` must be proven harmless to Phase 1–4 objects by an ACL snapshot (`runtimeKeepsPhase4GrantsUnchanged`).
6. Residual risk accepted: a superuser can `SET ROLE platform_owner` and pass the bucket guard.

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
PHASE 4.1      ████████████████████  COMPLETE — SIGNED OFF (HTTP Transport Boundary)
PHASE 5        ██░░░░░░░░░░░░░░░░░░  PLAN APPROVED 2026-10-11 — implementation not started (Market-Data Engine)
```

**Phase 5 plan summary (approved 2026-10-11, planning only, full text `docs/phase-5-plan.md`):** a single public Coinbase spot adapter whose every output fails closed. Availability is computed by PostgreSQL on its own wall clock, so a crashed or hung engine becomes unavailable within the policy bound (10 s by default) with no cooperation from the engine; consumers read only an effective-state view; all writes go through owner-owned SECURITY DEFINER functions; history tables are insert-only with trigger guards; human-latched halts are separated from automatic recovery; and a price-jump clear needs the operator to type the candidate price and creates a bounded, durable reset. The review found and fixed, by real PostgreSQL execution or mechanical comparison rather than assumption, a wrong sequence-gap rule, a frozen-clock freshness bug, a microsecond double-count in the timestamp CHECK, a NULL-in-primary-key design, and — in the final assembly — a plan step that would have revoked the Phase 4 runtime role's own authentication grant. **Phase 5 explicitly not yet built:** everything. Open gates: Coinbase terms clearance, deployment-host heartbeat check, `ws` audit evidence. **Next up: Sprint 5.0 (approval and legal gate), then Sprint 5.1 (migration, roles, grants, N1, and function bodies audited against real PostgreSQL 18.x).**

**Phase 4.1 summary (commits `d31275d` + `c12d858`):** the platform's first network-reachable listener — a real NGINX 1.30.5 (digest-pinned) reverse proxy in front of a Unix-socket-only Node API, with `__Host-`-prefixed cookies, double-submit CSRF, exact-origin checking, and a leaky-bucket rate limiter. Independently verified against a real HTTPS client, real NGINX container, and real PostgreSQL 18.6 — no mocked HTTP layer at any point. This phase found more real bugs live during implementation than any prior phase, each one only discoverable by insisting on genuine full-stack execution rather than trusting configuration on paper: (1) an NGINX `proxy_pass` URI-rewrite quirk was silently turning every request into `/`, caught only because real requests were sent to a real proxy; (2) a **pre-existing Phase 4 defect** — `apps/api/src/auth.ts` aliased `platform.users` as `user`, a PostgreSQL special identifier, causing every real login to fail with a syntax error — this had been latent and completely unexercised since Phase 4 was signed off, because Phase 4's own tests called the database functions directly rather than through the actual login code path; fixed and isolated in its own commit (`d31275d`) with a new regression test proving `authenticateAndCreateSession` works against real Postgres for the first time; (3) a genuine, externally-confirmed architectural limit (NGINX trac ticket #1005/#2420, open since 2016) — NGINX cannot emit an HTTP response for its own header-read timeout, only close the connection — resolved not by weakening the requirement but by shifting timeout authority to Node (whose own body-timeout already worked correctly) via `proxy_request_buffering off` and deliberately longer NGINX backstop timeouts, with the one genuinely unfixable case (slow headers) explicitly documented in this plan as a disclosed, RFC-permitted limitation rather than silently glossed over.

**Phase 4.1 explicitly deferred, not yet built:** `apps/web`, WebSocket/streaming, third-party/public APIs, public registration, self-service reset, and all ledger/account/trading endpoints — this phase exposes exactly three routes (`GET /v1/auth/csrf`, `POST /v1/auth/login`, `POST /v1/auth/logout`).

**Phase 4 summary (commit `7898d0e`, on top of approved plan):** Argon2id credentials, database-backed opaque sessions, account-scoped RBAC, immutable audit trail, and — critically — the Phase 3 actor-reference gap closed structurally: `post_ledger_transaction` no longer accepts a caller-supplied actor at all, deriving it from a verified session inside PostgreSQL. Deliberately no HTTP listener — that's Phase 4.1. Two real defects found and fixed during implementation, both via real PostgreSQL runs, not assumption: (1) database-level privilege separation was initially incomplete — several SECURITY DEFINER functions still executable by PUBLIC, no restricted runtime role existed — fixed with two least-privilege roles (`platform_runtime` for normal operation, `platform_provisioner` holding *only* bootstrap execution), independently verified by connecting to Postgres as the actual restricted role and proving both direct ledger writes and bootstrap execution are rejected; (2) the fixed `search_path` (a deliberate hardening measure) broke an unqualified call to `pgcrypto.digest()`, fixed by explicit schema-qualification without weakening the search-path protection that caused the failure. One authorization ambiguity resolved with reasoning, not assertion: a global `SUPER_ADMIN` does **not** implicitly gain account-scoped read access (account data stays account-scoped; global authority is limited to ledger posting and password-reset issuance) — both directions of this behavior are now proven by tests.

**Phase 4 explicitly deferred, not yet built:** any network-reachable API surface (Phase 4.1), self-service password reset (currently privileged-operator-issued only, pending a verified notification channel), and public user registration.

**Phase 3 summary (commit `28fcdc3`, on top of approved plan):** identity/configuration tables (`users`, `accounts`, `strategies`, `strategy_configurations`, `risk_configurations`, `broker_connections`), asset/wallet tables, and an immutable double-entry ledger with a PostgreSQL-side posting function. Independently verified against real PostgreSQL 18.6: balanced-entry enforcement via deferred constraint triggers (fires at commit, correctly atomic whether called directly or inside an explicit transaction), row-level locking in stable order preventing double-spend races, both idempotency outcomes (identical retry returns original; conflicting retry rejected), concurrent-posting correctness, and configuration-revision immutability (added during final review after AI #1 caught its own gap against the approved plan — versioned revisions were mutable, now correctly locked via triggers). Money represented as `NUMERIC(38,18)` with strict input canonicalization (no rounding, reject-on-imprecision). Assets deliberately not linked to Phase 2.4's instrument catalog, per the approved plan's reasoning. One minor, non-blocking type-safety inconsistency noted (`assetId` untyped vs. branded `WalletId`) for future cleanup.

**Phase 3 explicitly deferred, not yet built:** authentication (actor references are asserted values, not verified identities, until Phase 4), reserved funds/margin/P&L (require order/execution workflows that don't exist yet), multi-currency conversion, and any network-reachable API surface.

**Phase 2.4 summary (commit `3bbc1a8`, on top of approved plan `16e8e1a`):** four catalog tables (`markets`, `providers`, `instruments`, `provider_instrument_symbols`) with `RESTRICT` foreign keys, natural-key uniqueness via normalized slugs, case-sensitive C-collated provider symbols, enabled/disabled lifecycle state, and `updated_at` triggers — all independently verified against real PostgreSQL 18.6. Two real defects found and fixed during review: (1) initial migration used `bigserial` IDs, contradicting the already-approved UUIDv7 decision — fixed via PostgreSQL 18's native `uuidv7()` function rather than a hand-rolled equivalent (which was also found to have a subtle entropy flaw in its random-bit sourcing, now moot); (2) the atomic/concurrent-lock integration sub-tests broke when a second, non-idempotent real migration was introduced — fixed by decoupling those structural probes from real production migrations entirely, using self-contained synthetic fixtures instead, so this class of failure can't recur as future sprints add normal migrations. Local dev environment was upgraded from PostgreSQL 16.15 to 18.6 in the process, closing a previously-deferred version-deviation item from the ledger.

**Phase 2.4 explicitly deferred, not yet built:** instrument precision/tick-size/lot-size/margin/leverage (needs provider selection first), corporate-action handling, provider credentials/adapters, and the operator-facing selection UI.

**Next up per the phase map: Phase 3 — Domain Model & Financial Core.** This is where the platform starts handling real financial semantics — balance, position, P&L, fees, the ledger/transaction model. Given the project's own priority order (financial correctness first), expect this phase's plan review to be the most rigorous yet.

**Standing rule for every future round:** the auditor verifies claims against actual source/tests/execution output, not completion reports. A claim of "tests pass" is not accepted until this document records the actual command output that proves it.
