# Architectural policies recorded in Phase 1

## Clock and timestamp policy

System timestamps use UTC as the canonical representation unless a specific market or provider requirement, documented at the time of integration, requires additional representation. External market-event time and local ingestion/processing time are conceptually distinct. Provider timestamps must not automatically be treated as local receipt time or as equivalent to each other. Future market-data and reconciliation records must preserve sufficient event-time and ingestion-time information to distinguish source chronology from system processing chronology.

## Order and client-ID policy

The future order architecture must keep these identifiers distinct and owned by their respective boundaries:

- Internal order ID: assigned by the platform and authoritative for internal state.
- Client-generated order ID/idempotency identifier: supplied or generated at the request boundary to prevent duplicate internal submissions and support safe retries.
- External broker/exchange order ID: assigned by the selected provider; no provider-specific format is assumed.
- Execution/fill ID: assigned by the provider or paper-execution implementation and used for fill deduplication and tracing.

The later order/reconciliation design must map these identifiers without conflating them, supporting duplicate prevention, retries, webhook deduplication, reconciliation, and traceability from an internal order to its external order and fills.

## Future error taxonomy

Future APIs, workers, and provider adapters must distinguish validation failure, authorization failure, risk rejection, business-rule rejection, provider rejection, network failure, timeout, unknown external state, duplicate/idempotency conflict, and internal system failure. A network failure or timeout is not evidence that an order failed externally: its external state can be unknown and must remain distinguishable until reconciliation resolves it. The detailed error representation, codes, and transport mapping remain open.

# Open decisions and decision timing

These choices remain unresolved. The listed deadlines prevent a later phase from silently selecting financial or operational behavior.

## Must be decided before Phase 2 implementation

1. Authentication/session model, authorization role/permission matrix, tenancy model, and audit-retention requirements.
2. Instrument catalog source, symbol mapping, price/quantity precision, tick/lot constraints, market hours, and corporate-action handling.
3. Financial representation policy: PostgreSQL `NUMERIC` scale, rounding mode, currency conversion, and immutable ledger design.
4. Behavior for open orders and positions when an instrument, market, strategy, or bot is disabled.
5. Live activation governance: approval workflow, key management, environment separation, kill-switch ownership, and reconciliation recovery authority.

## Can remain open until the affected later phase

1. Migration execution and recovery process; PostgreSQL 18 with Kysely and node-postgres is the approved query-layer direction.
2. Initial market-data and broker/exchange providers, based on official provider documentation.
3. Risk policies, leverage/margin semantics, fee schedules, stop-loss policy, and position-sizing formula.
4. Paper-execution assumptions for spread, slippage, partial fills, latency, and fees.
5. Worker queue/scheduler and controlled concurrency limits.
6. Observability, monitoring, and alerting stack.
