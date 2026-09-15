# Database foundation

## Approved runtime and dependency baseline

- Node.js: `22.23.2` (repository-pinned Node 22 LTS runtime)
- Kysely: `0.29.5`
- node-postgres: `pg@8.23.0`
- Database target: PostgreSQL 18.x only

Sprint 2.2 owns the PostgreSQL connection boundary. It creates no business schema, migration, repository, or business query.

## Sprint 2.2 connection infrastructure

The platform targets PostgreSQL 18.x with Kysely and node-postgres (`pg`). `packages/database` is the exclusive owner of the node-postgres pool and a Kysely instance backed by its PostgreSQL dialect. `createDatabaseClient` is an explicit factory, not a global singleton: the server application composition root creates one client, reuses it, and calls `close()` during graceful shutdown. `close()` destroys Kysely and ends the owned pool.

`checkHealth()` executes a fixed `SELECT 1` through Kysely and only reports a non-secret infrastructure error. It is not an HTTP endpoint, monitoring system, or readiness policy.

### Public error boundary

`DatabaseInfrastructureError` is the only error type this package throws for infrastructure failures. Its public surface is deliberately limited to a category (`code`), a fixed safe message, safe operation context (`pool`, `health-check`, `transaction`, `shutdown`, or `tls`), and an optional syntactically valid PostgreSQL SQLSTATE. It never has a `cause` and does not retain raw driver errors. In particular, driver messages, connection strings, credentials, host names, and arbitrary error properties are discarded before the error crosses the package boundary. PostgreSQL errors are not presumed safe.

Phase 2.2 has no internal diagnostic consumer that requires raw driver errors, so it retains none. A future diagnostics design must keep any raw provider error in an explicitly internal, access-controlled boundary; it must not add it to a thrown error, serialized payload, public getter, return value, or HTTP-facing object.

node-postgres idle-client errors are handled by the owned pool's explicit error listener. The client records the first such failure as a non-secret `POOL_RESOURCE_FAILURE`, changes `getStatus()` from `ready` to `degraded`, and rejects later health checks or new transactions with that recorded failure. Its public `sqlState` retains only a syntactically valid PostgreSQL SQLSTATE, never the driver's arbitrary error text. It does not throw from the event listener, retry connections, or retroactively attribute the background event to an in-flight operation.

This is intentional fail-closed behavior: an idle-client failure means this infrastructure layer can no longer attest to the pool's health, so it blocks new database work rather than silently continuing. `close()` remains available while degraded and changes the status to `closed`. Current recovery is deliberate client recreation by the application composition root, normally as part of a controlled process restart; this layer performs no automatic reconnect or supervisor behavior.

**Sprint 2.2 decision:** degradation is one-way. A `DatabaseClient` must not return from `degraded` to `ready`; only an application composition root may create a replacement client after a controlled restart or equivalent explicit recovery procedure. This is intentional fail-closed design, not an omitted pool-recovery feature. Automatic in-package recovery is deferred because it would require approved ownership for retries, readiness, lifecycle coordination, and audit/alert behavior.

`withinTransaction(callback)` uses Kysely's PostgreSQL transaction mechanism, which checks out one pool client for `BEGIN`, the callback's transaction-scoped Kysely context, `COMMIT` or `ROLLBACK`, and release. Callback errors are rethrown unchanged; driver lifecycle failures are normalized as non-secret transaction errors without retaining the original driver error. The callback receives the transaction-scoped client context so future persistence code does not need to use an ambient pool inside a transaction.

When both a callback and the subsequent `ROLLBACK` fail, Kysely 0.29.5 propagates the rollback failure rather than the original callback failure. This boundary therefore returns a safe `TRANSACTION_FAILURE` classified from the rollback failure's valid SQLSTATE; the original callback error is not recoverable from the public error. This behavior is covered by a focused unit test and is accepted for Sprint 2.2 because the database state is uncertain and the rollback failure is the actionable infrastructure condition.

`packages/database` owns PostgreSQL-specific configuration, driver details, Kysely typing, and future persistence implementations. Domain packages remain database-neutral and must not import it.

## Environment configuration

`DATABASE_URL` is required outside `test` mode. `TEST_DATABASE_URL` is required in `test` mode and is never replaced with `DATABASE_URL`. This separation prevents accidental test targeting of the application database.

`DATABASE_SSL_MODE` must be explicit: `disable`, `require`, `verify-ca`, or `verify-full`. Verification modes require `DATABASE_SSL_CA_PATH`; disabled SSL rejects a CA path. The following settings are applied by the pool or transaction infrastructure:

- `DATABASE_POOL_MAX`
- `DATABASE_CONNECTION_TIMEOUT_MS`
- `DATABASE_IDLE_TIMEOUT_MS`
- `DATABASE_STATEMENT_TIMEOUT_MS`
- `DATABASE_LOCK_TIMEOUT_MS`
- `DATABASE_TRANSACTION_TIMEOUT_MS`
- `DATABASE_APPLICATION_NAME`

The configuration API validates URL shape but intentionally discards the raw URL from its public result. The factory reads the selected URL only while creating the private driver pool. It performs no credential logging and exposes no credential accessor. `disable` maps to explicit disabled TLS; `require` maps to TLS with certificate verification; `verify-ca` and `verify-full` load the configured CA and verify certificates.

## Test isolation

Unit tests use fake pool clients and do not connect to PostgreSQL. A real integration check, when one is configured, must use `TEST_DATABASE_URL` and test runtime mode only. It must never fall back to `DATABASE_URL`; absence of `TEST_DATABASE_URL` means the integration check is not run and must be reported as such.

## Identity and time

Ordinary persistent entity IDs will use database-generated PostgreSQL UUIDv7 once tables exist. Client/request IDs, idempotency IDs, provider IDs, and execution/fill IDs remain distinct concepts and are not implemented in this sprint.

Persisted instants will use PostgreSQL `timestamptz` with UTC semantics. Future tables will distinguish `created_at`, `updated_at`, provider `event_at`, system `ingested_at`, and `processed_at`; no timestamp column exists yet.

## Not implemented

No migration, schema, table, repository, catalog, user/account, audit persistence, broker integration, or trading behavior exists in Sprint 2.2.
