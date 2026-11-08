# Market-data observation run (Sprint 5.4): procedure

Status: DRAFT for the user's approval. Nothing in this document connects anywhere by itself. Do not run it before the Sprint 5.4 plan is approved and the independent builder review of Sprint 5.3 and 5.4 is done.

## Terms position (unchanged)

RA-1 is a risk acceptance, not clearance. The gate stays open and no Coinbase reply is recorded. Hard limits stay in force during the run: one user only, no redistribution, no indexes, benchmarks, fair-value or valuations, no AI or ML use of the data.

## Environment for the real run (development mode only)

The engine has no default endpoints and refuses `live`. Every value below is set by the operator, not by code.

| Variable | Value |
|---|---|
| `PLATFORM_RUNTIME_MODE` | `development` |
| `MARKET_DATA_WS_ENDPOINT` | `wss://ws-feed.exchange.coinbase.com` |
| `MARKET_DATA_REST_BASE_URL` | `https://api.exchange.coinbase.com` |
| `MARKET_DATA_ALLOWED_HOSTS` | `ws-feed.exchange.coinbase.com,api.exchange.coinbase.com` |
| `MARKET_DATA_INSTRUMENTS` | `btcusd=BTC-USD` |
| `MARKET_DATA_PROVIDER_ID` | the `id` of the enabled `providers` row that owns the `BTC-USD` mapping (lowercase UUID; the owner reads it with `select id from platform.providers where provider_code = '<code>'`) |
| `MARKET_DATA_TERMS_ACKNOWLEDGEMENT` | `RA1_RISK_ACCEPTED` |
| `DATABASE_URL` | the `platform_market_data` login |

Before the run, the owner confirms that the provider whose `id` is used is the intended one: `select provider_code, enabled from platform.providers where id = '<MARKET_DATA_PROVIDER_ID>'`. The engine knows only the id, so this check is a human step until the provider ownership checks are built.

Sandbox and the authenticated Direct feed are not approved.

## Host conditions

- The work machine is the deployment host. It must not sleep, hibernate or lose power for the whole window. Disable sleep and lid-close suspend first, and keep it on mains power.
- One engine only. A second engine exits with code 3 (lock held).

## Window and criteria (proposed; the user decides)

- Window: 24 hours, one instrument.
- Success: the engine stays up for the window or stops only on the user's decision; heartbeat gaps stay under 5,000 ms, or every longer gap is explained by a logged reconnect; every halt has a reason code the engine documents; the view is available except during logged halts and reconnects; a controlled stop makes the state stale at the configured deadline.
- Abort at once on any of: a terms-gate failure, a host outside the allow-list, an unexplained halt loop (more than three halts in ten minutes), exit code 1 or 70, or the user's decision.

## Data-handling rules

- Real Coinbase market data is not committed to git (the repository is on GitHub, a third party).
- It is not pasted into AI assistant sessions and not copied off the host.
- Evidence for the ledger is counts, timings and reason codes only. No prices, no trade identifiers, no order-book content.
- Engine logs may stay on the host. Before anything leaves the host, check it by eye for prices.

## Evidence to record after the run

Window start and end, connection count and reconnects, longest heartbeat gap, number of halts with reason codes, view availability over time, the stale deadline on the controlled stop, and whether the 5,000 ms heartbeat timeout held. The user decides any change to that value.
