import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Client as PgClient } from "pg";
import { createTestPasswordHasher } from "../../apps/api/src/auth";
import {
  createDatabaseClient,
  runPendingMigrations,
  sql,
  type DatabaseClient,
} from "../../packages/database/src";
import { createAdvisoryLockConnectionFactory } from "../../apps/market-data/src/advisory-lock";
import { HttpsProductFetcher } from "../../apps/market-data/src/coinbase/rest-fetcher";
import { CoinbaseWsTransport } from "../../apps/market-data/src/coinbase/ws-client";
import { MarketDataEngine, type EngineLogRecord } from "../../apps/market-data/src/engine";
import { EXIT_ABORT, EXIT_LOCK_HELD, EXIT_OK } from "../../apps/market-data/src/main";
import { RealClock, RealPrng, RealTimerScheduler } from "../../apps/market-data/src/runtime-ports";
import { TermsGateError } from "../../apps/market-data/src/terms-gate";
import { startFakeProvider, type FakeProvider } from "../fake-provider/server";
import {
  createTestPki,
  match,
  product,
  ticker,
  type TestPki,
} from "../unit/support/market-data-wire-helpers";

const LOCK_SQL = "select pg_try_advisory_lock(hashtextextended('platform.market_data.engine.v1', 0)) as locked";
const UNLOCK_SQL = "select pg_advisory_unlock(hashtextextended('platform.market_data.engine.v1', 0))";
const MAX_INGESTION_AGE_MS = 1500;
const PLAN_MAX_INGESTION_AGE_MS = 10_000;
const MAIN_PATH = path.join(__dirname, "../../apps/market-data/src/main.js");

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${description}`);
    await sleep(25);
  }
}

function baseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (value === undefined || value.length === 0) throw new Error("TEST_DATABASE_URL is required.");
  return value;
}

function roleUrl(role: string): string {
  const url = new URL(baseUrl());
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

function databaseEnvironment(url: string): Record<string, string> {
  return {
    TEST_DATABASE_URL: url,
    DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE ?? "disable",
    DATABASE_POOL_MAX: "4",
  };
}

async function pgClient(url: string): Promise<PgClient> {
  const client = new PgClient({ connectionString: url });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

interface World {
  readonly instrumentId: string;
  readonly providerUuid: string;
  readonly symbol: string;
  readonly label: string;
  readonly catalog: { providerLabel: string; instruments: { label: string; symbol: string }[] };
}

let worldCounter = 0;

async function buildWorld(
  client: DatabaseClient,
  suffix: string,
  maxIngestionAgeMs: number = MAX_INGESTION_AGE_MS,
): Promise<World> {
  const market = await sql<{ readonly id: string }>`insert into platform.markets(market_code, enabled)
    values (${`engine-market-${suffix}`}, true) returning id`.execute(client.database);
  const provider = await sql<{ readonly id: string }>`insert into platform.providers(provider_code, enabled)
    values (${`engine-provider-${suffix}`}, true) returning id`.execute(client.database);
  const instrument = await sql<{ readonly id: string }>`insert into platform.instruments(
    market_id, instrument_code, enabled, price_increment, size_increment
  ) values (${market.rows[0]!.id}, ${`engine-${suffix}`}, true, '0.01', '0.01') returning id`.execute(client.database);
  const instrumentId = instrument.rows[0]!.id;
  worldCounter += 1;
  const symbol = `T${worldCounter}-USD`;
  await sql`insert into platform.provider_instrument_symbols(provider_id, instrument_id, provider_symbol, enabled)
    values (${provider.rows[0]!.id}, ${instrumentId}, ${symbol}, true)`.execute(client.database);
  await sql`insert into platform.market_data_policies(
    instrument_id, enabled, max_ingestion_age_ms, max_event_age_ms, max_future_skew_ms, jump_reset_ttl_ms
  ) values (${instrumentId}, true, ${maxIngestionAgeMs}, 600000, 60000, 300000)`.execute(client.database);
  return {
    instrumentId,
    providerUuid: provider.rows[0]!.id,
    symbol,
    label: "btcusd",
    catalog: { providerLabel: "coinbase", instruments: [{ label: "btcusd", symbol }] },
  };
}

interface StateRow {
  readonly availability: string;
  readonly observationId: string | null;
  readonly lastPrice: string | null;
  readonly ageMs: number | null;
}

class ViewReader {
  private constructor(private readonly client: PgClient) {}

  public static async open(): Promise<ViewReader> {
    return new ViewReader(await pgClient(roleUrl("platform_market_data_consumer")));
  }

  public async read(instrumentId: string): Promise<StateRow | undefined> {
    const result = await this.client.query<{
      availability: string;
      observation_id: string | null;
      last_trade_price: string | null;
      age_ms: string | null;
    }>(
      `select availability, observation_id, last_trade_price::text as last_trade_price,
        (extract(epoch from (evaluated_at - ingested_at)) * 1000)::text as age_ms
       from platform.market_data_effective_state where instrument_id = $1::uuid`,
      [instrumentId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      availability: row.availability,
      observationId: row.observation_id,
      lastPrice: row.last_trade_price,
      ageMs: row.age_ms === null ? null : Number(row.age_ms),
    };
  }

  public async close(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }
}

async function observationCount(client: DatabaseClient, instrumentId: string): Promise<number> {
  const result = await sql<{ readonly count: string }>`select count(*)::text as count
    from platform.market_data_observations where instrument_id = ${instrumentId}`.execute(client.database);
  return Number(result.rows[0]!.count);
}

async function lockIsFree(): Promise<boolean> {
  const probe = await pgClient(baseUrl());
  try {
    const result = await probe.query<{ locked: boolean }>(LOCK_SQL);
    const free = result.rows[0]?.locked === true;
    if (free) await probe.query(UNLOCK_SQL);
    return free;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

function liveTicker(symbol: string, tradeId: number, base = 100): Record<string, unknown> {
  return ticker({
    product_id: symbol,
    sequence: tradeId,
    trade_id: tradeId,
    time: new Date(Date.now() + tradeId * 5).toISOString().replace("Z", "000Z"),
    best_bid: `${base}.00`,
    best_bid_size: "1.00",
    best_ask: `${base}.02`,
    best_ask_size: "1.00",
    price: `${base}.01`,
    last_size: "1.00",
  });
}

async function feed(
  provider: FakeProvider,
  symbol: string,
  firstTradeId: number,
  count: number,
  options: { readonly connection?: number; readonly base?: number } = {},
): Promise<void> {
  const connection = options.connection ?? 1;
  await waitFor(() => provider.connections() >= connection && provider.frameCount() >= connection, "engine subscribes");
  provider.sendFrame({ type: "subscriptions", channels: [] });
  provider.sendFrame(match(10, symbol));
  for (let index = 0; index < count; index += 1) {
    provider.sendFrame(liveTicker(symbol, firstTradeId + index, options.base ?? 100));
  }
}

interface Stage {
  readonly pki: TestPki;
  readonly provider: FakeProvider;
  readonly rest: https.Server;
  readonly restUrl: string;
  readonly caFile: string;
  close(): Promise<void>;
}

async function openStage(pki: TestPki): Promise<Stage> {
  const provider = await startFakeProvider({ keyPem: pki.serverKeyPem, certPem: pki.serverCertPem });
  const rest = https.createServer({ key: pki.serverKeyPem, cert: pki.serverCertPem }, (request, response) => {
    const symbol = (request.url ?? "").replace("/products/", "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(product(symbol)));
  });
  await new Promise<void>((resolve) => rest.listen(0, "127.0.0.1", resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "md-engine-"));
  const caFile = path.join(directory, "ca.pem");
  fs.writeFileSync(caFile, pki.caPem);
  return {
    pki,
    provider,
    rest,
    restUrl: `https://127.0.0.1:${(rest.address() as AddressInfo).port}`,
    caFile,
    async close(): Promise<void> {
      await provider.stop();
      rest.closeAllConnections();
      await new Promise<void>((resolve) => rest.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

interface RunningEngine {
  readonly engine: MarketDataEngine;
  readonly database: DatabaseClient;
  readonly logs: EngineLogRecord[];
  readonly aborts: { count: number };
}

async function startEngine(stage: Stage, world: World, acknowledgement: unknown): Promise<RunningEngine> {
  const environment = databaseEnvironment(roleUrl("platform_market_data"));
  const database = createDatabaseClient({ runtimeMode: "test", environment });
  const logs: EngineLogRecord[] = [];
  const aborts = { count: 0 };
  try {
    const engine = await MarketDataEngine.start({
      database: database.database,
      lockConnection: createAdvisoryLockConnectionFactory({ runtimeMode: "test", environment }),
      catalog: world.catalog,
      termsAcknowledgement: acknowledgement,
      endpoint: stage.provider.url,
      transport: new CoinbaseWsTransport({ ca: stage.pki.caPem }),
      products: new HttpsProductFetcher({ baseUrl: stage.restUrl, ca: stage.pki.caPem }),
      clock: new RealClock(),
      scheduler: new RealTimerScheduler(),
      prng: new RealPrng(),
      abort: () => {
        aborts.count += 1;
      },
      log: (record) => logs.push(record),
      qualityFlushIntervalMs: 500,
    });
    return { engine, database, logs, aborts };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

async function stopEngine(running: RunningEngine): Promise<void> {
  await running.engine.stop();
  await running.database.close();
}

interface DeadlineEvidence {
  readonly lastAvailableAgeMs: number;
  readonly firstStaleAgeMs: number;
}

function describe(evidence: DeadlineEvidence): string {
  return `last AVAILABLE age ${evidence.lastAvailableAgeMs.toFixed(1)} ms, first STALE age ${evidence.firstStaleAgeMs.toFixed(1)} ms`;
}

async function observeStaleAtDeadline(
  reader: ViewReader,
  instrumentId: string,
  maxAgeMs: number = MAX_INGESTION_AGE_MS,
): Promise<DeadlineEvidence> {
  let lastAvailable = -1;
  const deadline = Date.now() + maxAgeMs + 6000;
  for (;;) {
    const row = await reader.read(instrumentId);
    assert(row !== undefined && row.ageMs !== null, "The state row must exist while observing the deadline.");
    if (row.availability === "AVAILABLE") {
      lastAvailable = row.ageMs;
    } else {
      assert(row.availability === "UNAVAILABLE_STALE", `First non-available state must be STALE, saw ${row.availability}.`);
      assert(lastAvailable >= 0, "The instrument must have been AVAILABLE before it went stale.");
      assert(
        lastAvailable <= maxAgeMs,
        `AVAILABLE must never be served beyond the deadline, saw age ${lastAvailable} ms.`,
      );
      assert(
        row.ageMs > maxAgeMs,
        `STALE must start only after the deadline, saw age ${row.ageMs} ms.`,
      );
      return { lastAvailableAgeMs: lastAvailable, firstStaleAgeMs: row.ageMs };
    }
    assert(Date.now() < deadline, "The view never became stale.");
    await sleep(20);
  }
}

async function notifyOccursOnlyAfterCommit(world: World): Promise<void> {
  const listener = await pgClient(roleUrl("platform_market_data_consumer"));
  const writer = await pgClient(roleUrl("platform_market_data"));
  const notes: string[] = [];
  listener.on("notification", (message) => {
    if (message.channel === "market_data_changed" && message.payload !== undefined) notes.push(message.payload);
  });
  try {
    await listener.query("LISTEN market_data_changed");
    const append = async (tradeId: number): Promise<void> => {
      const now = Date.now();
      const iso = new Date(now).toISOString();
      await writer.query(
        `select * from platform.append_market_data_observation($1::uuid, $2::uuid, $3, $4::numeric, $5::numeric,
          $6::numeric, $7::timestamptz, $8::timestamptz, 100.00, 1, 100.02, 1, 100.01, 1, 0)`,
        [world.providerUuid, world.instrumentId, world.symbol, tradeId, tradeId, BigInt(now) * 1000n, iso, iso]
          .map((value) => (typeof value === "bigint" ? value.toString() : value)),
      );
    };
    await writer.query("begin");
    await append(9001);
    await sleep(300);
    await listener.query("select 1");
    assert(notes.length === 0, "No notification may be delivered before the writer commits.");
    await writer.query("rollback");
    await sleep(200);
    await listener.query("select 1");
    assert(notes.length === 0, "A rolled-back observation must never notify.");
    await writer.query("begin");
    await append(9002);
    await sleep(200);
    await listener.query("select 1");
    assert(notes.length === 0, "Still nothing before commit.");
    await writer.query("commit");
    await waitFor(() => notes.length === 1, "one notification after commit");
    assert(notes[0] === world.instrumentId, "The payload must be the instrument id and nothing else.");
    console.log("notifyOccursOnlyAfterCommit");
  } finally {
    await writer.end().catch(() => undefined);
    await listener.end().catch(() => undefined);
  }
}

async function lostNotificationConsumerRereads(world: World): Promise<void> {
  const writer = await pgClient(roleUrl("platform_market_data"));
  const killer = await pgClient(baseUrl());
  const reader = await ViewReader.open();
  const firstListener = await pgClient(roleUrl("platform_market_data_consumer"));
  const missed: string[] = [];
  firstListener.on("notification", (message) => {
    if (message.payload !== undefined) missed.push(message.payload);
  });
  try {
    await firstListener.query("LISTEN market_data_changed");
    const pid = (await firstListener.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await killer.query("select pg_terminate_backend($1)", [pid]);
    await sleep(200);
    const now = Date.now();
    const iso = new Date(now).toISOString();
    await writer.query(
      `select * from platform.append_market_data_observation($1::uuid, $2::uuid, $3, 9101, 9101,
        $4::numeric, $5::timestamptz, $6::timestamptz, 100.00, 1, 100.02, 1, 123.45, 1, 0)`,
      [world.providerUuid, world.instrumentId, world.symbol, (BigInt(now) * 1000n).toString(), iso, iso],
    );
    await sleep(300);
    assert(missed.length === 0, "The terminated consumer must have missed the notification.");
    const afterReconnect = await pgClient(roleUrl("platform_market_data_consumer"));
    const received: string[] = [];
    afterReconnect.on("notification", (message) => {
      if (message.payload !== undefined) received.push(message.payload);
    });
    try {
      await afterReconnect.query("LISTEN market_data_changed");
      await sleep(300);
      assert(received.length === 0, "A reconnected consumer is not replayed the missed notification.");
    } finally {
      await afterReconnect.end().catch(() => undefined);
    }
    const state = await reader.read(world.instrumentId);
    assert(state !== undefined, "The view must be readable after reconnect.");
    assert(state.availability === "AVAILABLE", `The reread view must show the true state, saw ${state.availability}.`);
    assert(
      state.lastPrice !== null && Number(state.lastPrice) === 123.45,
      `The reread view must show the latest price, saw ${state.lastPrice}.`,
    );
    console.log("lostNotificationConsumerRereads");
  } finally {
    await reader.close();
    await killer.end().catch(() => undefined);
    await writer.end().catch(() => undefined);
    await firstListener.end().catch(() => undefined);
  }
}

async function persistenceRefusesBeforeTermsGate(
  owner: DatabaseClient,
  stage: Stage,
  world: World,
): Promise<void> {
  for (const acknowledgement of [undefined, "", "cleared", "ra1_risk_accepted"]) {
    let refusal: unknown;
    try {
      const running = await startEngine(stage, world, acknowledgement);
      await stopEngine(running);
    } catch (error) {
      refusal = error;
    }
    assert(refusal instanceof TermsGateError, `Engine must refuse acknowledgement ${String(acknowledgement)}.`);
  }
  assert(stage.provider.tcpConnections() === 0, "A refused engine must never open a provider connection.");
  assert(await lockIsFree(), "A refused engine must never take the advisory lock.");
  const rows = await sql<{ readonly count: string }>`select count(*)::text as count
    from platform.market_data_instrument_state where instrument_id = ${world.instrumentId}`.execute(owner.database);
  assert(rows.rows[0]?.count === "0", "A refused engine must write no state.");
  console.log("persistenceRefusesBeforeTermsGate");
}

async function fakeWireToPostgresEndToEnd(owner: DatabaseClient, stage: Stage, world: World): Promise<void> {
  const reader = await ViewReader.open();
  const listener = await pgClient(roleUrl("platform_market_data_consumer"));
  const notes: string[] = [];
  listener.on("notification", (message) => {
    if (message.payload !== undefined) notes.push(message.payload);
  });
  await listener.query("LISTEN market_data_changed");
  const running = await startEngine(stage, world, "RA1_RISK_ACCEPTED");
  try {
    assert(running.engine.summary().started.join(",") === world.label, "The engine must start the configured instrument.");
    assert(!(await lockIsFree()), "A running engine must hold the advisory lock.");
    await feed(stage.provider, world.symbol, 1, 3);
    await waitFor(async () => (await observationCount(owner, world.instrumentId)) === 3, "three observations persisted");
    await waitFor(async () => (await reader.read(world.instrumentId))?.availability === "AVAILABLE", "view AVAILABLE");
    await waitFor(() => notes.length >= 3, "notifications delivered");
    assert(notes.every((payload) => payload === world.instrumentId), "Every notification must carry the instrument id.");
    const available = await reader.read(world.instrumentId);
    assert(available?.lastPrice !== null && Number(available?.lastPrice) === 100.01, "The view must show the wire price.");
    const evidence = await observeStaleAtDeadline(reader, world.instrumentId);
    console.log(`fakeWireToPostgresEndToEnd stale deadline: ${describe(evidence)}`);
    assert(running.aborts.count === 0, "A healthy engine must not abort.");
    const text = JSON.stringify(running.logs);
    assert(!/postgres:|password|platform_test|BEGIN/i.test(text), "Engine logs must carry no connection or secret material.");
    assert(!/cleared/i.test(text), "Engine logs must never say cleared.");
  } finally {
    await stopEngine(running);
    await reader.close();
    await listener.end().catch(() => undefined);
  }
  assert(await lockIsFree(), "A stopped engine must release the advisory lock.");
  await waitFor(() => stage.provider.openClients() === 0, "provider connection closed by stop", 3000);
  const stopped = running.logs.filter((record) => record.event === "stopped");
  assert(stopped.length === 1 && stopped[0]?.fields.drained === true, "Stop must log one drained shutdown.");
  const count = await observationCount(owner, world.instrumentId);
  stage.provider.sendFrame(liveTicker(world.symbol, 50));
  await sleep(300);
  assert((await observationCount(owner, world.instrumentId)) === count, "A stopped engine must persist nothing further.");
  console.log("fakeWireToPostgresEndToEnd");
}

class EngineProcess {
  public readonly events: { event: string; fields: Record<string, unknown> }[] = [];
  public readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  public readonly raw: string[] = [];
  private readonly child: ChildProcess;
  private buffer = "";

  public constructor(stage: Stage, world: World, extra: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [MAIN_PATH], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PLATFORM_RUNTIME_MODE: "test",
        ...databaseEnvironment(roleUrl("platform_market_data")),
        MARKET_DATA_WS_ENDPOINT: stage.provider.url,
        MARKET_DATA_REST_BASE_URL: stage.restUrl,
        MARKET_DATA_ALLOWED_HOSTS: "127.0.0.1",
        MARKET_DATA_INSTRUMENTS: `${world.label}=${world.symbol}`,
        MARKET_DATA_TERMS_ACKNOWLEDGEMENT: "RA1_RISK_ACCEPTED",
        MARKET_DATA_EXTRA_CA_FILE: stage.caFile,
        MARKET_DATA_QUALITY_FLUSH_INTERVAL_MS: "500",
        ...extra,
      },
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const index = this.buffer.indexOf("\n");
        if (index < 0) break;
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        this.raw.push(line);
        try {
          const parsed = JSON.parse(line) as { event: string; fields: Record<string, unknown> };
          this.events.push(parsed);
        } catch {
          this.events.push({ event: "unparsed", fields: {} });
        }
      }
    });
    this.exit = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  public pid(): number {
    assert(this.child.pid !== undefined, "The child must have a pid.");
    return this.child.pid;
  }

  public has(event: string): boolean {
    return this.events.some((item) => item.event === event);
  }

  public signal(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  public assertSafeLogs(): void {
    const text = this.raw.join("\n");
    assert(!/postgres:|password|platform_test|BEGIN/i.test(text), "Process logs must carry no connection or secret material.");
    assert(!/cleared/i.test(text), "Process logs must never say cleared.");
  }
}

async function runningProcess(stage: Stage, world: World, reader: ViewReader): Promise<EngineProcess> {
  const child = new EngineProcess(stage, world);
  await waitFor(() => child.has("running") || child.has("fatal"), "engine process running", 20_000);
  assert(child.has("running"), `Engine process must start, saw ${JSON.stringify(child.events)}.`);
  await feed(stage.provider, world.symbol, 1, 3);
  await waitFor(async () => (await reader.read(world.instrumentId))?.availability === "AVAILABLE", "child view AVAILABLE");
  return child;
}

async function sigkillEngineBecomesStaleAtDeadline(stage: Stage, world: World): Promise<void> {
  const reader = await ViewReader.open();
  const child = await runningProcess(stage, world, reader);
  try {
    child.signal("SIGKILL");
    const result = await child.exit;
    assert(result.signal === "SIGKILL", "The engine process must die by SIGKILL.");
    const evidence = await observeStaleAtDeadline(reader, world.instrumentId);
    console.log(`sigkillEngineBecomesStaleAtDeadline ${describe(evidence)}`);
    await waitFor(() => lockIsFree(), "advisory lock released after SIGKILL", 10_000);
    child.assertSafeLogs();
  } finally {
    await reader.close();
    child.signal("SIGKILL");
  }
}

async function sigkillEngineBecomesStaleAtPlanDeadline(stage: Stage, world: World): Promise<void> {
  const reader = await ViewReader.open();
  const child = await runningProcess(stage, world, reader);
  try {
    child.signal("SIGKILL");
    await child.exit;
    const evidence = await observeStaleAtDeadline(reader, world.instrumentId, PLAN_MAX_INGESTION_AGE_MS);
    console.log(`sigkillEngineBecomesStaleAtPlanDeadline ${describe(evidence)}`);
  } finally {
    await reader.close();
    child.signal("SIGKILL");
  }
}

async function hungEngineBecomesStaleAtDeadline(stage: Stage, world: World): Promise<void> {
  const reader = await ViewReader.open();
  const child = await runningProcess(stage, world, reader);
  try {
    child.signal("SIGSTOP");
    const evidence = await observeStaleAtDeadline(reader, world.instrumentId);
    console.log(`hungEngineBecomesStaleAtDeadline ${describe(evidence)}`);
    assert(!(await lockIsFree()), "A hung engine still holds the advisory lock, so no second writer can start.");
    const second = new EngineProcess(stage, world);
    const result = await second.exit;
    assert(result.code === EXIT_LOCK_HELD, `A second engine must be refused with exit ${EXIT_LOCK_HELD}, saw ${String(result.code)}.`);
    assert(second.has("fatal"), "The refused engine must log a fatal record.");
    second.assertSafeLogs();
    child.signal("SIGKILL");
    await child.exit;
    await waitFor(() => lockIsFree(), "advisory lock released after the hung engine is killed", 10_000);
  } finally {
    await reader.close();
    child.signal("SIGCONT");
    child.signal("SIGKILL");
  }
}

async function sigtermEngineStopsGracefully(stage: Stage, world: World): Promise<void> {
  const reader = await ViewReader.open();
  const child = await runningProcess(stage, world, reader);
  try {
    child.signal("SIGTERM");
    const result = await child.exit;
    assert(result.code === EXIT_OK && result.signal === null, `SIGTERM must exit cleanly, saw ${JSON.stringify(result)}.`);
    assert(child.has("stopped"), "A graceful stop must log stopped.");
    assert(await lockIsFree(), "A graceful stop must release the advisory lock.");
    child.assertSafeLogs();
    console.log("sigtermEngineStopsGracefully");
  } finally {
    await reader.close();
    child.signal("SIGKILL");
  }
}

async function engineStartFailureReleasesLock(owner: DatabaseClient, stage: Stage, world: World): Promise<void> {
  const unmapped: World = {
    ...world,
    catalog: { providerLabel: "coinbase", instruments: [{ label: "ghost", symbol: "NOPE-USD" }] },
  };
  let refusal: unknown;
  try {
    const running = await startEngine(stage, unmapped, "RA1_RISK_ACCEPTED");
    await stopEngine(running);
  } catch (error) {
    refusal = error;
  }
  assert(
    refusal instanceof Error && refusal.name === "EngineStartError",
    `A catalog with nothing to start must refuse, saw ${String(refusal)}.`,
  );
  assert(await lockIsFree(), "A failed start must release the advisory lock.");
  await sql`update platform.market_data_policies set enabled = false where instrument_id = ${world.instrumentId}`.execute(owner.database);
  let skipped: unknown;
  try {
    const running = await startEngine(stage, world, "RA1_RISK_ACCEPTED");
    await stopEngine(running);
  } catch (error) {
    skipped = error;
  }
  assert(
    skipped instanceof Error && skipped.name === "EngineStartError",
    `A mapped but policy-less instrument must leave nothing to start, saw ${String(skipped)}.`,
  );
  assert(await lockIsFree(), "A start with nothing to run must release the advisory lock.");
  await sql`update platform.market_data_policies set enabled = true where instrument_id = ${world.instrumentId}`.execute(owner.database);
  await sql`select platform.open_market_data_halt(${world.providerUuid}::uuid, ${world.instrumentId}::uuid, 'LOCKED_OR_CROSSED',
    null, null, null, null, null, null)`.execute(owner.database);
  let halted: unknown;
  try {
    const running = await startEngine(stage, world, "RA1_RISK_ACCEPTED");
    await stopEngine(running);
  } catch (error) {
    halted = error;
  }
  assert(
    halted instanceof Error && halted.name === "EngineStartError",
    `A mapped but human-halted instrument must leave nothing to start, saw ${String(halted)}.`,
  );
  assert(await lockIsFree(), "A start with only halted instruments must release the advisory lock.");
  assert(stage.provider.tcpConnections() === 0, "A failed start must never connect to the provider.");
  console.log("engineStartFailureReleasesLock");
}

async function engineRestartKeepsJumpGuard(owner: DatabaseClient, stage: Stage, world: World): Promise<void> {
  const reader = await ViewReader.open();
  try {
    const first = await startEngine(stage, world, "RA1_RISK_ACCEPTED");
    await feed(stage.provider, world.symbol, 1, 3);
    await waitFor(async () => (await observationCount(owner, world.instrumentId)) === 3, "first run persists three observations");
    await stopEngine(first);
    const second = await startEngine(stage, world, "RA1_RISK_ACCEPTED");
    try {
      await feed(stage.provider, world.symbol, 4, 3, { connection: 2, base: 200 });
      await waitFor(
        async () => (await reader.read(world.instrumentId))?.availability === "UNAVAILABLE_HUMAN_HALT",
        "restart seeds the price so a large jump halts",
      );
      const accepted = await observationCount(owner, world.instrumentId);
      assert(accepted === 3, `The jump candidate must not be accepted, saw ${accepted} observations.`);
      const halts = await sql<{ readonly count: string }>`select count(*)::text as count from platform.market_data_halts
        where instrument_id = ${world.instrumentId} and reason_code = 'PRICE_JUMP'`.execute(owner.database);
      assert(halts.rows[0]?.count === "1", "Exactly one PRICE_JUMP halt must be recorded.");
    } finally {
      await stopEngine(second);
    }
    console.log("engineRestartKeepsJumpGuard");
  } finally {
    await reader.close();
  }
}

async function superAdminSession(client: DatabaseClient, label: string): Promise<{ readonly id: string; readonly secret: string }> {
  const user = await sql<{ readonly id: string }>`insert into platform.users(user_code, enabled)
    values (${label}, true) returning id`.execute(client.database);
  const userId = user.rows[0]!.id;
  const hash = await createTestPasswordHasher().hash("integration-password");
  await sql`insert into platform.password_credentials(user_id, password_hash, credential_version)
    values (${userId}, ${hash}, 1)`.execute(client.database);
  await sql`insert into platform.account_role_assignments(user_id, account_id, role, enabled)
    values (${userId}, null, 'SUPER_ADMIN', true)`.execute(client.database);
  const secret = `${label}-session-secret-sufficiently-long`;
  const row = await sql<{ readonly id: string }>`select platform.create_auth_session(${userId}, ${secret}, 1,
    clock_timestamp() + interval '30 minutes', clock_timestamp() + interval '8 hours') as id`.execute(client.database);
  return { id: row.rows[0]!.id, secret };
}

async function engineHonorsConfirmedResetAfterRestart(owner: DatabaseClient, stage: Stage, world: World): Promise<void> {
  const reader = await ViewReader.open();
  try {
    const first = await startEngine(stage, world, "RA1_RISK_ACCEPTED");
    await feed(stage.provider, world.symbol, 1, 3);
    await waitFor(async () => (await observationCount(owner, world.instrumentId)) === 3, "first run persists three observations");
    await feed(stage.provider, world.symbol, 4, 1, { base: 200 });
    await waitFor(
      async () => (await reader.read(world.instrumentId))?.availability === "UNAVAILABLE_HUMAN_HALT",
      "the large jump halts the instrument",
    );
    await stopEngine(first);
    const halt = await sql<{ readonly id: string; readonly candidate: string }>`select id, candidate_price::text as candidate
      from platform.market_data_halts where instrument_id = ${world.instrumentId} and reason_code = 'PRICE_JUMP'`.execute(owner.database);
    assert(halt.rows.length === 1, "Exactly one PRICE_JUMP halt must exist before the clear.");
    const session = await superAdminSession(owner, `reset-${process.pid}-${Date.now()}`);
    await sql`select * from platform.clear_market_data_halt(${session.id}, ${session.secret}, ${halt.rows[0]!.id},
      ${world.instrumentId}, 'confirmed reset test', ${halt.rows[0]!.candidate}::numeric)`.execute(owner.database);
    const second = await startEngine(stage, world, "RA1_RISK_ACCEPTED");
    try {
      await feed(stage.provider, world.symbol, 5, 3, { connection: 2, base: 200 });
      await waitFor(
        async () => (await observationCount(owner, world.instrumentId)) === 6,
        "the restarted engine accepts the confirmed price and the ticks after it",
      );
      assert(
        (await reader.read(world.instrumentId))?.availability === "AVAILABLE",
        "The instrument must be available after the confirmed reset is used.",
      );
      const counts = await sql<{ readonly halts: string; readonly consumed: string }>`select
        (select count(*)::text from platform.market_data_halts where instrument_id = ${world.instrumentId}) as halts,
        (select count(*)::text from platform.market_data_jump_reset_consumptions c
          join platform.market_data_jump_resets r on r.id = c.reset_id where r.instrument_id = ${world.instrumentId}) as consumed`
        .execute(owner.database);
      assert(counts.rows[0]?.halts === "1", "No further halt may be recorded after the confirmed reset.");
      assert(counts.rows[0]?.consumed === "1", "The reset must be consumed exactly once.");
    } finally {
      await stopEngine(second);
    }
    console.log("engineHonorsConfirmedResetAfterRestart");
  } finally {
    await reader.close();
  }
}

class ShiftClock {
  public offsetMs = 0;

  public nowMs(): number {
    return Date.now() + this.offsetMs;
  }
}

async function engineFlushesClosedQualityBucketOnce(owner: DatabaseClient, stage: Stage, world: World): Promise<void> {
  const clock = new ShiftClock();
  const environment = databaseEnvironment(roleUrl("platform_market_data"));
  const database = createDatabaseClient({ runtimeMode: "test", environment });
  const engine = await MarketDataEngine.start({
    database: database.database,
    lockConnection: createAdvisoryLockConnectionFactory({ runtimeMode: "test", environment }),
    catalog: world.catalog,
    termsAcknowledgement: "RA1_RISK_ACCEPTED",
    endpoint: stage.provider.url,
    transport: new CoinbaseWsTransport({ ca: stage.pki.caPem }),
    products: new HttpsProductFetcher({ baseUrl: stage.restUrl, ca: stage.pki.caPem }),
    clock,
    scheduler: new RealTimerScheduler(),
    prng: new RealPrng(),
    abort: () => undefined,
    log: () => undefined,
    qualityFlushIntervalMs: 300,
  });
  const total = async (): Promise<number> => {
    const rows = await sql<{ readonly total: string | null }>`select sum(rejected_count)::text as total
      from platform.market_data_quality_buckets where provider_id = ${world.providerUuid}`.execute(owner.database);
    return Number(rows.rows[0]?.total ?? 0);
  };
  try {
    await waitFor(() => stage.provider.connections() >= 1 && stage.provider.frameCount() >= 1, "engine subscribes");
    stage.provider.sendFrame({ type: "subscriptions", channels: [] });
    stage.provider.sendFrame("{\"nope\":true}");
    stage.provider.sendFrame("{\"nope\":true}");
    await sleep(500);
    assert((await total()) === 0, "An open bucket must not be flushed early.");
    clock.offsetMs = 61_000;
    await waitFor(async () => (await total()) > 0, "closed bucket flushed at the configured interval", 2500);
    const flushed = await total();
    assert(flushed === 2, `Both rejections must be counted exactly once, saw ${flushed}.`);
    await sleep(1200);
    assert((await total()) === flushed, "Later flush intervals must not double count.");
  } finally {
    await engine.stop();
    await database.close();
  }
  console.log("engineFlushesClosedQualityBucketOnce");
}

async function lockLossKillsEngineProcess(stage: Stage, world: World): Promise<void> {
  const reader = await ViewReader.open();
  const killer = await pgClient(baseUrl());
  const child = await runningProcess(stage, world, reader);
  try {
    const holder = await killer.query<{ pid: number }>(`select a.pid from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.granted and a.pid <> pg_backend_pid() and a.datname = current_database()`);
    assert(holder.rows.length === 1, `Exactly one backend must hold the advisory lock, saw ${holder.rows.length}.`);
    await killer.query("select pg_terminate_backend($1)", [holder.rows[0]!.pid]);
    const result = await Promise.race([child.exit, sleep(8000).then(() => undefined)]);
    assert(result !== undefined, "The engine process must exit after it loses the lock.");
    assert(result.code === EXIT_ABORT, `Lock loss must exit ${EXIT_ABORT}, saw ${JSON.stringify(result)}.`);
    assert(child.has("abort"), "Lock loss must log an abort record.");
    const evidence = await observeStaleAtDeadline(reader, world.instrumentId);
    console.log(`lockLossKillsEngineProcess first STALE age ${evidence.firstStaleAgeMs.toFixed(1)} ms`);
    child.assertSafeLogs();
  } finally {
    await reader.close();
    await killer.end().catch(() => undefined);
    child.signal("SIGKILL");
  }
}

async function processWithUnreachableDatabaseFailsSafely(stage: Stage, world: World): Promise<void> {
  const unreachable = "postgres://platform_market_data:sekretpw@127.0.0.1:1/platform_test?options=-c%20role%3Dplatform_market_data";
  const child = new EngineProcess(stage, world, { TEST_DATABASE_URL: unreachable });
  const result = await child.exit;
  assert(result.code !== null && result.code !== 0, "An unreachable database must end the process with a failure.");
  assert(!child.has("running"), "The process must never report running without a database.");
  assert(stage.provider.tcpConnections() === 0, "The process must never connect to the provider without a database.");
  const text = child.raw.join("\n");
  assert(!/sekretpw|ECONNREFUSED|127\.0\.0\.1|postgres:/.test(text), "Failure logs must not leak connection details.");
  for (const extra of [
    { TEST_DATABASE_URL: "postgres://platform_market_data:sekretpw@[::bad/platform_test" },
    { MARKET_DATA_EXTRA_CA_FILE: "/nonexistent/sekretpath/ca.pem" },
  ]) {
    const variant = new EngineProcess(stage, world, extra);
    const outcome = await variant.exit;
    assert(
      outcome.code !== null && outcome.code !== 0 && !variant.has("running"),
      "A broken configuration must end the process with a failure.",
    );
    assert(!/sekretpw|sekretpath|postgres:|nonexistent/.test(variant.raw.join("\n")), "Failure logs must not echo configuration values.");
  }
  console.log(`processWithUnreachableDatabaseFailsSafely exit ${String(result.code)}`);
}

async function processRefusesWithoutTermsAcknowledgement(stage: Stage, world: World): Promise<void> {
  const child = new EngineProcess(stage, world, { MARKET_DATA_TERMS_ACKNOWLEDGEMENT: "" });
  const result = await child.exit;
  assert(result.code === 1, `A process without acknowledgement must exit 1, saw ${String(result.code)}.`);
  assert(child.has("fatal") && !child.has("running"), "The process must report a fatal refusal and never run.");
  assert(await lockIsFree(), "A refused process must not hold the lock.");
  assert(stage.provider.tcpConnections() === 0, "A refused process must never connect to the provider.");
  child.assertSafeLogs();
  const live = new EngineProcess(stage, world, { PLATFORM_RUNTIME_MODE: "live" });
  const liveResult = await live.exit;
  assert(liveResult.code === 1 && !live.has("running"), "Live mode must be refused.");
  console.log("processRefusesWithoutTermsAcknowledgement");
}

function assertDisposableDatabase(url: string | undefined): void {
  const name = url === undefined ? "" : decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!/test/i.test(name)) {
    throw new Error("TEST_DATABASE_URL must name a database whose name contains 'test'; this suite drops schema platform.");
  }
}

async function main(): Promise<void> {
  assertDisposableDatabase(process.env.TEST_DATABASE_URL);
  assert(fs.existsSync(MAIN_PATH), `Built entrypoint must exist at ${MAIN_PATH}.`);
  const owner = createDatabaseClient({
    runtimeMode: "test",
    environment: { ...databaseEnvironment(baseUrl()), DATABASE_POOL_MAX: "1" },
  });
  const suffix = `${process.pid}${Date.now()}`;
  const pki = createTestPki();
  const stages: Stage[] = [];
  const openNew = async (): Promise<Stage> => {
    const stage = await openStage(pki);
    stages.push(stage);
    return stage;
  };
  try {
    await sql`drop schema if exists platform cascade`.execute(owner.database);
    await runPendingMigrations(owner, {
      migrationFolder: path.join(__dirname, "../../packages/database/src/migrations"),
      migrationTableName: `engine_${suffix}`,
      migrationLockTableName: `engine_lock_${suffix}`,
    });
    const notifyWorld = await buildWorld(owner, `${suffix}n`);
    await notifyOccursOnlyAfterCommit(notifyWorld);
    const rereadWorld = await buildWorld(owner, `${suffix}r`);
    await lostNotificationConsumerRereads(rereadWorld);
    const termsWorld = await buildWorld(owner, `${suffix}t`);
    await persistenceRefusesBeforeTermsGate(owner, await openNew(), termsWorld);
    const wireWorld = await buildWorld(owner, `${suffix}w`);
    await fakeWireToPostgresEndToEnd(owner, await openNew(), wireWorld);
    const releaseWorld = await buildWorld(owner, `${suffix}f`);
    await engineStartFailureReleasesLock(owner, await openNew(), releaseWorld);
    const restartWorld = await buildWorld(owner, `${suffix}j`);
    await engineRestartKeepsJumpGuard(owner, await openNew(), restartWorld);
    const resetWorld = await buildWorld(owner, `${suffix}c`);
    await engineHonorsConfirmedResetAfterRestart(owner, await openNew(), resetWorld);
    const flushWorld = await buildWorld(owner, `${suffix}q`);
    await engineFlushesClosedQualityBucketOnce(owner, await openNew(), flushWorld);
    const killWorld = await buildWorld(owner, `${suffix}k`);
    assert(await lockIsFree(), "The lock must be free before process tests.");
    await sigkillEngineBecomesStaleAtDeadline(await openNew(), killWorld);
    const planWorld = await buildWorld(owner, `${suffix}p`, PLAN_MAX_INGESTION_AGE_MS);
    await sigkillEngineBecomesStaleAtPlanDeadline(await openNew(), planWorld);
    const hungWorld = await buildWorld(owner, `${suffix}h`);
    await hungEngineBecomesStaleAtDeadline(await openNew(), hungWorld);
    const termWorld = await buildWorld(owner, `${suffix}s`);
    await sigtermEngineStopsGracefully(await openNew(), termWorld);
    const lossWorld = await buildWorld(owner, `${suffix}l`);
    await lockLossKillsEngineProcess(await openNew(), lossWorld);
    const downWorld = await buildWorld(owner, `${suffix}d`);
    await processWithUnreachableDatabaseFailsSafely(await openNew(), downWorld);
    const refuseWorld = await buildWorld(owner, `${suffix}x`);
    await processRefusesWithoutTermsAcknowledgement(await openNew(), refuseWorld);
  } finally {
    for (const stage of stages) await stage.close().catch(() => undefined);
    pki.cleanup();
    await sql`drop schema if exists platform cascade`.execute(owner.database).catch(() => undefined);
    await owner.close();
  }
}

let finished = false;

process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("Engine integration test ended without finishing.");
    process.exitCode = 1;
  }
});

void main().then(
  () => {
    finished = true;
    process.exit(0);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
