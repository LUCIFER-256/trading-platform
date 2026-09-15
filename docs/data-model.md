# Provisional data-model boundary

No database schema, migration, field list, or ORM is implemented in Phase 1. The following records establish future ownership only.

| Area | Candidate records | Phase-2+ constraints to decide |
| --- | --- | --- |
| Identity | users, accounts, roles | tenancy, account ownership, retention |
| Catalog/configuration | markets, instruments, broker connections, strategies, strategy configurations, bot configurations, risk configurations | provider identifiers, activation scope, versioning |
| Financial state | orders, executions, positions, transactions, fees | immutable ledger design, state machine, currency conversion, precision |
| Operations | watchlists, alerts, audit logs, reconciliation discrepancies | retention, access control, append-only enforcement |

All future records need primary/foreign keys, UTC timestamps, status/version fields where applicable, indexes based on query paths, and declared transaction boundaries. Financial records must use PostgreSQL `NUMERIC` (or a separately approved integer-unit model) with exact instrument/currency scale; browser-provided balances and P&L are never authoritative.
