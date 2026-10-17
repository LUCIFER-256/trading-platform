# Phase 5 — Market-Data Engine: Approved Plan

**Status: APPROVED AS A PLAN on 2026-10-11 (user reply "confirmed" to the assembled plan and the auditor's recommendations). Planning only: this approves the design, the Tier-B/C parameters at their recommended values, N1/N2/N3, the interactive operator-login flow, and gaps G-1…G-8 as recommended. Gap G-9 and correction C-21 were added 2026-10-17 and risk acceptance RA-1 was recorded 2026-10-17 (see §0.2, §0.3, §3.1). Two external gates remain OPEN and are not approved by this record: (1) written Coinbase Market Data Terms clearance (gates persistence activation; only the user can obtain it); (2) deployment-host reconfirmation of the 5,000 ms heartbeat timeout. Implementation begins at Sprint 5.0.**

Assembled by AI #2 (auditor) under the user's "Option A" instruction. Design rule for this assembly: **nothing new is designed here.** Every clause comes from one of the four named sources. Where the sources contradict each other or are silent, the clause is listed in Part 0 as a *correction* (verified defect, mechanical fix) or a *gap* (needs a user decision). It is never silently resolved.

Sources (all on disk, all re-read in full for this assembly):

| Tag | Source | What it supplied |
|---|---|---|
| R5 | `phase5-rev5.md` (AI #1 revision 5) | Base text for every section not replaced; sprint breakdown; DDL for increments, table `providers.enabled`; the full rev-5 test inventory |
| 5.1 | `phase5-amendments-5.1.md` | Settled-decision register, durable reset model, operator-tool text, evidence boundary |
| FC | Final Candidate | Canonical name inventory, grant matrix, diff register, policy/observation/state DDL, effective-state view, clear semantics |
| MAN | Assembly manifest | REPLACE sections 4–11, 14–16, 18, 19, new §11a, merged test inventory |
| AUD | Auditor evidence | Spike measurements (2026-10-02/07); PostgreSQL 18.6 execution (2026-10-08); diff of N1 against the real Phase 4 migration |

Baseline: `PROJECT_MASTER_PLAN.md` SHA-256 `e4ed6e6d6943af426243509b2caea667d27d44110b72b2c637dfdbf20f23186f`; Git HEAD `67d759d38c9fce33c2f0436dc6922deac1debc93`.

---

# Part 0 — Assembly record (read this first)

## 0.1 Verification performed by the auditor on this assembly

| Check | Method | Result |
|---|---|---|
| N1 function body vs real Phase 4 migration | Extracted `platform.require_authenticated_session` from `packages/database/src/migrations/20260925090000_create_authentication_authorization.ts`; applied the single N1 change; compared with N1's text, whitespace-insensitive, by script | **Match.** N1 = real body + the one permission-line change, nothing else. |
| N1 "no other byte changes" claim | Same comparison, whitespace-sensitive | **Claim as worded is unsatisfiable.** AI #1's copy is re-indented; it is not byte-identical to the migration. The Phase 5 migration must contain the real Phase 4 text with only the one line changed, not AI #1's reformatted copy. (Correction C-14.) |
| Test inventory completeness | Script: union of names in R5 §15, 5.1 table, FC §15, MAN inventory | MAN carried 89 names; 66 names from R5/5.1/FC were absent. Each is now either restored (§15.1) or retired with a named replacement (§15.3). A final script check is recorded in 0.6. |
| Invalid SQL in MAN §11 | Read against PostgreSQL rules | Two partial-index predicates contain subqueries: invalid. Replaced (C-03). |
| Phase 4 regression in MAN §11a | Compared MAN's REVOKE list with the real Phase 4 GRANT block (lines 289–312) | MAN revokes `platform_runtime`'s existing EXECUTE on `require_authenticated_session`. Phase 4 grants it deliberately (line 305). That would break Phase 4. Corrected (C-06). |

No PostgreSQL 18.x instance is available to the auditor in this session. **All SQL below is proposed, not executed**, except the three expressions listed in §19 that the user executed on PostgreSQL 18.6.

## 0.2 Corrections (verified defects, mechanical fixes — each needs the user's eyes, none needs a design choice)

| ID | Defect found in sources | Correction in this plan |
|---|---|---|
| C-01 | MAN dropped the whole rev-5/FC DDL for `providers.enabled`, `price_increment`, `size_increment` (and their checks) | Restored verbatim from R5 §5/§6 (§6) |
| C-02 | MAN dropped `market_data_policies` DDL and the effective-state view | Restored from FC §11/§12 (§11, §7) |
| C-03 | MAN `market_data_halts_one_open_per_instrument` and `market_data_jump_resets_one_active_per_instrument` use `WHERE NOT EXISTS (subquery)`. PostgreSQL index predicates cannot contain subqueries | Both indexes removed. "One open halt" / "one active reset" are enforced inside the owning functions under an `instrument_state` row lock (§11.4). MAN's two replacement unique indexes are kept. |
| C-04 | FC `market_data_halts` carries `cleared_at` and a partial unique index on it; MAN made halts insert-only. The two are incompatible | MAN model kept: no `cleared_at`; cleared = a resolution row exists |
| C-05 | FC effective-state view lets NULL timestamps fall through to `AVAILABLE` (a NULL comparison is not true, so the `else` branch wins). MAN §7 requires fail-closed on NULLs | View now has explicit NULL branches (§7.2) |
| C-06 | MAN §11a revokes `platform_runtime` EXECUTE on `require_authenticated_session` | `platform_runtime` is removed from that REVOKE. Phase 4 grants stay exactly as they are. New test `runtimeKeepsPhase4GrantsUnchanged`. |
| C-07 | MAN bucket guard is unconditional (`raise` always) yet "the bucket-append function is the sole writer". An unconditional trigger blocks the function too. FC's version is `SECURITY DEFINER`, where `current_user` is always the owner, so its check is vacuous | Guard is a plain (non-definer) trigger function that raises unless `current_user = 'platform_owner'`. Inside the owner-owned definer append function `current_user` is the owner; for any direct DML by another role, including a superuser, it is not. (This is the 5.1 text, with FC's `SECURITY DEFINER` flag removed.) Residual: a superuser can `SET ROLE platform_owner`; stated in §17. (§11.5) |
| C-08 | MAN says "buckets are insert-only" but its append function upserts (increments) | Buckets are the single documented exception: written only by the aggregate append function, never deleted, never truncated (§11.5) |
| C-09 | MAN §13/FC clear step 3 reads `account_role_assignments` for SUPER_ADMIN, but `platform_owner` has no SELECT on that table (by grant) | The global-SUPER_ADMIN check is done by `require_authenticated_session` itself, via N1. The clear function does not re-read the table. (§11b) |
| C-10 | MAN circuit-settling rule is 4 heartbeats / 3,000 ms (§9, §18). FC DDL default is 3 / 2,500. MAN's "Changes" text does not mention the change | One value everywhere: **4 / 3,000** (policy defaults, §9, §18, tests). Rationale in the sources themselves: at ~1 Hz, three heartbeats span ~2,000 ms, so "3 within ≥2,500" in practice already requires a 4th. Still a pending user decision (D-07). |
| C-11 | R5 §7 says it "will use integer millisecond interval construction, not float literals"; FC view uses `make_interval(secs => ms::double precision/1000)` | View uses `ms * interval '1 millisecond'` (exact integer arithmetic) |
| C-12 | MAN/FC grant matrix says provisioner has "manifest DML"; MAN §6/§11a says provisioner has EXECUTE on one function only. The definer function runs as `platform_owner`, which was given only SELECT on the catalog | Provisioner: EXECUTE only (MAN §6). `platform_owner` gets the minimal catalog INSERT/UPDATE column grants the manifest function needs (§11a). Column lists are an auditor draft, fixed by the Sprint 5.1 privilege snapshot. |
| C-13 | R5 §4 promised consumers `received_at`; the state table and view have no such column | Consumer contract = the view's columns. `received_at` is stored in observations (diagnostics) but is not a consumer field. |
| C-14 | N1 byte claim (see 0.1) | Migration uses the real Phase 4 text; `requireAuthenticatedSessionDefinitionSnapshot` asserts the stored definition equals Phase-4 text with exactly one changed line |
| C-15 | R5 §12 error taxonomy has no code for an idempotency conflict, but MAN §8/§9 treat it as a human halt that is *not* a provider-circuit failure | Added `IDEMPOTENCY_CONFLICT` to `MarketDataErrorCode` (§12) |
| C-16 | MAN labels the consumer role "N2"; R5 uses N2 for candidate storage/reset semantics | R5 labels kept: N1 Phase-4 change; N2 candidate storage + reset; **N3** consumer role |
| C-17 | R5 §17 says "partition observations monthly"; 5.1 excluded partitioning (conflicts with the global idempotency key) | Monthly partitioning removed from risks (§17) |
| C-18 | R5 §3 says Coinbase rate-limit documentation was "not retrievable"; 5.1/FC report it was and quote 10 req/s/IP, burst 15 | §3 uses the 5.1/FC statement, tagged *AI #1 report, not independently re-fetched by auditor*; local cap stays 10 req/s |
| C-19 | MAN dropped the R5 rows for ticker `trade_id` jump, heartbeat-ahead pending, heartbeat behind match, no heartbeat, queue overflow | All restored into §8 with MAN's reason codes |
| C-20 | MAN's retry formula and R5's differ (multiplicative jitter vs additive) | FC's disposition used: `min(30000, 500·2^(n−1)) + U[0,250]` ms (§9) |
| C-21 | §11.4 and §11b said "the newest *unconsumed*, unexpired reset". Read literally, an older unconsumed reset R1 becomes the candidate again as soon as the newer R2 is consumed, and the next ordinary tick is judged against R1's band and halts falsely (found by the auditor 2026-10-17 in the Stage 1 migration audit and reproduced: a tick at 70,200 was halted after R2 at 70,000 was consumed while R1 at 60,000 was still unconsumed and unexpired). This contradicted G-5 ("older unconsumed rows are ignored") | **The newest reset row for the instrument by `id` (consumed or not) is the only candidate; it is eligible only if it has no consumption row and, where the function says so, is unexpired. Older resets are never candidates.** Applied in `append_market_data_observation` and `market_data_startup_recovery`. New test `olderUnconsumedResetNotResurrectedAfterNewerConsumed` (§15.1) |

## 0.3 Gaps — the sources did not decide these; **DECIDED 2026-10-11: each adopted as the auditor recommended**

| ID | Gap | Why it mattered | Decision (adopted 2026-10-11) |
|---|---|---|---|
| G-1 | **No function in the approved inventory can durably open a human halt or quarantine that carries candidate values.** `transition_market_data_state(uuid,text,text,uuid)` carries no price/size/trade/sequence/reference. `append_market_data_observation` is only specified to open an `IDEMPOTENCY_CONFLICT` halt. Locked/crossed, out-of-order, in-session gap, price jump and product-assertion halts therefore have no write path, and `PRICE_JUMP` halts require `candidate_price` and `reference_price` by CHECK. | Without it the engine cannot fail closed on its own detections. | ADOPTED: add one writer-only definer function, e.g. `platform.open_market_data_halt(p_provider_id uuid, p_instrument_id uuid, p_reason_code text, p_event_at timestamptz, p_trade_id numeric, p_provider_sequence numeric, p_candidate_price numeric, p_candidate_size numeric, p_reference_price numeric) returns uuid`, EXECUTE to `platform_market_data` only. |
| G-2 | `transition_market_data_state(uuid,text,text,uuid)` has no defined parameter meanings. | Behavior contract cannot be audited. | ADOPTED reading: `(p_provider_id, p_new_base_availability, p_reason_code, p_instrument_id)`; `p_instrument_id NULL` = all enabled instruments of the provider. Confirm or replace. |
| G-3 | **Who consumes a jump reset?** The observation function receives only the 15 tick fields; reset consumption must be atomic with the accepted observation, and the engine and database could race. | Atomicity of "first in-band tick skips the jump check". | ADOPTED: the observation function enforces it in SQL: if an unconsumed, unexpired newest reset exists for the instrument, an in-band tick inserts the consumption row in the same transaction; an out-of-band/expired tick is not accepted (the engine opens a `PRICE_JUMP` halt via G-1). |
| G-4 | **Provider-level circuit parameters live in per-instrument policy rows.** FC puts `circuit_*` and `heartbeat_*` columns in `market_data_policies` (one row per instrument), while the circuit is provider-level. Which row governs is undefined. | Ambiguous runtime behavior. | ADOPTED: engine refuses to start unless all enabled policy rows of the provider agree on every `circuit_*`/`heartbeat_*` column. Adds no new semantics; fails closed. |
| G-5 | **Which reset wins when two exist for one instrument?** Insert-only means an unconsumed reset R1 can remain when a later out-of-band tick re-halts and a second clear creates R2. | Startup and observation behavior. | ADOPTED: newest reset (by `id`, uuidv7 is time-ordered) is the only candidate; older unconsumed rows are ignored. |
| G-6 | **Increment column names.** 5.1 says `base_increment` / `quote_increment` (provider terms); R5, FC, MAN and the grant lists use `price_increment` / `size_increment`. | Every grant, view and manifest field. | ADOPTED: keep `price_increment` / `size_increment` (used by all later sources); document the mapping quote→price, base→size. Either is acceptable; it must be one. |
| G-7 | **Does a no-op catalog manifest write an audit event?** 5.1 test `catalogManifestIsIdempotent` says "changes no rows". Each application writing an audit row contradicts "no rows" if read literally. | Test wording. | ADOPTED: test asserts catalog and policy tables unchanged; each application (including no-op) writes one audit row. |
| G-8 | **Clear and tick semantics after clear.** FC §13 step 8 says the instrument returns to `AVAILABLE` "only after the next admissible accepted observation". The state to hold *between* clear and that observation is not named. | Availability value in the interim. | ADOPTED: `UNAVAILABLE_REBASELINING`. |
| G-9 | **Catalog manifest JSON shape.** The plan names `catalog/phase5-coinbase-spot.json` and the function but never defined the manifest's fields (AI #1 stopped on this, 2026-10-16). | Function validation, catalog file, provisioning tool. | DECIDED 2026-10-16/17 (user): `{manifest_version:1, provider:{provider_code}, market:{market_code, enabled}, instruments:[{instrument_code, provider_symbol, enabled, price_increment, size_increment, policy:{enabled, …optional `market_data_policies` columns}}]}`; unknown keys rejected at every level; omitted policy columns take the table defaults; the manifest never sets `providers.enabled`; an instrument may be enabled only with present, positive, canonical increments. **Code values must satisfy the catalog's lowercase format (`^[a-z0-9]+(?:-[a-z0-9]+)*$`): `coinbase-exchange`, `crypto-spot` (user may change), `btc-usd`, `eth-usd`; exchange symbols stay `BTC-USD` / `ETH-USD`** (the auditor's first example used `BTC-USD` and `coinbase_exchange` as codes in error). Everything in the file is `enabled: false` until the user approves. |
| S-2 | **Out-of-band or expired-reset tick.** The plan had the function decline it and the engine open the halt afterwards. | Same atomicity question as S-1. | DECIDED 2026-10-16: **Option A** (proposed by AI #1, accepted by the user's confirmation of the auditor's recommendation) — the observation function writes the `PRICE_JUMP` halt atomically and returns `PRICE_JUMP_HALT`; fourth outcome and invariants added to the result shape. Note: the crash-window argument is weaker here than for S-1 because the reset state persists and the condition re-detects; the reason for A is one decision point for reset semantics under the instrument-state lock. |
| S-1 | **Idempotency conflict vs. `23505`.** An exception aborts the transaction, so a halt written in the same call is rolled back. | The plan could not both persist the halt and raise. | DECIDED 2026-10-16: **Option B** — the append function writes the halt atomically and returns a typed `IDEMPOTENCY_CONFLICT` result; no exception. No crash window; departs from the `23505` convention. |

## 0.4 Decisions status

Tier B and C parameters are listed in §18. Remaining open after the 2026-10-11 approval: **only** written Coinbase terms clearance and deployment-host heartbeat reconfirmation (both external gates). **Risk acceptance RA-1 (user, 2026-10-17):** while the clearance request is unanswered the owner proceeds past the terms gate (see §3.1); this accepts the risk, it does not clear the gate, and any Coinbase reply replaces it. Everything else listed in §18 and G-1…G-8 is decided.

## 0.5 What is explicitly *not* in this plan

Function bodies. Section 11b and §11a give each function as a **behavior contract** (inputs, guarantees, forbidden behavior, error codes). Writing and auditing the bodies against real PostgreSQL 18.x is the **Sprint 5.1 deliverable**; no body in this document should be treated as reviewed SQL.

## 0.6 Mechanical completeness checks (recorded at assembly time)

Run by the auditor after writing: (a) every test name in R5/5.1/FC/MAN appears in §15.1 or §15.3; (b) every table in the FC name inventory appears in §11 DDL; (c) every function in the FC name inventory has a §11b contract; (d) no `where not exists`/`select` inside an index predicate. Results: all 155 distinct test names from R5/5.1/FC/MAN are present in §15.1 or §15.3 (every replacement named in §15.3 exists in §15.1); all 10 FC/MAN tables and the view have DDL in §11/§7.2; all 7 approved functions plus the 3 trigger functions have DDL or a §11b contract; zero index predicates contain a subquery; zero `default current_timestamp` remain in Phase 5 DDL.

---

# Part 1 — The plan

# Phase 5 — Market-Data Engine Plan (final candidate)

Planning only. No code, migration, configuration, or commit is changed by this document.

## Approved decisions

Record dated 2026-10-07. Approved; not re-opened here.

1. Reconnect gap recovery is Option B: durable gap record plus automatic re-baseline after reconnect; human clears only in-session integrity halts.
2. Ticker bid/ask are quote-as-of-last-trade and may support Phase 5 quality work and Phase 6 research only. Execution-facing use requires separately approved book data.
3. Cross-process delivery is PostgreSQL durable state plus `NOTIFY`, consumed by a future orchestrator. Strategies remain database-free.
4. The engine uses dedicated `platform_market_data`, not `platform_runtime`.
5. Catalog provisioning uses separate `platform_catalog_provisioner`.
6. `platform_owner` is approved only with the exact ownership and privilege statements in §11a.
7. Heartbeat timeout is 5,000 ms, to be re-confirmed on the deployment host.
8. Persistence cannot activate before written Coinbase terms clearance in Sprint 5.0.
9. `ws@8.22.0` exact pin is approved in principle, subject to the advisory disposition in §3 and §19.

## 1. Exact phase boundary

Phase 5 builds one public Coinbase Exchange spot-market adapter for the approved active configuration, initially BTC-USD and ETH-USD, with:

- Product REST assertion at startup and reconnect.
- Public WebSocket subscriptions for `ticker`, `matches`, and `heartbeat`.
- Provider parsing, canonical normalization, validation, durable observations, durable quality evidence, effective-latest reads, and `NOTIFY`.
- Database-clock fail-closed availability.
- One active engine instance guarded by a dedicated advisory-lock connection.
- Provisioning and operator-clear command-line tools, but no HTTP routes.

Explicitly deferred: other providers, multi-provider failover, trading, execution, order-book maintenance, historical backfill, candles, REST trade replay, production scheduler/orchestrator, user-facing status APIs, Phase-13 backtesting ingestion, and `level2_batch` (it needs maintained book state, sequence/resync design and snapshot storage; its public-access status was not verified). [Coinbase documentation index](https://docs.cdp.coinbase.com/exchange/introduction/welcome) (accessed 2026-10-08).

Planned additions/changes:

- `apps/market-data/src/main.ts`
- `apps/market-data/src/coinbase/{ws-client,rest-products,adapter}.ts`
- `apps/market-data/src/{engine,queue,circuit,quality-aggregator,advisory-lock}.ts`
- `apps/market-data/src/tools/{apply-catalog-manifest,clear-halt}.ts`
- `packages/market-data/src/{contracts,normalization,validation,availability,errors}.ts`
- `packages/database/src/migrations/202610…_market_data_engine.ts` — new migration only
- `packages/database/src/{schema,market-data-repository}.ts`
- `catalog/phase5-coinbase-spot.json` (provisioning input; not a migration seed)
- `tests/{unit,integration,fixtures,fake-provider}/market-data-*`
- `.dependency-cruiser.cjs`, package manifests and lockfile only as required by the approved dependency addition

No existing migration is modified. The one Phase 4 function change (N1) is made by `CREATE OR REPLACE` inside the new migration.

## 2. Architecture and dependency boundaries

Flow: `adapter → normalizer → validator → writer function → durable state/view → consumer`.

| Stage | Location | May depend on | Must not depend on |
|---|---|---|---|
| Coinbase wire adapter | `apps/market-data` | `packages/market-data`, shared/core, `ws` | strategies, trading, HTTP/API |
| Normalization/validation | `packages/market-data` | shared/core only | database, provider SDKs, Node networking |
| Persistence/distribution | `apps/market-data` plus database repository | market-data, database, shared/core | strategies, trading, HTTP |
| Consumer contract | `packages/market-data` | shared/core | provider, database implementation |
| Future orchestrator | future app | market-data, database | provider-specific adapter internals |

`packages/market-data` exports only provider-neutral contracts. Coinbase types never cross its app boundary. The adapter holds no database credential beyond the dedicated `platform_market_data` login. Consumers receive only the effective-state view. All database mutation is through owner-owned `SECURITY DEFINER` functions.

Dependency-cruiser additions:

- `packages/market-data` may import only `packages/core`.
- `apps/market-data` may import `packages/core`, `packages/market-data`, and `packages/database`.
- `packages/strategies` may import only core, market-data, and trading; it may not import `apps/market-data`, database, `ws`, or Coinbase-named paths.
- A negative architecture test injects a prohibited strategy→Coinbase import and requires dependency-cruiser to fail.

## 3. Provider selection and external evidence

Primary: Coinbase Exchange public spot market data, BTC-USD and ETH-USD. Alternate: none in Phase 5.

Coinbase's official landing page says market-data APIs are public (REST/WebSocket/FIX); use of Exchange market data is governed by the Market Data Terms of Use. [Overview](https://docs.cdp.coinbase.com/exchange/introduction/welcome) (accessed 2026-10-08).

| Topic | Phase-5 position |
|---|---|
| Authentication | Public ticker/matches/heartbeat feed, no credentials. |
| Transport | WSS public feed plus HTTPS `GET /products`; documented endpoint `https://api.exchange.coinbase.com/products`. [Products API](https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproducts) |
| Symbols | Coinbase product IDs, e.g. `BTC-USD`; catalog maps them through `provider_instrument_symbols`; matched exactly and case-sensitively. |
| Product assertions | `status='online'`; `trading_disabled=false`; `cancel_only=false`; `limit_only=false`; `post_only=false`; `auction_mode=false`; `status_message` absent, `null`, or `""`; product ID and increments match the catalog and parse as canonical decimals. (AUD 2026-10-07: BTC-USD returns `status_message` as a present empty string.) |
| Timestamps | RFC-3339 UTC with exactly six fractional digits → integer epoch microseconds. (AUD: six digits observed on every message.) |
| Sequence | Provider `sequence` supports duplicate/order diagnostics only; not contiguous (AUD: ticker deltas were never +1; heartbeat deltas 174–2,783). A heartbeat is out of sequence only if lower than the previous heartbeat. |
| Trade integrity | `matches.trade_id` strict `+1` is a Phase-5 integrity assumption, not a documented guarantee. AUD spike 2026-10-02: no breaks in 6,784 sampled matches — limited empirical evidence. Ticker `trade_id` jumps are not gaps (the ticker batches cascading matches). |
| Heartbeat | Coinbase documents heartbeat roughly every second with sequence/last-trade data, and warns that matches can be dropped, directing clients to heartbeat plus REST recovery. [Channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels) (accessed 2026-10-08; *AI #1 report in 5.1/FC; not independently re-fetched by the auditor*). AUD: heartbeat gap p50 ≈1,000 ms, max 3,426 ms over four captures. |
| Rate limits | Public REST documented at 10 requests/s/IP, burst 15, lazy-fill token bucket. [Rate limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits) (accessed 2026-10-08; *AI #1 report, not re-fetched by auditor*). Local cap: 10 requests/s. |
| Reconnect/resume | A reconnect starts a fresh subscription and re-baseline; no resume guarantee assumed. |
| Licensing | Written Coinbase Market Data Terms clearance is a Sprint-5.0 activation gate. Terms read by the auditor 2026-10-11 (version dated August 7, 2026); see §3.1. |
| Cost/free tier | Coinbase's feed documentation says the public feed is available without authentication and mentions no fees; the Terms (Clause 7) refer to "applicable fees" for the subscribed product and no fee schedule for the public feed was found. Unverified; asked of Coinbase in the clearance request. |
| Outage/quality caveat | AUD: two of three capture sessions were closed by the server after ≈56–64 s; one 15-minute session had no reconnect. Cause not established. |

`ws@8.22.0` is exact-pinned in `package.json`; the lockfile integrity entry must match npm's resolved tarball SHA-512. GitHub's advisory database lists `ws` CVE-2026-48779 / GHSA-96hv-2xvq-fx4p (affects `>=8.0.0 <8.21.0`, fixed 8.21.0) and CVE-2026-45736 / GHSA-58qx-3vcg-4xpx (affects `>=8.0.0 <8.20.1`, fixed 8.20.1); `8.22.0` is outside both ranges. [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p), [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) (accessed 2026-10-08). **This is not an exhaustive scan.** Sprint 5.0 must record the actual `npm audit` command and output. [Release 8.22.0](https://github.com/websockets/ws/releases/tag/8.22.0).

`ws` enforces `maxPayload: 65_536`; TLS certificate verification is never disabled; only `wss:` endpoints are accepted.

### 3.1 Operating constraints from the Market Data Terms (read 2026-10-11)

Source: [Coinbase Market Data Terms of Use](https://www.coinbase.com/legal/market_data), version dated August 7, 2026. The auditor read it through a summarizing fetch tool; **the clause wording must be re-verified on the page by the user before the clearance is recorded.** These constraints bind every later phase:

| # | Constraint | Basis | Consequence for this project |
|---|---|---|---|
| T-1 | Internal use only: personal or research purposes, for the user or their entity; not "an application intended for use by end users" | Clause 2 | User statement, recorded 2026-10-11: **this is a personal trading platform used only by the owner.** Any second user, any other entity, or any end-user-facing application requires fresh clearance and re-opens approved decision 8. |
| T-2 | No redistribution or display of Market Data or derived works outside the organization | Clause 3.2 | No export, sharing, publication or third-party feed of stored observations or anything derived from them. |
| T-3 | No indexes, benchmarks, fair-value prices or valuations built from the data | Clauses 3.3, 3.4 | None is planned; none may be added without clearance. |
| T-4 | **No use of the data to develop, train, fine-tune, teach, validate, benchmark or improve any AI/ML model** | Clause 3.5 | Stored observations must not be used for machine-learning strategies. Phase 6 and Phase 13 must be planned with this: rule-based research only, or a different, licensed data source. |
| T-5 | Storage, caching and retention are **not addressed** by the Terms | absence | Silence is not permission. Indefinite retention (§18 item 15) is conditional on Coinbase's written answer. If Coinbase refuses or limits retention, §18 item 15 and Sprint 5.3 are re-opened before persistence is built. |
| T-6 | Coinbase may withdraw, suspend or change data or access at any time, without notice | Clause 5 | Already covered: the engine fails closed, the effective-state view goes unavailable, strategies HOLD. No design change; a second provider remains a possible later mitigation. |
| T-7 | The licence is revocable and the Terms can change; continued use is acceptance | Clauses 2, 6 | The clearance record names the version date it covered; re-check the Terms at each phase boundary. |

The written clearance request asks Coinbase to confirm storage and retention, internal research and own-account trading, internal derived values, fees, and connection limits.

**Risk acceptance RA-1 — recorded 2026-10-17 by the user ("accept RA-1").** The request to marketdata@coinbase.com has had no reply. Until it does, the owner proceeds with Sprints 5.2 and 5.3 (connecting to Coinbase and storing market data) without written clearance. Accepted risks: the Terms do not address storage or retention (T-5); Coinbase may suspend or change access or the Terms at any time (T-6, T-7); the owner's reading of "personal use" is unconfirmed in writing. **Hard limits that RA-1 does not relax:** no redistribution, publication or sharing of the data or anything derived from it (T-2); no indexes, benchmarks or fair-value prices (T-3); no AI/ML training or validation on the data, so Phases 6 and 13 stay rule-based or use another licensed source (T-4); one user only, the owner (T-1) — a second user or an end-user application voids RA-1. **Revisit triggers:** a Coinbase reply (it replaces RA-1); any block or Terms change; at every phase boundary the Terms page is re-read. **Consequence if Coinbase refuses or limits retention:** collection stops and stored data is handled as Coinbase says, which may mean deleting it. Still open: the owner re-verifies the clause wording on the live Terms page (the auditor read it through a summarizing tool). RA-1 is a recorded acceptance of risk, not clearance; the gate remains open and the engine must not describe itself as cleared.

## 4. Contracts

```
type DecimalString = string; // canonical, finite, base-10, no exponent, no +, no leading zero except "0"

type MarketDataAvailability =
  | "AVAILABLE"
  | "UNAVAILABLE_NO_POLICY"
  | "UNAVAILABLE_DISABLED_SCOPE"
  | "UNAVAILABLE_REBASELINING"
  | "UNAVAILABLE_PROVIDER_CIRCUIT"
  | "UNAVAILABLE_PERSISTENCE"
  | "UNAVAILABLE_HUMAN_HALT"
  | "UNAVAILABLE_STALE"
  | "UNAVAILABLE_CLOCK_ANOMALY";

type MarketDataQualityState =
  | "ACCEPTED"
  | "REJECTED_MALFORMED" | "REJECTED_NONFINITE" | "REJECTED_NONPOSITIVE"
  | "REJECTED_OFF_GRID" | "REJECTED_FUTURE_TIME" | "REJECTED_EXCESSIVE_EVENT_DELAY"
  | "REJECTED_EVENT_TIME_REGRESSION" | "REJECTED_DUPLICATE" | "REJECTED_OUT_OF_ORDER"
  | "QUARANTINED_PRICE_JUMP"
  | "HALTED_LOCKED_OR_CROSSED" | "HALTED_TRADE_ID_GAP" | "HALTED_HEARTBEAT_GAP"
  | "REBASELINING_AFTER_RECONNECT"
  | "UNAVAILABLE";
```

`DecimalString` is canonical finite base-10 text represented in PostgreSQL as `numeric(38,18)`: at most **20 integer digits and 18 fractional digits**. A value outside either bound is **rejected, never rounded**. Grid and jump arithmetic use arbitrary-precision integer scaled values; there is no signed-64-bit rule.

`provider_symbol` is exact, case-sensitive `text COLLATE "C"`. The adapter never lowercases or otherwise normalizes it.

Canonical persisted ticker observation:

| Field | Type | Nullable |
|---|---|---|
| `providerId`, `instrumentId` | UUID | no |
| `providerSymbol` | text (C collation) | no |
| `providerSequence`, `tradeId` | canonical unsigned integer text in memory; `numeric(20,0)` in DB | no |
| `eventAt`, `receivedAt`, `ingestedAt` | UTC timestamp | no |
| `eventAtUs` | integer microseconds since Unix epoch, `0..253402300799999999` | no |
| `bidAsOfLastTrade`, `askAsOfLastTrade`, `lastTradePrice` | `DecimalString` | no |
| `bidSizeAsOfLastTrade`, `askSizeAsOfLastTrade`, `lastTradeSize` | `DecimalString` | no |
| `volume24h` | `DecimalString`, informational, `>= 0` | **yes** |
| `source` | `"coinbase_exchange"` | no |

`receivedAt` is the engine's injected wall-clock receipt time, kept for queue-delay diagnostics. `ingestedAt` is assigned by PostgreSQL `clock_timestamp()` at function execution and is the authoritative persistence clock.

**Consumer contract.** A consumer reads **only** `platform.market_data_effective_state`, by instrument, on every decision attempt and after every `NOTIFY`. The consumer fields are exactly the view's columns (§7.2): provider, observation, sequence, trade ID, bid/ask and sizes as-of-last-trade, last price/size, volume, `event_at`, `ingested_at`, `availability`, `evaluated_at`. (`received_at` is stored but is not a consumer field — C-13.) A missing row means `UNAVAILABLE_NO_POLICY`; consumers never reuse a previously available value. Any `UNAVAILABLE_*` yields `LatestMarketDataResult { availability, observation: null }` and strategy/risk must return `HOLD`/no new decision.

## 5. Time, symbols, and normalization

The engine receives each frame, records `receivedAt` from an injected wall clock, parses provider `time` as UTC, and stores microseconds exactly. The engine's monotonic clock controls local timers only.

- Timestamp requires RFC-3339 UTC and exactly six fractional digits; otherwise reject as `MALFORMED`.
- Event timestamp must satisfy `receivedWallClock − max_initial_event_delay_ms ≤ eventAt ≤ receivedWallClock + max_future_skew_ms` (defaults 5,000 / 2,000 ms, approved).
- Event-time regression is rejected if `eventAtUs < lastAcceptedEventAtUs` for the instrument.
- Wall-clock movement either way fails closed through database-time age checks. A host suspend can stop the monotonic clock; stale therefore means monotonic **or** database-wall-clock deadline expired.
- Provider clock skew outside the interval is rejected; it does not rewrite receipt time.

`event_at_us` must equal, to the microsecond:

```
timestamptz 'epoch'
+ div(event_at_us, 1000000)::bigint * interval '1 second'
+ mod(event_at_us, 1000000)::bigint * interval '1 microsecond'
```

(AUD: executed on PostgreSQL 18.6, exact round trip on nine samples including 2^53+1 µs and the maximum `9999-12-31 23:59:59.999999`. The revision-4 expression using numeric `/` double-counted microseconds.)

Provider mapping query (exact, C-collated):

```
select pis.instrument_id, i.enabled as instrument_enabled,
       m.enabled as market_enabled, p.enabled as provider_enabled
from platform.provider_instrument_symbols pis
join platform.instruments i on i.id = pis.instrument_id
join platform.markets m on m.id = i.market_id
join platform.providers p on p.id = pis.provider_id
where pis.provider_id = $1
  and pis.provider_symbol collate "C" = $2 collate "C"
  and pis.enabled;
```

Unmapped or disabled symbol/instrument/market/provider: reject the message, aggregate a `DISABLED_OR_UNMAPPED` bucket, persist no observation, leave the instrument unavailable.

## 6. Precision and catalog provisioning

New catalog columns (nullable first; validated and enabled only after provisioning):

```
alter table platform.providers
  add column enabled boolean not null default false;

alter table platform.instruments
  add column price_increment numeric(38,18),
  add column size_increment  numeric(38,18);

alter table platform.instruments
  add constraint instruments_price_increment_positive
    check (price_increment is null or price_increment > 0),
  add constraint instruments_size_increment_positive
    check (size_increment is null or size_increment > 0);
```

`providers.enabled` is added here because the existing catalog migration has no such column (verified against `20260923090000_create_market_instrument_catalog.ts`). The migration does not make the increments `NOT NULL`; existing tests may keep inserting inactive instruments without increments. An **enabled** market-data policy requires both increments non-null and positive (enforced by the manifest function and by startup refusal). Increment naming is gap G-6.

Seed data is not hidden in a migration. The versioned `catalog/phase5-coinbase-spot.json` manifest is applied through `platform.apply_market_data_catalog_manifest(jsonb)`, callable only by `platform_catalog_provisioner`. It validates the manifest, writes catalog and policy changes, and writes a `catalog_manifest_applied` audit event through `append_audit_event`. The provisioner has no direct DML on any table.

Grid arithmetic: scale the canonical decimal to 18 fractional digits as an arbitrary-precision integer; reject more than 18 fractional digits or more than 20 integer digits. For value `v` and increment `g`: valid iff `v > 0`, `g > 0`, `v mod g = 0`. Jump test: `abs(candidate − reference) × 10_000 > reference × max_price_jump_bps`; a zero reference rejects; no division occurs.

## 7. Staleness and downstream behavior

### 7.1 Per-instrument policy defaults

```
max_ingestion_age_ms        10000
max_event_age_ms            10000
max_future_skew_ms           2000
max_initial_event_delay_ms   5000
max_price_jump_bps           2000
heartbeat_timeout_ms         5000
```

Database policy wins; there are no competing hard-coded values. Startup skips (never aborts on) an instrument with a missing/disabled policy row. All defaults are listed in §18 and approved 2026-10-11; the heartbeat timeout (decision 7) still needs deployment-host reconfirmation.

### 7.2 Effective-state view

Computed by PostgreSQL on every read, on `clock_timestamp()` (execution on 18.6 confirmed `current_timestamp` is frozen at transaction start). It fails closed for: missing policy, disabled policy, no state row, non-`AVAILABLE` base state, NULL observation ID, NULL ingestion timestamp, NULL event timestamp, stale ingestion, stale event, and future clock anomaly.

```
create view platform.market_data_effective_state
with (security_barrier = true) as
select
  p.instrument_id, s.provider_id, s.observation_id, s.provider_sequence, s.trade_id,
  s.bid_as_of_last_trade, s.bid_size_as_of_last_trade,
  s.ask_as_of_last_trade, s.ask_size_as_of_last_trade,
  s.last_trade_price, s.last_trade_size, s.volume_24h,
  s.event_at, s.ingested_at,
  case
    when not p.enabled then 'UNAVAILABLE_DISABLED_SCOPE'
    when s.instrument_id is null then 'UNAVAILABLE_STALE'
    when s.base_availability <> 'AVAILABLE' then s.base_availability
    when s.observation_id is null or s.ingested_at is null or s.event_at is null
      then 'UNAVAILABLE_STALE'
    when s.ingested_at < clock_timestamp() - p.max_ingestion_age_ms * interval '1 millisecond'
      then 'UNAVAILABLE_STALE'
    when s.event_at < clock_timestamp() - p.max_event_age_ms * interval '1 millisecond'
      then 'UNAVAILABLE_STALE'
    when s.event_at > clock_timestamp() + p.max_future_skew_ms * interval '1 millisecond'
      then 'UNAVAILABLE_CLOCK_ANOMALY'
    else 'AVAILABLE'
  end as availability,
  clock_timestamp() as evaluated_at
from platform.market_data_policies p
left join platform.market_data_instrument_state s using (instrument_id);
```

An instrument with no policy row produces **no row**: contractually `UNAVAILABLE_NO_POLICY`. Column comments name the quote fields "as-of-last-trade". The view does not join the catalog; a catalog disablement takes effect because the engine rejects the symbol and ingestion stops, so availability falls to `UNAVAILABLE_STALE` within `max_ingestion_age_ms`.

After the last committed ingestion, availability can stay `AVAILABLE` for at most `max_ingestion_age_ms` (10,000 ms by default; at 10,001 ms it is `UNAVAILABLE_STALE`). That bound holds after a SIGKILL or a hung engine with a live lock. A consumer rereads after every notification and immediately before every decision.

## 8. Validation, quality actions, and recovery

Message-level rejects (`requires_human_clear = false`) are aggregated into 60-second buckets, never individual rows and never latched.

| Trigger | Exact condition | Scope | Durable result | Availability / recovery |
|---|---|---|---|---|
| Missing/type-invalid field | required field absent or wrong JSON type | message | `REJECT` bucket `MALFORMED` | unchanged; next message |
| Numeric token for decimal | JSON source token for price/size/volume is a number, not a string | message | `REJECT` `MALFORMED` | unchanged |
| Non-finite / non-canonical | decimal fails the canonical parser | message | `REJECT` `NONFINITE` | unchanged |
| Non-positive | price/size `<= 0` | message | `REJECT` `NONPOSITIVE` | unchanged |
| Off-grid | scaled value mod increment ≠ 0 | message | `REJECT` `OFF_GRID` | unchanged |
| Future time | event > receipt + `max_future_skew_ms` | message | `REJECT` `FUTURE_TIME` | unchanged |
| Excessive delay | receipt − event > `max_initial_event_delay_ms` | message | `REJECT` `EXCESSIVE_EVENT_DELAY` | unchanged |
| Event regression | event µs < last accepted for the instrument | message | `REJECT` `EVENT_TIME_REGRESSION` | unchanged |
| Duplicate trade ID | equals a prior accepted identity | message | `REJECT` `DUPLICATE` | unchanged |
| Disabled / unmapped | symbol not enabled in the catalog | message | `REJECT` `DISABLED_OR_UNMAPPED` (instrument may be NULL) | unchanged |
| Ticker trade-ID jump | ticker `trade_id` differs from the previous ticker | message | none — accepted if otherwise valid; no gap inference | matches validate independently |
| Heartbeat ahead, pending | heartbeat `last_trade_id > lastMatchedTradeId` | instrument | none | stays `AVAILABLE` during settling |
| Heartbeat behind match | `last_trade_id < lastMatchedTradeId` | message | none | accept; cross-channel order is not assumed |
| Out-of-order match | connected-session match `trade_id < lastMatchedTradeId` | instrument | `HALT` `OUT_OF_ORDER_MATCH_ID`, human clear | `UNAVAILABLE_HUMAN_HALT` |
| In-session match gap | connected-session `trade_id > lastMatchedTradeId + 1`, no disconnect | instrument | `HALT` `IN_SESSION_MATCH_GAP`, human clear | human halt |
| Locked/crossed quote | bid `>= ask` | instrument | `HALT` `LOCKED_OR_CROSSED`, human clear | human halt |
| Price jump | `abs(candidate − reference) × 10000 > reference × max_price_jump_bps` | instrument | `QUARANTINE` `PRICE_JUMP`, human clear | human halt |
| Product assertion failure | any assertion in §3 fails | provider/instrument | `HALT` `PRODUCT_ASSERTION_FAILURE`, human clear | human halt |
| Idempotency mismatch | same provider/instrument/trade ID, any compared field differs | instrument | the append function writes the `HALT` `IDEMPOTENCY_CONFLICT` event and halt **atomically** and returns a typed `IDEMPOTENCY_CONFLICT` result; it does not raise (S-1, decided Option B), human clear | human halt; **not** a provider-circuit failure |
| Heartbeat ahead confirmed | ahead on ≥4 consecutive heartbeats spanning ≥2,500 ms | instrument | `RECOVERY` `HEARTBEAT_GAP`, not human-clear | `UNAVAILABLE_REBASELINING`; forced reconnect; first valid ticker re-baselines |
| Heartbeat timeout | no heartbeat for `heartbeat_timeout_ms` after ready | provider | `RECOVERY` `HEARTBEAT_TIMEOUT`, not human-clear | forced reconnect; counts as a failed attempt |
| Queue overflow / persistence timeout | queue length 1,024 / write > 1,000 ms | provider | `RECOVERY` `QUEUE_OVERFLOW` / `PERSISTENCE_TIMEOUT` | `UNAVAILABLE_PERSISTENCE`; reconnect |

The ticker is **never** pre-validated against matches: AUD spike observed ticker-before-its-own-match in 12–74% of samples across runs. Match continuity is independent and retroactive.

Worked timelines:

- Match 100 then connected-frame match 102 → immediate `HALT(true)` `IN_SESSION_MATCH_GAP`; a reconnect does not clear it.
- Heartbeat ahead: last matched ID 100; heartbeats with last-trade 101 at ≈T0, T0+1,000, T0+2,000, T0+3,000 ms. The fourth confirms ≥2,500 ms: `RECOVERY(false)`, disconnect, reconnect, first valid ticker re-baselines. (A two-second span cannot be satisfied by two heartbeats at ~1 Hz; the rule is deliberately 4/2,500.)
- Heartbeat timeout: last heartbeat at T0; at T0+5,000 ms force close, record the recovery event, count a failed attempt, enter backoff.
- Price clear: accepted price `P`; candidate `1.25P` quarantined with price/size/trade/event evidence; operator confirms by typing the candidate price; the clear creates a resolution and a durable reset. The first structurally valid in-band ticker is accepted without a jump comparison and becomes the reference; the next tick `1.60P` is compared against `1.25P` and re-quarantines if over threshold.

**Price-jump rule.** Reference = latest accepted observation price recovered from the database, regardless of restart or reconnect. **No time window exempts a jump**: a 5-second gap, 60-second gap, one-hour outage and a process restart all compare the first candidate with the recovered reference. This is deliberately conservative; a genuine large move across a long outage can stop research data until an operator reviews and clears it.

| Situation | Reference | Outcome if above threshold |
|---|---|---|
| 5-second gap | latest accepted DB price | human-clear quarantine |
| 60-second gap | latest accepted DB price | human-clear quarantine |
| 1-hour gap | latest accepted DB price | human-clear quarantine |
| Process restart | recovered DB price | human-clear quarantine |

## 9. Provider failure handling

The provider circuit is separate from instrument human halts. Ordinary validation rejects never increment its failure count.

A **failed attempt** is: connection error, close before stable readiness, heartbeat timeout, confirmed heartbeat-ahead reconnect, queue overflow, persistence timeout, HTTP 429, malformed-payload threshold, or product assertion failure. A subscription acknowledgement alone does not reset attempts; an acknowledgement followed by a drop is still a failure.

Retry delay for attempt `n >= 1` (C-20):

```
min(30000, 500 × 2^(n−1)) + U[0,250] ms     U = uniform integer in [0,250] inclusive, from an injected PRNG
```

Attempt 1 waits 500–750 ms.

State machine:

- `CLOSED → OPEN`: five failed attempts within a rolling 60,000 ms.
- `OPEN`: no connection attempt for 30,000 ms.
- `OPEN → HALF_OPEN`: exactly one connection attempt.
- `HALF_OPEN → SETTLING`: product assertions, subscription acknowledgements, and one valid ticker for each active **non-human-halted** instrument within 10,000 ms.
- `SETTLING → CLOSED`: **four** valid consecutive heartbeats spanning at least **3,000 ms** (arrivals ≈ T0, +1,000, +2,000, +3,000 ms). Any missing, invalid or lower-sequence heartbeat resets the count.
- Any failure in `HALF_OPEN` or `SETTLING` reopens for 30,000 ms.

Example: failures at 0, 1, 3, 7, 15 s open the circuit at 15 s; it stays open to 45 s, then half-opens.

Three malformed payloads in 60,000 ms force a provider reconnect and count one failed attempt. HTTP 429 honors `Retry-After` if present, otherwise 60,000 ms, and counts as a failed attempt. Authentication/TLS errors open the circuit for 30 minutes and require deployment remediation.

BTC human-halted, ETH healthy: BTC is excluded from half-open acceptance; ETH can restore provider `CLOSED`; BTC stays `UNAVAILABLE_HUMAN_HALT`. A later disconnect re-baselines ETH while BTC stays halted.

Provider-level circuit parameters (G-4, decided): the engine reads `circuit_*` and `heartbeat_*` values from the provider's enabled policy rows and **refuses to start unless all of them agree** on every such column; it fails closed and adds no other semantics.

## 10. Queue, circuit, and distribution

The adapter-to-persistence queue is FIFO, capacity 1,024. Overflow rejects the incoming item, writes a synchronous recovery event, marks the provider's instruments `UNAVAILABLE_PERSISTENCE`, closes the socket and reconnects. Each stored-function call has a 1,000 ms deadline. A database outage never drops data silently.

At the AUD-observed ≈7.5 matches/s the queue buffers ≈136 s. It is a safety fuse, not an availability promise. The measurement is a small Kampala sample, not capacity evidence.

The advisory lock uses one dedicated non-pooled connection:

```
select pg_try_advisory_lock(hashtextextended('platform.market_data.engine.v1', 0));
```

It probes `select 1` every 1,000 ms (approved). Lock loss or probe failure aborts the process immediately; PostgreSQL releases the session lock. A second instance exits before consuming any message if acquisition returns false.

`NOTIFY market_data_changed, '<instrument UUID>'` fires only after commit. Notifications are hints: consumers reread the view, and a missed notification cannot preserve stale availability. A local timer may emit a notification on anticipated staleness but is never a safety authority.

## 11. Persistence, roles, exact SQL shape

Persistence activates only after written Coinbase terms clearance.

Storage estimate: 7.5 observations/s × 86,400 = 648,000/day; at a planning figure of 420 indexed bytes/row ≈ 272 MB/day ≈ 99 GB/year before WAL, vacuum, quality data and index overhead. A 100 rows/s stress case is 8.64 million/day. **Retention: indefinite, unpartitioned (approved 2026-10-11)** (partitioning conflicts with the global idempotency key `(provider_id, instrument_id, trade_id)`).

### 11.1 Roles

```
create role platform_owner nologin noinherit;
create role platform_market_data nologin noinherit;
create role platform_market_data_operator nologin noinherit;
create role platform_catalog_provisioner nologin noinherit;
create role platform_market_data_consumer nologin noinherit;
```

No `platform_migration_runner` or migration-login role is introduced. Migrations run through `apps/api/src/migrate.ts` → `runMigrationCommand()` → `createDatabaseClient()` with `DATABASE_URL`; tests use `TEST_DATABASE_URL`. **Deployment precondition:** that connection must be a superuser or be authorized to create these roles and `ALTER … OWNER TO platform_owner`. The API runtime login is unchanged. `platform_owner` is non-login and non-superuser.

### 11.2 Tables

All new IDs default to `uuidv7()`. `clock_timestamp()` is used for every ingestion/creation default, never `current_timestamp`.

```
create table platform.market_data_policies (
  instrument_id uuid primary key references platform.instruments(id) on delete restrict,
  enabled boolean not null default false,
  max_ingestion_age_ms integer not null default 10000 check (max_ingestion_age_ms between 100 and 600000),
  max_event_age_ms integer not null default 10000 check (max_event_age_ms between 100 and 3600000),
  max_future_skew_ms integer not null default 2000 check (max_future_skew_ms between 0 and 60000),
  max_initial_event_delay_ms integer not null default 5000 check (max_initial_event_delay_ms between 100 and 3600000),
  max_price_jump_bps integer not null default 2000 check (max_price_jump_bps between 1 and 1000000),
  heartbeat_timeout_ms integer not null default 5000 check (heartbeat_timeout_ms between 1000 and 600000),
  circuit_failure_threshold integer not null default 5 check (circuit_failure_threshold between 1 and 100),
  circuit_failure_window_ms integer not null default 60000 check (circuit_failure_window_ms between 1000 and 3600000),
  circuit_cooldown_ms integer not null default 30000 check (circuit_cooldown_ms between 1000 and 3600000),
  circuit_half_open_ready_ms integer not null default 10000 check (circuit_half_open_ready_ms between 1000 and 3600000),
  heartbeat_ahead_count integer not null default 4 check (heartbeat_ahead_count between 4 and 100),
  heartbeat_ahead_span_ms integer not null default 2500 check (heartbeat_ahead_span_ms between 2500 and 3600000),
  heartbeat_settle_count integer not null default 4 check (heartbeat_settle_count between 3 and 100),
  heartbeat_settle_span_ms integer not null default 3000 check (heartbeat_settle_span_ms between 2500 and 3600000),
  jump_reset_tolerance_bps integer not null default 100 check (jump_reset_tolerance_bps between 1 and 1000000),
  jump_reset_ttl_ms integer not null default 300000 check (jump_reset_ttl_ms between 1000 and 3600000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
```

(Differs from FC only in `heartbeat_settle_count`/`_span_ms` defaults, C-10.)

```
create table platform.market_data_observations (
  id uuid primary key default uuidv7(),
  provider_id uuid not null references platform.providers(id) on delete restrict,
  instrument_id uuid not null references platform.instruments(id) on delete restrict,
  provider_symbol text collate "C" not null,
  provider_sequence numeric(20,0) not null check (provider_sequence >= 0),
  trade_id numeric(20,0) not null check (trade_id >= 0),
  event_at_us numeric(20,0) not null check (event_at_us between 0 and 253402300799999999),
  event_at timestamptz not null,
  received_at timestamptz not null,
  ingested_at timestamptz not null default clock_timestamp(),
  bid_as_of_last_trade numeric(38,18) not null check (bid_as_of_last_trade > 0),
  bid_size_as_of_last_trade numeric(38,18) not null check (bid_size_as_of_last_trade > 0),
  ask_as_of_last_trade numeric(38,18) not null check (ask_as_of_last_trade > 0),
  ask_size_as_of_last_trade numeric(38,18) not null check (ask_size_as_of_last_trade > 0),
  last_trade_price numeric(38,18) not null check (last_trade_price > 0),
  last_trade_size numeric(38,18) not null check (last_trade_size > 0),
  volume_24h numeric(38,18) check (volume_24h is null or volume_24h >= 0),
  unique (provider_id, instrument_id, trade_id),
  check (event_at = timestamptz 'epoch'
    + div(event_at_us,1000000)::bigint * interval '1 second'
    + mod(event_at_us,1000000)::bigint * interval '1 microsecond')
);

create table platform.market_data_instrument_state (
  instrument_id uuid primary key references platform.instruments(id) on delete restrict,
  provider_id uuid not null references platform.providers(id) on delete restrict,
  observation_id uuid references platform.market_data_observations(id) on delete restrict,
  base_availability text not null check (base_availability in (
    'AVAILABLE','UNAVAILABLE_DISABLED_SCOPE','UNAVAILABLE_REBASELINING',
    'UNAVAILABLE_PROVIDER_CIRCUIT','UNAVAILABLE_PERSISTENCE','UNAVAILABLE_HUMAN_HALT'
  )),
  event_at timestamptz,
  ingested_at timestamptz,
  provider_sequence numeric(20,0),
  trade_id numeric(20,0),
  bid_as_of_last_trade numeric(38,18),
  bid_size_as_of_last_trade numeric(38,18),
  ask_as_of_last_trade numeric(38,18),
  ask_size_as_of_last_trade numeric(38,18),
  last_trade_price numeric(38,18),
  last_trade_size numeric(38,18),
  volume_24h numeric(38,18),
  last_accepted_price numeric(38,18) check (last_accepted_price is null or last_accepted_price > 0),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (base_availability = 'AVAILABLE'
      and observation_id is not null and event_at is not null and ingested_at is not null
      and last_accepted_price is not null)
    or base_availability <> 'AVAILABLE'
  )
);

create table platform.market_data_quality_events (
  id uuid primary key default uuidv7(),
  provider_id uuid not null references platform.providers(id) on delete restrict,
  instrument_id uuid references platform.instruments(id) on delete restrict,
  decision text not null check (decision in ('REJECT','QUARANTINE','HALT','RECOVERY')),
  requires_human_clear boolean not null,
  reason_code text not null check (reason_code in (
    'MALFORMED','NONFINITE','NONPOSITIVE','OFF_GRID','FUTURE_TIME',
    'EXCESSIVE_EVENT_DELAY','EVENT_TIME_REGRESSION','DUPLICATE',
    'OUT_OF_ORDER_MATCH_ID','IN_SESSION_MATCH_GAP','HEARTBEAT_GAP',
    'HEARTBEAT_TIMEOUT','LOCKED_OR_CROSSED','PRICE_JUMP','QUEUE_OVERFLOW',
    'PERSISTENCE_TIMEOUT','PRODUCT_ASSERTION_FAILURE','DISABLED_OR_UNMAPPED',
    'PROVIDER_CIRCUIT','IDEMPOTENCY_CONFLICT'
  )),
  trade_id numeric(20,0),
  provider_sequence numeric(20,0),
  event_at timestamptz,
  candidate_price numeric(38,18),
  candidate_size numeric(38,18),
  ingested_at timestamptz not null default clock_timestamp(),
  check ((decision in ('HALT','QUARANTINE') and requires_human_clear)
      or (decision in ('REJECT','RECOVERY') and not requires_human_clear))
);

create table platform.market_data_halts (
  id uuid primary key default uuidv7(),
  quality_event_id uuid not null unique references platform.market_data_quality_events(id) on delete restrict,
  instrument_id uuid not null references platform.instruments(id) on delete restrict,
  reason_code text not null check (reason_code in (
    'LOCKED_OR_CROSSED','OUT_OF_ORDER_MATCH_ID','IN_SESSION_MATCH_GAP',
    'PRICE_JUMP','PRODUCT_ASSERTION_FAILURE','IDEMPOTENCY_CONFLICT'
  )),
  candidate_price numeric(38,18),
  candidate_size numeric(38,18),
  candidate_trade_id numeric(20,0),
  candidate_provider_sequence numeric(20,0),
  reference_price numeric(38,18),
  opened_at timestamptz not null default clock_timestamp(),
  check ((reason_code = 'PRICE_JUMP' and candidate_price is not null and candidate_price > 0
          and reference_price is not null and reference_price > 0)
      or (reason_code <> 'PRICE_JUMP' and candidate_price is null and reference_price is null))
);

create table platform.market_data_halt_resolutions (
  id uuid primary key default uuidv7(),
  halt_id uuid not null unique references platform.market_data_halts(id) on delete restrict,
  actor_user_id uuid not null references platform.users(id) on delete restrict,
  actor_session_id uuid not null references platform.auth_sessions(id) on delete restrict,
  resolution_reason text not null check (length(btrim(resolution_reason)) between 1 and 500),
  confirmed_candidate_price numeric(38,18),
  resolved_at timestamptz not null default clock_timestamp()
);

create table platform.market_data_jump_resets (
  id uuid primary key default uuidv7(),
  instrument_id uuid not null references platform.instruments(id) on delete restrict,
  resolution_id uuid not null unique references platform.market_data_halt_resolutions(id) on delete restrict,
  confirmed_candidate_price numeric(38,18) not null check (confirmed_candidate_price > 0),
  tolerance_bps integer not null check (tolerance_bps between 1 and 1000000),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create table platform.market_data_jump_reset_consumptions (
  id uuid primary key default uuidv7(),
  reset_id uuid not null unique references platform.market_data_jump_resets(id) on delete restrict,
  observation_id uuid not null unique references platform.market_data_observations(id) on delete restrict,
  consumed_at timestamptz not null default clock_timestamp()
);

create table platform.market_data_quality_buckets (
  id uuid primary key default uuidv7(),
  provider_id uuid not null references platform.providers(id) on delete restrict,
  instrument_id uuid references platform.instruments(id) on delete restrict,
  reason_code text not null,
  bucket_started_at timestamptz not null,
  rejected_count bigint not null check (rejected_count > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table platform.market_data_quality_bucket_flushes (
  flush_id uuid primary key,
  flushed_at timestamptz not null default clock_timestamp()
);
```

`market_data_instrument_state` is updated on every accepted ticker (its `ingested_at` is the database-time liveness basis): one hot row per active instrument at ≈7.5 updates/s. Autovacuum tuning and bloat monitoring are mandatory. PostgreSQL primary-key columns cannot be NULL (AUD-executed), hence the surrogate key plus natural-key index on buckets.

`candidate_price` / `candidate_size` are normalized financial facts, not raw provider payloads; they exist so a human price-jump decision is auditable.

### 11.3 Indexes (all valid PostgreSQL)

```
create index market_data_observations_instrument_event_at_idx
  on platform.market_data_observations(instrument_id, event_at desc);
create index market_data_observations_latest_idx
  on platform.market_data_observations(instrument_id, ingested_at desc, id desc);
create index market_data_quality_events_open_halt_idx
  on platform.market_data_quality_events(instrument_id, ingested_at desc)
  where requires_human_clear;
create unique index market_data_quality_buckets_natural_key
  on platform.market_data_quality_buckets(provider_id, instrument_id, reason_code, bucket_started_at)
  nulls not distinct;
```

(MAN's `market_data_halts_one_resolution_per_halt` and `market_data_jump_reset_one_resolution` are redundant with the `UNIQUE` constraints already on `halt_resolutions.halt_id` and `jump_resets.resolution_id`; they are therefore **not** created. Removed: the two subquery-predicate indexes, C-03.)

### 11.4 Open-halt and active-reset rules (function-enforced)

"Cleared" is *derived*: a halt is open iff no `market_data_halt_resolutions` row references it. A reset is consumed iff a `market_data_jump_reset_consumptions` row references it. Because PostgreSQL cannot index that, every function that opens a halt, clears a halt or consumes a reset first takes `SELECT … FOR UPDATE` on the instrument's `market_data_instrument_state` row (inserting it first if absent), and enforces: **at most one open halt per instrument**, and (G-5) **only the newest reset per instrument (by `id`, consumed or not) is a candidate, and it is eligible only if it has no consumption row and is unexpired; older resets are never candidates (C-21)**. Concurrency tests are mandatory (§15).

### 11.5 Immutability and guards

Insert-only tables: observations, quality events, halts, halt resolutions, jump resets, jump-reset consumptions, flush receipts. **Exception (C-08):** buckets, written only by the aggregate append function, never deleted, never truncated.

```
create function platform.reject_market_data_history_mutation()
returns trigger language plpgsql as $$
begin raise exception 'Market-data history is immutable.' using errcode = '55000'; end $$;

create function platform.reject_market_data_history_truncate()
returns trigger language plpgsql as $$
begin raise exception 'Market-data history cannot be truncated.' using errcode = '55000'; end $$;

-- NOT security definer: current_user must be the invoking role.
create function platform.reject_market_data_bucket_mutation()
returns trigger language plpgsql as $$
begin
  if current_user <> 'platform_owner' then
    raise exception 'Market-data quality buckets are writable only by the aggregate append function.' using errcode = '42501';
  end if;
  return new;
end $$;
```

Triggers:

- Observations, quality events, halts, resolutions, resets, reset consumptions, flush receipts: `BEFORE UPDATE OR DELETE … FOR EACH ROW → reject_market_data_history_mutation()`; `BEFORE TRUNCATE … FOR EACH STATEMENT → reject_market_data_history_truncate()`.
- Buckets: `BEFORE INSERT OR UPDATE … FOR EACH ROW → reject_market_data_bucket_mutation()`; `BEFORE DELETE … FOR EACH ROW → reject_market_data_history_mutation()`; `BEFORE TRUNCATE … FOR EACH STATEMENT → reject_market_data_history_truncate()`.

Proof obligations: a non-owner direct DML test **and** a superuser direct DML test both fail on every table; the append function succeeds. Residual (§17): a superuser can `SET ROLE platform_owner`; the guard does not stop an owner-equivalent actor.

## 11a. Functions, ownership, grants, and read paths

All Phase 5 functions are owned by `platform_owner`, are `SECURITY DEFINER`, set `search_path = pg_catalog, platform`, and schema-qualify every relation. The three trigger functions in §11.5 are the stated exceptions (plain trigger functions).

Canonical function inventory:

```
platform.append_market_data_observation(uuid,uuid,text,numeric,numeric,numeric,timestamptz,timestamptz,numeric,numeric,numeric,numeric,numeric,numeric,numeric)
platform.append_market_data_quality_bucket(uuid,uuid,uuid,text,timestamptz,bigint)
platform.transition_market_data_state(uuid,text,text,uuid)
platform.market_data_startup_recovery(uuid)
platform.clear_market_data_halt(uuid,text,uuid,uuid,text,numeric)
platform.list_open_market_data_halts()
platform.apply_market_data_catalog_manifest(jsonb)
platform.open_market_data_halt(uuid,uuid,text,timestamptz,numeric,numeric,numeric,numeric,numeric)   -- added by G-1
```

Ownership and grants (run after object creation):

```
alter table platform.market_data_policies owner to platform_owner;
alter table platform.market_data_observations owner to platform_owner;
alter table platform.market_data_instrument_state owner to platform_owner;
alter table platform.market_data_quality_events owner to platform_owner;
alter table platform.market_data_halts owner to platform_owner;
alter table platform.market_data_halt_resolutions owner to platform_owner;
alter table platform.market_data_jump_resets owner to platform_owner;
alter table platform.market_data_jump_reset_consumptions owner to platform_owner;
alter table platform.market_data_quality_buckets owner to platform_owner;
alter table platform.market_data_quality_bucket_flushes owner to platform_owner;
alter view  platform.market_data_effective_state owner to platform_owner;
-- plus: alter function … owner to platform_owner for every function above

revoke all on schema platform from public;
revoke all on all tables in schema platform from public;
revoke all on all sequences in schema platform from public;
revoke all on all functions in schema platform from public;

grant usage on schema platform to platform_owner, platform_market_data,
  platform_market_data_operator, platform_catalog_provisioner, platform_market_data_consumer;

-- read access for the writer and for definer functions (owner)
grant select (id, enabled) on platform.providers to platform_market_data, platform_owner;
grant select (id, market_id, enabled, price_increment, size_increment)
  on platform.instruments to platform_market_data, platform_owner;
grant select (id, enabled) on platform.markets to platform_market_data, platform_owner;
grant select (provider_id, instrument_id, provider_symbol, enabled)
  on platform.provider_instrument_symbols to platform_market_data, platform_owner;
grant select on platform.market_data_policies to platform_market_data;

-- AUDITOR DRAFT (C-12): minimum catalog write access for the owner-run manifest function.
-- Exact column lists are fixed by the Sprint 5.1 privilege snapshot, never wider than the manifest fields.
grant select (id, market_code, enabled)               on platform.markets    to platform_owner;
grant insert (market_code, enabled)                   on platform.markets    to platform_owner;
grant update (enabled)                                on platform.markets    to platform_owner;
grant select (id, provider_code, enabled)             on platform.providers  to platform_owner;
grant insert (provider_code, enabled)                 on platform.providers  to platform_owner;
grant update (enabled)                                on platform.providers  to platform_owner;
grant select (id, market_id, instrument_code, enabled, price_increment, size_increment)
  on platform.instruments to platform_owner;
grant insert (market_id, instrument_code, enabled, price_increment, size_increment)
  on platform.instruments to platform_owner;
grant update (enabled, price_increment, size_increment) on platform.instruments to platform_owner;
grant insert (provider_id, instrument_id, provider_symbol, enabled)
  on platform.provider_instrument_symbols to platform_owner;
grant update (enabled) on platform.provider_instrument_symbols to platform_owner;

grant execute on function platform.append_market_data_observation(uuid,uuid,text,numeric,numeric,numeric,timestamptz,timestamptz,numeric,numeric,numeric,numeric,numeric,numeric,numeric) to platform_market_data;
grant execute on function platform.append_market_data_quality_bucket(uuid,uuid,uuid,text,timestamptz,bigint) to platform_market_data;
grant execute on function platform.transition_market_data_state(uuid,text,text,uuid) to platform_market_data;
grant execute on function platform.market_data_startup_recovery(uuid) to platform_market_data;
grant execute on function platform.open_market_data_halt(uuid,uuid,text,timestamptz,numeric,numeric,numeric,numeric,numeric) to platform_market_data;
grant execute on function platform.clear_market_data_halt(uuid,text,uuid,uuid,text,numeric) to platform_market_data_operator;
grant execute on function platform.list_open_market_data_halts() to platform_market_data_operator;
grant execute on function platform.apply_market_data_catalog_manifest(jsonb) to platform_catalog_provisioner;
grant select on platform.market_data_effective_state to platform_market_data_consumer;

-- Phase 4 protected functions: callable only from Phase 5 definer functions (owner).
-- C-06: platform_runtime is deliberately NOT revoked from require_authenticated_session;
-- Phase 4 grants it (line 305 of the Phase 4 migration) and the API depends on it.
revoke all on function platform.append_audit_event(text,text,uuid,uuid,uuid,uuid,uuid,jsonb)
  from public, platform_market_data, platform_market_data_operator,
       platform_catalog_provisioner, platform_market_data_consumer;
revoke all on function platform.require_authenticated_session(uuid,text,text,uuid)
  from public, platform_market_data, platform_market_data_operator,
       platform_catalog_provisioner, platform_market_data_consumer;
grant execute on function platform.append_audit_event(text,text,uuid,uuid,uuid,uuid,uuid,jsonb) to platform_owner;
grant execute on function platform.require_authenticated_session(uuid,text,text,uuid) to platform_owner;

alter default privileges for role platform_owner in schema platform revoke all on tables from public;
alter default privileges for role platform_owner in schema platform revoke execute on functions from public;
```

Matrix (`—` = no grant; `platform_runtime` has **no** Phase 5 privilege and keeps **all** Phase 4 privileges unchanged):

| Object | writer `platform_market_data` | operator | owner | provisioner | consumer |
|---|---|---|---|---|---|
| schema `platform` | USAGE | USAGE | USAGE | USAGE | USAGE |
| catalog tables | required-column SELECT | — | owner SELECT + minimal INSERT/UPDATE (C-12) | — | — |
| `market_data_policies` | SELECT | — | owner | — | — |
| all other market-data tables | — | — | owner | — | — |
| `market_data_effective_state` | — | — | owner | — | SELECT |
| observation / bucket / transition / startup_recovery / open_halt functions | EXECUTE | — | — | — | — |
| clear / list_open halts | — | EXECUTE | — | — | — |
| `apply_market_data_catalog_manifest` | — | — | — | EXECUTE | — |
| `append_audit_event`, `require_authenticated_session` | — | — | EXECUTE | — | — |

`platform_owner` receives no SELECT on `users`, `auth_sessions`, or `account_role_assignments`; the clear function reaches authentication only through the protected function. The blanket `revoke … on all … in schema platform from public` must be proven harmless by an ACL-snapshot test over every Phase 1–4 object (`runtimeKeepsPhase4GrantsUnchanged`).

### N1 — Phase 4 authorization extension (auditor-verified)

`market_data.halt.clear` joins the global-`SUPER_ADMIN` permission branch of `platform.require_authenticated_session`. The Phase 5 migration must issue `CREATE OR REPLACE FUNCTION` using the **real Phase 4 text**, changing exactly this condition (auditor-compared against the real migration: nothing else differs, whitespace-insensitive):

```
-    if p_required_permission like 'ledger.post.%' or p_required_permission = 'password.reset.issue' then
+    if p_required_permission like 'ledger.post.%'
+       or p_required_permission in ('password.reset.issue', 'market_data.halt.clear') then
```

Safeguards: the migration snapshots `pg_get_functiondef` before and after and asserts exactly the one-line difference; the full Phase 4 authorization matrix runs before and after; owner, `search_path` and ACL are asserted unchanged (`platform_runtime` still EXECUTE; PUBLIC none). Alternative if N1 is refused: a separate wrapper authorization function — avoids touching Phase 4 but duplicates authorization semantics and enlarges the security surface.

## 11b. Function behavior contracts (Sprint 5.1 writes and audits the bodies)

Common: definer, owner `platform_owner`, fixed `search_path`, bound parameters only, no dynamic SQL, no raw payload ever stored, errors use stable messages and SQLSTATEs.

**`append_market_data_observation(15 args)`** — parameters in order: provider_id, instrument_id, provider_symbol, provider_sequence, trade_id, event_at_us, event_at, received_at, bid, bid_size, ask, ask_size, last_price, last_size, volume_24h (nullable).
- Locks the instrument-state row (§11.4). Inserts one observation with `ingested_at = clock_timestamp()`.
- Idempotency: same `(provider_id, instrument_id, trade_id)` with every compared field equal (all fields except `id` and `ingested_at`) returns the existing observation without a second row; any difference writes an `IDEMPOTENCY_CONFLICT` quality event and halt (the same rows `open_market_data_halt` writes) **in the same transaction, sets state `UNAVAILABLE_HUMAN_HALT`, and returns a typed conflict result instead of raising** (S-1, decided Option B, 2026-10-16: an exception would roll the halt back, and a second engine-side transaction would leave a crash window in which the halt is never recorded). Result shape: `(outcome text, observation_id uuid, halt_id uuid)` with `outcome` in `ACCEPTED`, `DUPLICATE_IDENTICAL`, `IDEMPOTENCY_CONFLICT`, `PRICE_JUMP_HALT` and invariants — `ACCEPTED`/`DUPLICATE_IDENTICAL`: `observation_id` non-null, `halt_id` null; `IDEMPOTENCY_CONFLICT`/`PRICE_JUMP_HALT`: `observation_id` null, `halt_id` non-null (shape specified by the auditor to implement the decision; Sprint 5.1 may propose changes for approval). The engine maps `IDEMPOTENCY_CONFLICT` to the `IDEMPOTENCY_CONFLICT` error code and a human halt, never a circuit failure. The database does **not** return SQLSTATE `23505` for this case; that departs from the Phase 3 ledger convention and is accepted.
- On success updates `market_data_instrument_state`: all latest values, `last_accepted_price`, `ingested_at`, `base_availability = 'AVAILABLE'` — **only if** the instrument has no open halt; never clears a halt.
- Jump-reset consumption (G-3, decided): the function itself enforces the reset. If an eligible reset exists (newest, unconsumed, unexpired) and the tick's price is inside `confirmed × (1 ± tolerance_bps/10,000)`, the function inserts the consumption row in the same transaction as the observation and skips the ordinary jump comparison; an out-of-band tick, or any tick after the newest reset has expired, is **not** accepted: in the same transaction the function writes the `QUARANTINE` `PRICE_JUMP` quality event (`requires_human_clear = true`), the halt row (candidate price/size/trade/sequence; reference price = the instrument's `last_accepted_price`), and sets state `UNAVAILABLE_HUMAN_HALT`; it writes **no** observation and **no** consumption row, and returns outcome `PRICE_JUMP_HALT` with the halt ID (S-2, decided Option A). Ordinary jump detection when **no** reset exists stays engine-side (arbitrary-precision comparison against the recovered reference, then `open_market_data_halt`): there, a declined tick changes no state, so a crash before the halt is written is self-healing — the next tick meets the same unchanged reference and is detected again.
- Emits `pg_notify('market_data_changed', instrument_id::text)`; the notification is delivered only on commit (PostgreSQL semantics), proven by `notifyOccursOnlyAfterCommit`.
- Forbidden: updating or deleting any history row; writing for a disabled policy.

**`append_market_data_quality_bucket(flush_id, provider_id, instrument_id|NULL, reason_code, bucket_started_at, count)`** — inserts the flush receipt first; a duplicate receipt returns with no count change (receipt retry never double-counts). Otherwise it is the only permitted upsert: `rejected_count = existing + excluded`, `updated_at = clock_timestamp()`, on the natural-key index. Count must be `> 0`. NULL `instrument_id` is valid.

**`transition_market_data_state(provider_id, new_base_availability, reason_code, instrument_id|NULL)`** — parameter meanings confirmed (G-2). Writes one `RECOVERY` quality event (`requires_human_clear = false`) and changes only mutable state (`base_availability`, `updated_at`). Rejects any transition that would set `AVAILABLE` or would clear `UNAVAILABLE_HUMAN_HALT` (only an accepted observation sets `AVAILABLE`; only the clear function ends a halt). Rejects reason codes that are human-latched.

**`open_market_data_halt(provider_id, instrument_id, reason_code, event_at, trade_id, provider_sequence, candidate_price, candidate_size, reference_price) returns uuid`** (G-1) — writer-only. Locks the instrument-state row (§11.4); refuses if the instrument already has an open halt; writes one quality event (`HALT`, or `QUARANTINE` for `PRICE_JUMP`; `requires_human_clear = true`) and the halt row atomically; sets base state `UNAVAILABLE_HUMAN_HALT`. `reason_code` must be one of the six halt reasons; candidate/reference prices are required for `PRICE_JUMP` and forbidden otherwise (the table CHECK is the backstop). Never clears or edits anything.

**`market_data_startup_recovery(instrument_id)`** — read-only; returns for one instrument: last accepted price and `event_at`, the open halt (id, reason, candidate fields) if any, and the newest jump reset (by `id`) as (id, confirmed price, tolerance, expiry) if, and only if, it is unconsumed and unexpired, using the §11.4 rule (C-21). Expired and consumed resets are never returned, and an older reset is never returned in place of a consumed or expired newer one. The engine loads this before any subscription.

**`clear_market_data_halt(session_id, session_secret, halt_id, instrument_id, resolution_reason, typed_candidate_price numeric)`** — see §11c.

**`list_open_market_data_halts()`** — read-only; returns each unresolved halt with instrument, reason, candidate price/size/trade/sequence and reference price. Never returns secrets.

**`apply_market_data_catalog_manifest(jsonb)`** — validates the manifest shape and every value (canonical decimals, positive increments, C-exact symbols); idempotent upsert of markets/providers/instruments/symbols and per-instrument policy rows; an instrument can be enabled only with non-null positive increments; writes one `catalog_manifest_applied` audit event via `append_audit_event` (outcome `system`, actor NULL, metadata = manifest digest; G-7). The manifest shape is fixed by G-9. Touches nothing in observation/state/halt tables.

## 11c. Halt clear and reset semantics

`clear_market_data_halt(session_id, session_secret, halt_id, instrument_id, resolution_reason, typed_candidate_price)`:

1. Runs as `platform_owner`, fixed search path.
2. Locks the instrument-state row (§11.4), then calls `require_authenticated_session(session_id, session_secret, 'market_data.halt.clear', NULL)`. Via N1 this proves an enabled global `SUPER_ADMIN`; the function does not re-read role tables (C-09).
3. The halt must exist, belong to `instrument_id`, and have no resolution.
4. `PRICE_JUMP`: reject unless `typed_candidate_price` equals the halt's `candidate_price` exactly. Every other reason: reject unless `typed_candidate_price IS NULL`.
5. `resolution_reason` non-empty (1–500 chars after trimming).
6. Inserts the immutable resolution; calls `append_audit_event('market_data_halt_cleared','success', actor, actor, NULL, session, NULL, metadata)`.
7. For `PRICE_JUMP` only: inserts a reset with the policy's tolerance and expiry (`clock_timestamp() + jump_reset_ttl_ms`).
8. Sets base state to `UNAVAILABLE_REBASELINING` (G-8). The instrument returns to `AVAILABLE` only when the next admissible observation is accepted.
9. Returns resolution ID, instrument ID and reset expiry.

An unexpired, unconsumed reset survives restart. Startup loads it through `market_data_startup_recovery`. The first valid tick must be inside the band `confirmed × (1 ± tolerance_bps/10,000)`, before expiry; it is accepted **without** the normal jump comparison, becomes `last_accepted_price`, and consumes the reset. The next tick is compared against that new reference. An out-of-band tick, or any tick after expiry, creates a new `PRICE_JUMP` halt, written atomically by the observation function itself (S-2).

### Operator clear tool (D-09 decided: interactive login)

Recommended: the operator logs in through the existing HTTPS login path, receives the short-lived opaque `selector.secret` session value, and starts the local tool. The tool prompts separately for session ID, session secret, halt ID, resolution reason, and typed candidate price. It reads the secret from `/dev/tty` with echo disabled; the secret is never in argv, an environment variable, shell history, command substitution, a pipe, standard output/error, or logs. It connects with a database login belonging only to `platform_market_data_operator`, calls the clear function with bound parameters, and prints only `cleared_halt_id`, `resolution_id`, `instrument_id`, `reset_expires_at` (RFC 3339 UTC).

Alternatives considered: (1) the tool performs the HTTPS login itself over a trusted local connection and parses the session from `Set-Cookie` (password exists briefly in tool memory); (2) the operator runs a documented `curl` login and pastes the cookie value and session ID into the tool's echo-disabled prompts (clipboard/terminal-copy exposure). The session cookie is `HttpOnly`, so a browser session cannot simply be copied from developer tools. Recommend option (1) interactive login.

## 12. Credentials, error taxonomy, and logging

The public Phase-5 feed uses no secret, key, passphrase or authentication header, so no provider-credential deferral is activated. A future authenticated provider must receive credentials from a deployment secret manager — never environment dumps, repository files, errors, fixtures or logs — and rotation requires a reconnection rollout.

```
type MarketDataErrorCode =
  | "CONFIGURATION" | "NETWORK" | "TLS" | "AUTH" | "RATE_LIMIT"
  | "PROTOCOL" | "PAYLOAD_TOO_LARGE" | "VALIDATION"
  | "PERSISTENCE" | "LOCK_LOST" | "CIRCUIT_OPEN"
  | "IDEMPOTENCY_CONFLICT";   // added, C-15: human halt, never a circuit failure
```

Safe error mapping follows `DatabaseInfrastructureError`: stable code, safe operation identifier, optional SQLSTATE only; no provider response, URL query, raw payload, stack, credentials or database message. Structured logs carry provider ID, instrument ID, safe reason code, event/ingestion timestamps, attempt number, queue depth and a correlation UUID — never price payload text, credentials, full endpoint or provider internals.

## 13. Safe error handling

- Adapter failures map to `MarketDataErrorCode`, then bounded retry/circuit action, or process exit for lock loss.
- Validation failures are durable aggregate counts, except halt/quarantine, which are individual durable events.
- Consumer errors expose only availability; no provider internals enter strategy/risk contracts.
- Raw production fixtures are redacted: price/size/volume omitted; only type, channel, trade-ID delta, timestamp precision, relationship flags, close metadata and timings remain.

## 14. Verification strategy

No PostgreSQL SQL was executed by AI #1 or by the auditor for this plan beyond the three expressions in §19. All SQL here is proposed until the named PostgreSQL 18.x integration tests run. Nothing is claimed execution-verified until its command and output are recorded.

| Behavior | Proof method | Proves / does not prove |
|---|---|---|
| DDL, privileges, view staleness, idempotency, guards | real PostgreSQL 18.x | SQL behavior and privileges; not Coinbase behavior |
| Normalization/validation | recorded redacted fixtures | deterministic parser behavior |
| Wire lifecycle/reconnect | local fake WSS server speaking the real `ws` protocol | client state machine; not Coinbase delivery |
| Production feed | read-only unauthenticated smoke | real endpoint observations; not a reliability guarantee |
| Sandbox | named sandbox smoke (`wss://ws-feed-public.sandbox.exchange.coinbase.com`) | endpoint compatibility only |
| End to end | fake WSS → adapter → validator → PostgreSQL 18.x → effective view | full internal path including staleness |

Production smoke records channel, product, trade-ID deltas, ticker-to-match relationship, heartbeat-vs-match relationship, timestamp fraction digits, time-to-ready, close code/reason/`wasClean` — never prices or sizes. If PostgreSQL 18.x is unavailable, the report must say so.

## 15. Complete test inventory and traceability

### 15.1 Mandatory tests (every name below is required)

**Contracts and parsing** — `decimalStringRejectsExponentAndNonCanonical`, `tickerContractCallsBidAskAsOfLastTrade`, `latestResultNoRowIsUnavailable`, `quoteAsOfLastTradeIsNotExecutionInput`, `rejectsDecimalNumberTokensWithJsonParseContextSource`, `rejectsUnsafeSequenceAndTradeIdNumber`, `acceptsStringIdsBeyondNumberMaxSafeInteger`, `rejectsTimestampWithoutExactlySixFractionDigits`, `maxPayloadRejectsOversizeFrame`.

**Validation** — `rejectsMissingFields`, `rejectsNonFinite`, `rejectsNonPositive`, `rejectsOffGrid`, `rejectsFutureTimestamp`, `rejectsExcessiveEventDelay`, `rejectsEventRegression`, `rejectsDuplicateTradeId`, `exactSymbolMatchesAndCaseVariantRejects`, `volume24hNullAndZeroAreAccepted`, `numeric3818Boundaries`, `eventAtMicrosecondRegression`, `doesNotTreatTickerSequenceAsContiguous`, `doesNotPrevalidateTickerAgainstMatches`, `unmappedSymbolRejected`, `disabledProviderMarketInstrumentOrMappingRejected`.

**Product/REST** — `productAssertionRejectsTradingDisabled`, `productAssertionAcceptsAbsentNullOrEmptyStatusMessage`, `productAssertionRejectsNonEmptyOrNonStringStatusMessage`, `productAssertionChecksIncrements`.

**Halts and resets** — `haltsOutOfOrderMatchTradeId`, `haltsInSessionMatchGap`, `haltsLockedOrCrossedQuote`, `quarantinesPriceJump`, `quarantineStoresCandidatePriceSizeTradeAndEvent`, `productAssertionFailureHalts`, `idempotencyConflictWritesHaltAtomicallyAndReturnsConflictResult`, `humanHaltSurvivesRestart`, `clearResolvesOnlyTargetedHalt`, `clearWritesAuditAndResolution`, `jumpResetSurvivesRestart`, `jumpResetAcceptsFirstInBandWithoutComparison`, `nextTickUsesResetTickAsReference`, `secondLargeJumpAfterClearRequarantines`, `outOfBandResetTickRehalts`, `expiredResetRehalts`, `outOfBandOrExpiredResetWritesPriceJumpHaltAtomically`, `olderUnconsumedResetNotResurrectedAfterNewerConsumed`, `clearWithRealSessionWritesResolutionAuditAndRebaselines`, `secondJumpClearAfterConsumptionSucceeds`, `restartAndOneHourOutageStillCheckRecoveredReference`.

**Heartbeat, reconnect and circuit** — `heartbeatAheadSettlesBeforeReconnect`, `heartbeatAheadFourHeartbeatsAcross2500msRebaselines`, `heartbeatBehindMatchDoesNotHalt`, `heartbeatSequenceLowerOnlyIsOutOfSequence`, `heartbeatTimeoutAt5000msForcesFailedReconnect`, `reconnectRebaselineReturnsAvailableAfterAutomaticEvent`, `disconnectCountsFailedAttempt`, `seededBackoffIsDeterministic`, `backoffAttemptOneAndJitterBounds`, `reconnectStormOpensProviderCircuit`, `halfOpenTimesOutAtTenSeconds`, `halfOpenSettlesAfterFourHeartbeatsAcross3000ms`, `partialOutageLeavesHumanHaltLatched`, `partialOutageExcludesHumanHaltedInstrumentFromHalfOpen`, `malformedThresholdReconnects`, `http429HonorsRetryAfter`, `authTlsFailureRequiresRemediation`.

**Effective state and startup** — `effectiveStateUsesWallClockInsideLongTransaction`, `effectiveStateAppliesEventAgeAndFutureSkew`, `availableStateWithNullTimestampsIsUnavailable`, `missingPolicyRowIsUnavailable`, `disabledPolicyRowIsUnavailable`, `sigkillEngineBecomesStaleAtDeadline`, `hungEngineBecomesStaleAtDeadline`, `staleIfEitherMonotonicOrDatabaseWallClockDeadlineExpires`, `policylessInstrumentIsSkipped`, `humanHaltedInstrumentIsSkipped`, `haltOnOneInstrumentDoesNotBlockOtherRestart`.

**Queue and distribution** — `queueOverflowRecordsRecovery`, `persistenceTimeoutRecordsRecovery`, `rejectFloodAggregates`, `delayedBurstAggregates`, `qualityBucketAllowsNullInstrument`, `qualityBucketFlushRetryDoesNotDoubleCount`, `qualityBucketFlushLossBound`, `notifyOccursOnlyAfterCommit`, `lostNotificationConsumerRereads`.

**Roles, grants and immutability** — `allPhase5IdsUseUuidV7`, `privilegeSnapshot`, `securityDefinerSearchPathAndOwnerAreExact`, `writerCanAppendOnlyThroughFunctions`, `writerCannotClear`, `operatorCannotAppendObservation`, `operatorCannotCallAppendAuditOrRequireSession`, `runtimeHasNoMarketDataAccess`, `runtimeKeepsPhase4GrantsUnchanged`, `consumerCanReadOnlyEffectiveView`, `ownerCatalogSelectPrivileges`, `provisionerCannotWriteObservations`, `catalogProvisioningRoleOnly`, `immutableObservations`, `immutableQualityEvents`, `immutableHalts`, `immutableResolutions`, `immutableResets`, `immutableResetConsumptions`, `immutableFlushReceipts`, `directUpdateDeleteTruncateRejectedForEveryMarketDataTable`, `bucketDirectDmlRejectedAsNonOwner`, `bucketDirectDmlRejectedAsSuperuser`, `observationIdempotencyExcludesIngestedAt`.

**Lock, network, catalog, gates** — `advisoryLockAllowsSingleWriter`, `advisoryLockLossAbortsEngine`, `catalogManifestIsIdempotent`, `persistenceRefusesBeforeTermsGate`, `wsVersionAndAuditEvidenceRecorded`, `clearToolDoesNotExposeSecret`, `dependencyCruiserRejectsStrategyCoinbaseImport`, `migrationImmutability`.

**Phase 4 / N1** — `phase4AuthorizationMatrixBeforeAfter`, `requireAuthenticatedSessionDefinitionSnapshot`, `marketDataClearRequiresSuperAdminGlobalPermission`.

**External** — `productionReadOnlySmoke`, `sandboxReadOnlySmoke`, `fakeWireToPostgresEndToEnd` (must include the stale-state leg).

### 15.2 Tests added by the auditor for this assembly (each covers a correction)

`secondResolutionForSameHaltRejected` (C-03/§11.4), `concurrentHaltOpenAndClearSerialized` (C-03), `newestResetWinsOverOlderUnconsumedReset` (G-5), `circuitParametersAgreeAcrossEnabledPolicies` (G-4), `openHaltRecordsEventAndHaltAtomically` (G-1), `onlyWriterCanOpenHalt` (G-1), `openHaltRefusedWhenHaltAlreadyOpen` (G-1/§11.4), `runtimeKeepsPhase4GrantsUnchanged` (C-06; also listed above). **All are mandatory.**

### 15.3 Retired names — each replaced by a named test with the same assertion

| Retired | Replaced by | Why |
|---|---|---|
| `caseInsensitiveSymbolLookup` | `exactSymbolMatchesAndCaseVariantRejects` | symbol rule reversed to exact |
| `heartbeatAheadTwoHeartbeatsOverTwoSecondsRebaselines` | `heartbeatAheadFourHeartbeatsAcross2500msRebaselines` | rule changed to 4/2,500 |
| `halfOpenSettlesAfterThreeHeartbeatsAcross2500ms`, `heartbeatSettlementRequiresThreeAcross2500ms` | `halfOpenSettlesAfterFourHeartbeatsAcross3000ms` | rule changed to 4/3,000 (C-10) |
| `idempotencyConflictReturns23505AndOpensCircuit`, `idempotencyConflictReturns23505AndHalts` | `idempotencyConflictWritesHaltAtomicallyAndReturnsConflictResult` | conflict halts atomically (S-1 Option B), not circuit; no SQLSTATE `23505` is raised. The test must prove the halt and event exist after the call returns, with no second transaction, and that the call raised nothing |
| `clearRequiresOperatorOnlyFunction` | `writerCannotClear`, `operatorCannotCallAppendAuditOrRequireSession`, `runtimeHasNoMarketDataAccess` | split into three |
| `jumpResetBandAndExpiry` | `jumpResetAcceptsFirstInBandWithoutComparison`, `outOfBandResetTickRehalts`, `expiredResetRehalts` | split |
| `clearWithResetAcceptsFirstValidTickerAsNewReference` | `jumpResetAcceptsFirstInBandWithoutComparison`, `nextTickUsesResetTickAsReference` | same assertion |
| `reconnectStormOpensCircuit` | `reconnectStormOpensProviderCircuit` | rename |
| `authAndTlsFailureOpenThirtyMinuteCircuit` | `authTlsFailureRequiresRemediation` | rename; 30-minute circuit asserted inside |
| `queueCapacity1024FailsClosed`, `storedFunctionTimeoutAt1000msFailsClosed` | `queueOverflowRecordsRecovery`, `persistenceTimeoutRecordsRecovery` | rename; 1,024 / 1,000 ms asserted inside |
| `rejectFloodAggregatesInMemory`, `threeSecondDelayedBurstCreatesOneBucketFlush`, `bucketFlushRetryWithSameFlushIdDoesNotDoubleCount` | `rejectFloodAggregates`, `delayedBurstAggregates`, `qualityBucketFlushRetryDoesNotDoubleCount` | rename |
| `databaseClockMakesSigkillStateUnavailableWithin10001ms`, `hungEngineWithAliveLockBecomesStaleWithin10001ms` | `sigkillEngineBecomesStaleAtDeadline`, `hungEngineBecomesStaleAtDeadline` | rename; assertion = AVAILABLE at 10,000 ms, `UNAVAILABLE_STALE` at 10,001 ms |
| `notifyLossStillRereadsView` | `lostNotificationConsumerRereads` | rename |
| `statusMessageAllowsAbsentNullOrEmptyString`, `statusMessageNonStringFails` | `productAssertionAcceptsAbsentNullOrEmptyStatusMessage`, `productAssertionRejectsNonEmptyOrNonStringStatusMessage` | rename |
| `timestampMicrosecondCheckBoundary000001`, `timestampMicrosecondCheckBoundary999999`, `timestampMicrosecondCheckWholeSecond`, `timestampMicrosecondCheckMaximumEpoch` | `eventAtMicrosecondRegression` | subsumed; must cover 0, 1, 999999, 1000000, a 2026 value, 2^53+1, max−1, max |
| `advisoryLockPreventsSecondEngine`, `advisoryLockLossAbortsProcess` | `advisoryLockAllowsSingleWriter`, `advisoryLockLossAbortsEngine` | rename |
| `runtimeCannotReadOrAppendMarketData`, `writerCannotClearHalt`, `privilegeSnapshotMatchesExpectedList`, `bucketDirectMutationRejected` | `runtimeHasNoMarketDataAccess`, `writerCannotClear`, `privilegeSnapshot`, `bucketDirectDmlRejectedAsNonOwner`/`…AsSuperuser` | rename |
| `maxPayload65536ClosesConnection` | `maxPayloadRejectsOversizeFrame` | rename |
| `coinbaseProductionPublicTickerSmoke`, `coinbaseSandboxSmoke`, `fakeWireToPostgresLatestAndStalenessE2E` | `productionReadOnlySmoke`, `sandboxReadOnlySmoke`, `fakeWireToPostgresEndToEnd` | rename |

### 15.4 Traceability

| Requirement | Tests | Method |
|---|---|---|
| Every §8 reject/halt row | Validation, Halts, Heartbeat groups | unit + real PostgreSQL |
| Every circuit transition and timeout | Heartbeat/circuit group | fake clock, fake wire, PostgreSQL state assertions |
| Stale safety, long transactions, NULL fail-closed | Effective-state group | real transaction, sleep, view query |
| Queue, flush, no double count | Queue group | repeated flush IDs |
| One writer | advisory-lock tests | two independent connections |
| Immutability | immutability tests | non-owner and superuser DML/TRUNCATE |
| Roles, grants, Phase 4 untouched | roles group, Phase 4/N1 | `has_*_privilege`, attempted calls, ACL snapshot |
| Approved decisions 1–9 | see below | as named |

| Decision | Tests |
|---|---|
| 1 | `reconnectStormOpensProviderCircuit`, `partialOutageLeavesHumanHaltLatched`, `haltOnOneInstrumentDoesNotBlockOtherRestart`, `reconnectRebaselineReturnsAvailableAfterAutomaticEvent` |
| 2 | `quoteAsOfLastTradeIsNotExecutionInput`, `tickerContractCallsBidAskAsOfLastTrade` |
| 3 | `notifyOccursOnlyAfterCommit`, `lostNotificationConsumerRereads` |
| 4 | `writerCanAppendOnlyThroughFunctions`, `runtimeHasNoMarketDataAccess` |
| 5 | `provisionerCannotWriteObservations`, `catalogManifestIsIdempotent`, `catalogProvisioningRoleOnly` |
| 6 | `ownerCatalogSelectPrivileges`, `privilegeSnapshot`, `securityDefinerSearchPathAndOwnerAreExact` |
| 7 | `heartbeatTimeoutAt5000msForcesFailedReconnect` |
| 8 | `persistenceRefusesBeforeTermsGate` |
| 9 | `wsVersionAndAuditEvidenceRecorded`, `maxPayloadRejectsOversizeFrame` |

## 16. Gates and active subscription scope

Mandatory green gates: typecheck, unit, architecture, migration immutability; real PostgreSQL 18.x migrations/integration; existing HTTP black-box and the full Phase 4 authorization matrix; fake-provider end to end; privilege snapshot (including the Phase 1–4 ACL snapshot); production read-only smoke; terms-clearance artifact before persistence activation.

Persistence requires written Coinbase terms clearance, an enabled policy, an enabled catalog mapping, non-null increments, a successful product assertion, and the acquired advisory lock.

Startup is **per instrument**:

- No policy → skipped, `UNAVAILABLE_NO_POLICY`.
- Unresolved human halt → skipped, `UNAVAILABLE_HUMAN_HALT`; it does not block another instrument.
- Disabled policy or disabled catalog scope → skipped, `UNAVAILABLE_DISABLED_SCOPE`.
- Other active instruments start normally.
- Unexpired jump resets are loaded and honored until expiry.

The active subscription set is exactly the enabled `market_data_policies` joined to enabled provider/market/instrument/mapping rows, limited to the selected active configuration; the initial manifest enables BTC-USD and ETH-USD only after approval.

## 17. Top risks

1. Coinbase terms prohibit the intended persistence: do not activate persistence without written clearance.
2. Trade-ID continuity is undocumented: monitored assumption; production smoke; automatic rebaseline only across disconnects.
3. Genuine volatility creates human halts: conservative threshold plus operator review.
4. Hot-row churn on `market_data_instrument_state`, and unbounded growth (≈99 GB/year, indefinite retention, no partitioning): monitor bloat and size; benchmark before adding instruments.
5. `ws` advisories: no activation before the actual `npm audit` evidence.
6. Operator-session exposure: depends on decision D-09 and the tool's secret handling.
7. A superuser (or any owner-equivalent actor) can `SET ROLE platform_owner` and pass the bucket guard; the guard defends against every other role, not against owner-level privilege.
8. A server-side closure of the WebSocket without a known cause (observed twice by the auditor) may recur; mitigated by reconnect, circuit and rebaseline, not eliminated.
9. The halt write path (`open_market_data_halt`, G-1) is new and unaudited; until its body passes the Sprint 5.1 audit the engine cannot fail closed on its own detections.

## 18. Pending user confirmation

**All items in this section were approved on 2026-10-11 at the recommended value, except the three external gates (terms clearance, deployment-host heartbeat check, `npm audit` evidence), which remain open.** Defaults below are unchanged from FC/MAN except item 12 (C-10, shown first with the superseded value).

### Tier B — safety parameters

| # | Item | Options | Recommend | Cost of the recommendation |
|---|---|---|---|---|
| 1 | Ingestion age | 5,000 / 10,000 / 30,000 ms | 10,000 | up to 10 s of apparent availability after a hard crash |
| 2 | Event age | 5,000 / 10,000 / 30,000 ms | 10,000 | lower values reject delayed valid data |
| 3 | Future skew | 1,000 / 2,000 / 5,000 ms | 2,000 | lower values reject provider-clock variance |
| 4 | Max initial event delay | 2,000 / 5,000 / 10,000 ms | 5,000 | higher values admit older data (AUD p99 lag ≈2,967 ms) |
| 5 | Price-jump threshold | 1,000 / 2,000 / 5,000 bp | 2,000 | lower values raise human reviews during real volatility; sample had no volatility spike |
| 6 | Reset tolerance | 50 / 100 / 250 bp | 100 | wider band admits more unreviewed movement |
| 7 | Reset expiry | 60,000 / 300,000 / 900,000 ms | 300,000 | longer expiry preserves a stale approval |
| 8 | Circuit threshold/window | 3/60 s, 5/60 s, 10/60 s | 5/60 s | lower values false-open |
| 9 | Circuit cool-down | 10 / 30 / 60 s | 30 s | longer delays recovery |
| 10 | Half-open ready deadline | 5 / 10 / 30 s | 10 s | shorter values false-fail startup |
| 11 | Heartbeat-ahead rule | 3/2,500 or 4/2,500 | 4/2,500 | lower count risks false reconnect |
| 12 | Circuit-close settling | 3/2,500 (FC) or **4/3,000 (MAN)** | **4/3,000** | adds ≈0.5–1 s to recovery; 3/2,500 is practically the same rule at 1 Hz (C-10) |
| 13 | Advisory-lock probe | 500 / 1,000 / 2,000 ms | 1,000 | lower adds DB traffic |
| 14 | `ws` `maxPayload` | 32 / 64 / 256 KiB | 64 KiB | larger raises memory-exhaustion exposure |
| 15 | Retention | indefinite/no partitions, or fixed retention | indefinite, no partitions | ≈99 GB/year at planning rate before WAL/indexes |

### Tier C — operational choices

- Catalog manifest is versioned provisioning input, not a migration seed — recommend.
- Initial active scope BTC-USD and ETH-USD only — recommend.
- No REST missed-trade replay (the ticker is a full latest snapshot; replay semantics unverified) — recommend.
- Public unauthenticated feed only — recommend.
- **Operator session flow:** interactive login — APPROVED.
- Written Coinbase terms clearance before persistence — approve only after clearance (only the user can obtain it).
- Deployment-host confirmation of the 5,000 ms heartbeat timeout.

### New decisions

- **N1** — modify `require_authenticated_session` as in §11a (auditor-verified single-line change). Recommend approval with the stated safeguards.
- **N2** — store quarantined normalized price/size and apply clear-resets-reference semantics. Operator sees candidate and reference values, IDs, timestamps and reason, must give a non-empty reason, and must type the candidate price. No second approver in Phase 5 (safer but needs an operational workflow that does not exist).
- **N3** — introduce `platform_market_data_consumer` for a future orchestrator; SELECT on the effective view only, never raw observations or mutation functions.
- **G-1 … G-8** — Part 0.3, adopted as recommended.

If all are confirmed, Phase 5 will have ten-second database-effective freshness, five-second heartbeat timeout, automatic reconnect rebaseline, durable research-only ticker observations, and immutable global-super-admin halt resolution.

## 19. What could not be verified

- **Executed on PostgreSQL 18.6** (`18.6-1.pgdg24.04+2`, run by the user 2026-10-08 from `phase5-sql-checks.sql`; temp objects only): `current_timestamp` stayed frozen while `clock_timestamp()` advanced ≈2.02 s in one transaction; a NULL in a primary-key column was rejected; the revision-4 event-time expression double-counted microseconds; the revision-5 `div`/`mod` expression round-tripped nine samples through the year-9999 maximum. These are regression targets from one build, not proofs for every build.
- **Compared by the auditor, not executed:** N1 against the real Phase 4 migration text (§0.1).
- **Not executed by anyone for this plan:** every other SQL statement here (DDL, view, grants, triggers, indexes, function bodies — none yet exist), PostgreSQL role/ownership behavior, `npm audit`, sandbox or production smoke tests, deployment-host heartbeat measurements.
- Coinbase documentation: the heartbeat and rate-limit statements come from AI #1's reports in 5.1/FC that the pages were retrievable; revision 5 said they were not. The auditor has not re-fetched them. Reconnect/resume, trade-ID contiguity, and unauthenticated `level2_batch` remain undocumented.
- Coinbase written terms clearance does not exist.
- `ws@8.22.0`: outside the two advisory ranges quoted; not an exhaustive scan.
- Auditor feed observations are small Kampala samples from 2026-10-02 (and 2026-10-07 for `status_message`); they are not provider guarantees.

## Proposed sprint breakdown

- **Sprint 5.0 — approval and legal gate:** written Coinbase terms clearance; Tier-B/C confirmations; N1/N2/N3 and G-1…G-8 (all decided 2026-10-11); remaining: terms clearance; recorded `npm audit` for `ws@8.22.0`. Exit: legal clearance and advisory evidence recorded (approvals already recorded 2026-10-11).
- **Sprint 5.1 — contracts, catalog, security, function bodies:** canonical contracts; migration (tables, indexes, guards, roles, grants, N1); **all function bodies written and audited against real PostgreSQL 18.x**; catalog manifest/provisioner; privilege and Phase 1–4 ACL snapshots; Phase 4 regression. Exit: PostgreSQL-18, typecheck, architecture and Phase 4 gates green.
- **Sprint 5.2 — adapter and validation:** WSS/REST adapter, parser, validation, circuit and queue, fake-wire suite. Exit: validation, circuit and fake-wire gates green.
- **Sprint 5.3 — persistence and effective state:** observations, quality records, resolution workflow, effective view, advisory lock, notifications. Exit: PostgreSQL-18 end to end, SIGKILL and hung-engine tests, privilege gates green.
- **Sprint 5.4 — controlled external verification:** sandbox and production read-only smoke; deployment-host heartbeat reconfirmation. Exit: smoke evidence recorded; all required gates green.

## Changes from the previous plan

Beyond the corrections C-01…C-20 in Part 0: automatic recovery events no longer become unresolved human halts; quarantine preserves normalized candidate facts and a clear can reset the jump reference once, through a durable, bounded, restart-surviving reset; event-time equality uses integer `div`/`mod`; N1 is explicit with an exact permitted diff; invented migration roles removed; no-row and stale-after-crash semantics explicit; exact C-collated symbols; UUIDv7 IDs; nullable non-negative volume; arbitrary-precision decimal grid arithmetic; complete policy defaults; one state table; immutable event history plus insert-only halt/reset projections; receipt-based bucket idempotency; provider-level circuit; corrected heartbeat rules; dedicated roles with a consumer read path; indefinite unpartitioned retention (approved).

## What remains uncertain

Coinbase written terms clearance (open gate); deployment-host timing; real external provider behavior and smoke results; the actual `npm audit` output; and every SQL body, which does not yet exist and must be audited against real PostgreSQL 18.x.
