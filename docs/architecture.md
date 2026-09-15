# Phase 1 architecture

## Scope

This is a structural foundation, not a trading system. Sprint 2.2 adds only the server-side PostgreSQL pool, Kysely client, health check, and transaction boundary inside `packages/database`. There are no HTTP routes, migrations, schemas, React components, workers, market-data connections, strategies, order dispatch paths, paper fills, or live broker integrations.

## Modules and ownership

| Module | Owns | Must not own |
| --- | --- | --- |
| `shared` | branded identifiers, decimal-boundary type, common primitives | business rules or infrastructure |
| `core` | runtime modes, bot lifecycle, audit-event contract | provider integration or financial state |
| `database` | PostgreSQL configuration, Kysely typing, future persistence implementations | domain decisions or schema assumptions |
| `market-data` | normalized market-data/provider contracts | provider-specific behavior |
| `strategies` | signal-only strategy contract | risk, order, or execution capability |
| `risk` | approval/rejection contract | strategy or execution adapter |
| `trading` | signals, order intents, active-instrument policy | broker protocol or fills |
| `portfolio` | position-read contract | ledger implementation |
| `execution` | provider-neutral execution contract | a concrete adapter, credentials, or live dispatch |
| `apps/api` | future external API/authentication boundary | financial authority in the browser |
| `apps/worker` | future controlled background work boundary | unbounded worker creation |
| `apps/web` | future operator user interface | authorization, risk, or execution decisions |

## Required flow

```text
validated market data → activation policy → strategy → signal → risk decision
→ order intent → execution adapter → external provider → fill/event → portfolio → reconciliation
```

Only the future trading orchestration service may cross each boundary in sequence. A `Strategy` returns signals and receives no execution dependency. An `OrderIntent` is not a provider submission. A rejected or unknown external outcome must never be reclassified as a confirmed failure without reconciliation.

## Runtime modes

`development`, `test`, `paper`, and `live` are the only recognized modes. The server-side `RuntimeConfiguration` defaults to `development`. It exposes `liveExecutionPermitted: false` in every mode during Phase 1; requesting `live` cannot enable execution. This is intentional fail-closed behavior, not a live-trading implementation.

Later live activation must be server-side, auditable, environment-separated, explicitly approved, and independently checked by the execution boundary. Client state is never authority for mode, permissions, balances, risk limits, or order state.

## Dependency rule

Dependencies point from apps to domain packages and from domain packages to `shared`. Provider/database implementations are adapters behind interfaces. `database` may import `core` and `shared` contracts, but no domain package may import `database`. Domain types use `DecimalString`, never JavaScript `number`, for financial values. Decimal scale, validation, arithmetic, and rounding are deferred until instrument rules and ledger requirements are approved.

`.dependency-cruiser.cjs` enforces this against resolved TypeScript imports in `apps/` and `packages/`; `npm run check:architecture` is part of `npm test`. It rejects cycles, domain-to-app dependencies, app-to-app dependencies, and imports outside each package's allowed dependencies. In particular, strategies may use only `shared`, `market-data`, and `trading`; execution may use only `trading`; and the web application may not import execution. A strategy contract exposes only `evaluate()` and returns signals—there is no strategy order-submission capability.

## Concurrency and state integrity (future implementation constraints)

Financial state changes require explicit PostgreSQL transactions, idempotency keys with unique constraints, audited transitions, and locking/versioning appropriate to the entity. Unknown external order state requires reconciliation; internal records must not be blindly overwritten.
