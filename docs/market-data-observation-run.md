# Market-data observation run (Sprint 5.4): procedure

Status: DRAFT for the user's approval. Nothing in this document connects anywhere by itself. Do not start the run until the user has approved this runbook in writing in the ledger.

## Terms position (unchanged)

RA-1 is a risk acceptance, not clearance. The gate stays open and no Coinbase reply is recorded.
Hard limits stay in force during the run: one user only, no redistribution, no indexes, benchmarks, fair-value or valuations, no AI or ML use of the data.

## Decisions recorded

The user chose Option B and manual restart on 2026-11-08. The ledger records the choice. The options stay listed below for reference.

1. Power. Chosen: Option B.
   - Option A: continuous 24 hours. Needs a UPS that powers the PC, the router and the modem. The laptop battery is dead, so any mains cut stops everything.
   - Option B (chosen): accumulated 24 hours. Every power cut is logged, the engine is restarted by hand, and the window counts total engine uptime. Each restart starts a new log file.
2. Restart. Chosen: by hand. A service file would be new code and is not part of this runbook.

## Environment for the real run (development mode only)

The engine has no default endpoints and refuses `live` mode. The operator sets every value. Keep them in a file outside the repository, readable only by you (`chmod 600`). Never commit it.

| Variable | Value |
|---|---|
| `PLATFORM_RUNTIME_MODE` | `development` |
| `MARKET_DATA_WS_ENDPOINT` | `wss://ws-feed.exchange.coinbase.com` |
| `MARKET_DATA_REST_BASE_URL` | `https://api.exchange.coinbase.com` |
| `MARKET_DATA_ALLOWED_HOSTS` | `ws-feed.exchange.coinbase.com,api.exchange.coinbase.com` |
| `MARKET_DATA_INSTRUMENTS` | `btcusd=BTC-USD` |
| `MARKET_DATA_PROVIDER_ID` | the `id` of the enabled provider that owns the `BTC-USD` mapping, as a lowercase UUID |
| `MARKET_DATA_TERMS_ACKNOWLEDGEMENT` | `RA1_RISK_ACCEPTED` |
| `DATABASE_URL` | the `platform_market_data` login |
| `DATABASE_SSL_MODE` | `disable` for a local PostgreSQL without TLS |

Before the run, the owner confirms the provider behind the id, because the engine knows only the id:
`select provider_code, enabled from platform.providers where id = '<MARKET_DATA_PROVIDER_ID>'`.
Sandbox and the authenticated Direct feed are not approved.

## Host checklist (Ubuntu)

Check each item before starting. Stop and tell the auditor if one fails.

1. The laptop is on mains power. Automatic suspend is off in the power settings.
2. `timedatectl` shows "System clock synchronized: yes".
3. `systemctl is-enabled postgresql` prints `enabled`, and the database is running.
4. `df -h` shows at least 10 GB free on the disk that holds the database and your home folder.
5. Automatic updates are paused for the window: `sudo systemctl stop unattended-upgrades`. Start it again afterwards. Do not reboot or install updates during the run.
6. You stay logged in to your desktop session for the whole run.
7. Only one engine runs. A second engine exits with code 3.
8. In the BIOS, "restore on AC power loss" is set to power on.
9. Outbound HTTPS to the two hosts works. If the network inspects TLS, the engine refuses the unknown certificate and stops with a failure. That is a safe failure, not a fault.

## Start command

The engine writes its log to standard error, one JSON object per line, with no prices. Standard error must go into the file, so `2>&1` is required.

```
mkdir -p ~/market-data-run
tmux new -s mdrun
cd ~/trading-platform
npm run build
set -a
. ~/market-data-run/engine.env
set +a
date -u +%Y-%m-%dT%H:%M:%SZ
systemd-inhibit --what=sleep:idle:handle-lid-switch --why="market data run" node dist/apps/market-data/src/main.js 2>&1 | tee -a ~/market-data-run/engine-$(date +%Y%m%dT%H%M%S).log
echo ${PIPESTATUS[0]}
```

Write down the UTC time the `date -u` line printed. This is `RUN_START` for the queries below. Detach from tmux with Ctrl-b then d, and reattach with `tmux attach -t mdrun`.
Stop the engine with Ctrl-c in tmux. The engine stops cleanly and exits 0. The line after the command prints the engine's exit code: 0 is a clean stop, 1 a failure, 3 another engine holds the lock, 70 the lock was lost.

## Watching the run

Use your own owner or admin database login for the `psql` commands. Replace the placeholders. Every query below returns counts, times or reason codes only. Never add a price, size or trade-id column to a query.

```
tail -n 20 ~/market-data-run/engine-*.log
grep -h '"event":"session"' ~/market-data-run/engine-*.log | grep -o '"reason":"[A-Z_]*"' | sort | uniq -c
psql "$OWNER_DATABASE_URL" -c "select availability, evaluated_at from platform.market_data_effective_state"
psql "$OWNER_DATABASE_URL" -c "select count(*), min(received_at), max(received_at) from platform.market_data_observations where received_at >= '<RUN_START>'"
psql "$OWNER_DATABASE_URL" -c "select decision, reason_code, count(*) from platform.market_data_quality_events where ingested_at >= '<RUN_START>' group by 1, 2 order by 3 desc"
psql "$OWNER_DATABASE_URL" -c "select h.reason_code, h.id from platform.market_data_halts h left join platform.market_data_halt_resolutions r on r.halt_id = h.id where r.id is null"
df -h
```

Check the first hour every 10 minutes, then about every two hours. A line with `"event":"fatal"` or `"event":"abort"` means the engine has stopped.
About 70 seconds after start, a line with `"event":"heartbeat"` must appear. If none appears, stop the run and tell the auditor: the heartbeat logging is not working.

## What the engine records about heartbeats

The engine logs a `session` line for reconnects, failed attempts, queue and persistence recoveries and remediation. The reason is `HEARTBEAT_TIMEOUT`, `HEARTBEAT_GAP`, `QUEUE_OVERFLOW`, `PERSISTENCE_TIMEOUT`, `NETWORK`, `PERSISTENCE`, `CONFIGURATION` or `REMEDIATION_REQUIRED`.
It also logs a `heartbeat` line about every 60 seconds for each instrument. The line holds `instrumentId`, `intervals` (how many heartbeat gaps the window measured), `maxIntervalMs` (the longest gap in the window), `windowMs` (the real window length) and `correlationId`. It holds no price, size or trade id. The window restarts after every reconnect, so a gap that ends in a reconnect shows up as a `HEARTBEAT_TIMEOUT` line, not in a `heartbeat` line. The timeout is 5,000 ms, so no gap above 5,000 ms can appear in a `heartbeat` line.

```
grep -h '"event":"heartbeat"' ~/market-data-run/engine-*.log | wc -l
grep -h '"event":"heartbeat"' ~/market-data-run/engine-*.log | grep -o '"maxIntervalMs":[0-9]*' | cut -d: -f2 | sort -n | tail -5
```

The first command counts the summaries (about 60 per hour). The second prints the five longest heartbeat gaps of the run in milliseconds. A gap between observations is a second, separate measure, from the query below.

```
psql "$OWNER_DATABASE_URL" -c "select received_at as before_gap, next_at as after_gap, next_at - received_at as gap from (select received_at, lead(received_at) over (order by received_at) as next_at from platform.market_data_observations where received_at >= '<RUN_START>') t where next_at - received_at > interval '60 seconds' order by gap desc limit 20"
```

## Window and criteria (proposed; the user decides)

- Window: 24 hours of engine uptime, one instrument. Under Option B the hours accumulate across restarts.
- Success: the engine runs for the window or stops only on the user's decision; every `HEARTBEAT_TIMEOUT` or `HEARTBEAT_GAP` event is explained by a logged outage or reconnect; every halt has a reason code the engine documents; the effective state is `AVAILABLE` except during logged halts, reconnects and outages; after a controlled stop the state becomes stale at its configured deadline.
- Abort at once on any of: a terms-gate failure, a host outside the allow-list, an unexplained halt loop (more than three halts in ten minutes), exit code 1 or 70, a full disk, or the user's decision.

## If the power fails

1. When power returns, the PC starts by itself if the BIOS setting is on. Log in and check that PostgreSQL is running.
2. The log file keeps everything the operating system had written. The last few seconds before the cut may be missing. The database holds every committed observation.
3. Read the gap from the database with the gap query above. Write down the time the cut began, the time power returned and the time you restarted the engine.
4. `journalctl --list-boots` and `last -x | head` show the reboot. `journalctl -b -1` shows the previous boot, only if `/var/log/journal` exists.
5. Start the engine again with the start command, which opens a new log file. The first startup after a cut recovers from the database. If a halt is open the engine will not trade that instrument until it is cleared, and the run stops to ask the user.
6. A power cut is an interruption, not an engine failure. Under Option A the run is void and restarts from zero.

## Data-handling rules

- Real Coinbase market data is not committed to git. The repository is on GitHub, a third party.
- It is not pasted into AI assistant sessions and not copied off the host.
- Evidence for the ledger is counts, timings and reason codes only. No prices, no sizes, no trade identifiers.
- Engine logs may stay on the host. Before anything leaves the host, check it by eye for prices.
- The environment file with the database password stays outside the repository and is never shared.

## Evidence to record after the run

Send the auditor: window start and end in UTC; number of restarts and each outage's start, end and length; connection and reconnect counts by `session` reason; number of `HEARTBEAT_TIMEOUT` and `HEARTBEAT_GAP` events; the number of `heartbeat` summary lines; number of halts with reason codes; the five longest heartbeat gaps from the `heartbeat` lines and the five longest gaps between observations; the effective-state check after a controlled stop; the exit code of each engine run; the disk used. The user decides any change to the 5,000 ms heartbeat timeout.
