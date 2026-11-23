# Market-data observation run (Sprint 5.4): procedure (revision 5)

Status: DRAFT for the user's approval. Revision 5 follows the first segments of the run (ledger item 41): it adds the start script, the sleep mask, the charger and one-engine checks, the accounting of uptime already done and a clean stop at the end. Nothing else changes. Nothing in this document connects anywhere by itself. Do not start the run until the user has approved this runbook in writing in the ledger.

## Terms position (unchanged)

RA-1 is a risk acceptance, not clearance. The gate stays open and no Coinbase reply is recorded.
Hard limits stay in force during the run: one user only, no redistribution, no indexes, benchmarks, fair-value or valuations, no AI or ML use of the data.

## Decisions recorded

The user chose Option B and manual restart on 2026-11-08. The ledger records the choice. The options stay listed below for reference.

1. Power. Chosen: Option B.
   - Option A: continuous 24 hours. Needs a UPS that powers the PC, the router and the modem. The laptop battery is dead, so any mains cut stops everything.
   - Option B (chosen): accumulated 24 hours. Every power cut is logged, the engine is restarted by hand, and the window counts total engine uptime. Each restart starts a new log file.
2. Restart. Chosen: by hand. A service file would be new code and is not part of this runbook.

3. Power for the remaining hours. Chosen by the user on 2026-11-23: the current laptop on mains power with the charger secured, and the BIOS set to restore on AC power loss. No UPS. The user plans to leave it untouched for the rest of the window unless there is another power failure. A further unclean stop is an interruption, not a failure of the engine, and its hours are counted as described below.
4. Hours counted. The user decided on 2026-11-23 to count the uptime done so far, about 11 h 00 min (ledger item 41), including the period 05:46Z to 07:46Z on 2026-11-22 when the network was poor. About 13 h remain. The run is complete when the accumulated engine uptime reaches 24 h.

## Uptime accounting

For each log file, the engine's uptime runs from the `running` event to the last observation in the database that belongs to that run, or to the `stopped` event after a clean stop. Add the segments. Segments already counted: 20:21:38Z to about 04:01:40Z on 2026-11-21/22 (about 7 h 40 min), two accidental starts on 2026-11-22 of under 3 minutes each, and 04:40:36Z to about 07:57:10Z on 2026-11-22 (about 3 h 17 min). Take the running total from the auditor before each restart and again at the end.

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

## Host checklist (Kali Linux)

Check each item before starting. Stop and tell the auditor if one fails.

1. The laptop is on mains power and the charger is secured so it cannot come loose: the plug is fully seated, the cable is fixed or routed so it cannot be pulled, and the charging light is on. Automatic suspend is off in the power settings. `systemctl status sleep.target suspend.target hibernate.target hybrid-sleep.target` shows all four as masked. Mask them if they are not: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`.
2. `timedatectl` shows "System clock synchronized: yes".
3. PostgreSQL 18 is running: `pg_lsclusters` shows `18 main 5432 online`. Kali does not start it by itself. Start it with `sudo systemctl start postgresql@18-main`, and make it start at boot with `sudo systemctl enable postgresql`.
4. `df -h` shows at least 10 GB free on the disk that holds the database and your home folder.
5. No updates during the window. Kali is a rolling release: do not run `apt update`, `apt upgrade` or `apt full-upgrade`, and do not reboot, until the run ends.
6. You stay logged in to your desktop session for the whole run.
7. Only one engine runs. A second engine exits with code 3. Before starting: `pgrep -af 'market-data/src/main.js'` prints nothing.
8. In the BIOS, "restore on AC power loss" is set to power on.
9. The engine runs under Node 22.23.2, the version pinned in `.nvmrc`. Kali's own Node is newer (24) and the project's architecture tool fails on it. The shell that starts the engine must load nvm and print `v22.23.2` for `node --version` (see the start command).
10. Outbound HTTPS to the two hosts works. If the network inspects TLS, the engine refuses the unknown certificate and stops with a failure. That is a safe failure, not a fault.

## Start command

The start script `~/market-data-run/start-engine.sh` (mode 700) already exists. It checks that Node is v22.23.2, loads `~/market-data-run/engine.env`, prints the UTC start time, starts the engine under `systemd-inhibit` and writes a new log file `~/market-data-run/engine-<timestamp>.log`. It prints the engine's exit code when the engine stops. The engine writes one JSON object per line to standard error, with no prices.

```
tmux new -s mdrun
```

Then type this one line, and nothing after it:

```
~/market-data-run/start-engine.sh
```

Do not paste several lines at once. Pasted lines after a shell prompt can be swallowed and start an engine by accident, as happened on 2026-11-22. If the tmux session already exists, attach with `tmux attach -t mdrun`. Write down the UTC time the script prints. This is the start of the segment. Detach from tmux with Ctrl-b then d.
Stop the engine only with Ctrl-c inside tmux. The engine logs `signal` and `stopped` and exits 0. The line after the run prints the exit code: 0 is a clean stop, 1 a failure, 3 another engine holds the lock, 70 the lock was lost. Do not power the laptop off or reboot while the engine runs.

## Watching the run

Use your own owner or admin database login for the `psql` commands. Replace the placeholders. Every query below returns counts, times or reason codes only. Never add a price, size or trade-id column to a query.

```
tail -n 20 "$(ls -t ~/market-data-run/engine-*.log | head -1)"
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

## When the 24 hours are reached

1. Take the running total from the auditor. When it reaches 24 h, stop the engine with Ctrl-c in tmux and note the exit code (it must be 0).
2. Wait for the state to become stale at its configured deadline and read `platform.market_data_effective_state` again.
3. Collect the evidence listed below, for every log file, with `sha256sum` of each log.
4. Give the sleep targets back: `sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target`. Optionally disable the provider again.
5. Keep the logs. Do not delete or edit them. The read-only copies are in `~/market-data-run/evidence/`; copy later files there too.

## Data-handling rules

- Real Coinbase market data is not committed to git. The repository is on GitHub, a third party.
- It is not pasted into AI assistant sessions and not copied off the host.
- Evidence for the ledger is counts, timings and reason codes only. No prices, no sizes, no trade identifiers.
- Engine logs may stay on the host. Before anything leaves the host, check it by eye for prices.
- The environment file with the database password stays outside the repository and is never shared.

## Evidence to record after the run

Send the auditor: window start and end in UTC and the uptime of each segment; number of restarts and each outage's start, end and length; connection and reconnect counts by `session` reason; number of `HEARTBEAT_TIMEOUT` and `HEARTBEAT_GAP` events; the number of `heartbeat` summary lines; number of halts with reason codes; the five longest heartbeat gaps from the `heartbeat` lines and the five longest gaps between observations; the effective-state check after a controlled stop; the exit code of each engine run; the disk used. The user decides any change to the 5,000 ms heartbeat timeout.
