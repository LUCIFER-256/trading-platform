import * as path from "node:path";
import {
  createDatabaseClient,
  runPendingMigrations,
  sql,
  type DatabaseClient,
  type DatabaseEnvironment,
} from "../../packages/database/src";
import {
  PostgresPersistenceError,
  PostgresPersistencePort,
  type PostgresPersistenceRepository,
} from "../../apps/market-data/src/persistence/postgres-persistence-port";
import {
  appendMarketDataObservation,
  appendMarketDataQualityBucket,
  openMarketDataHalt,
  transitionMarketDataState,
} from "../../packages/database/src";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function environment(): DatabaseEnvironment {
  if (process.env.TEST_DATABASE_URL === undefined) {
    throw new Error("TEST_DATABASE_URL is required.");
  }
  return {
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE,
    DATABASE_POOL_MAX: "1",
  };
}

interface Fixture {
  readonly providerId: string;
  readonly btcInstrumentId: string;
  readonly ethInstrumentId: string;
}

function catalogConfiguration(providerUuid: string) {
  return {
    providerLabel: "coinbase",
    providerUuid,
    instruments: [
      { label: "btc", symbol: "BTC-USD" },
      { label: "eth", symbol: "ETH-USD" },
    ],
  };
}

async function insertInstrument(
  client: DatabaseClient,
  marketId: string,
  providerId: string,
  instrumentCode: string,
  symbol: string,
  enabled = true,
): Promise<string> {
  const instrument = await sql<{ readonly id: string }>`insert into platform.instruments(
    market_id, instrument_code, enabled, price_increment, size_increment
  ) values (
    ${marketId}, ${instrumentCode}, ${enabled}, '0.01', '0.00000001'
  ) returning id`.execute(client.database);
  await sql`insert into platform.provider_instrument_symbols(
    provider_id, instrument_id, provider_symbol, enabled
  ) values (
    ${providerId}, ${instrument.rows[0]!.id}, ${symbol}, ${enabled}
  )`.execute(client.database);
  return instrument.rows[0]!.id;
}

async function fixture(client: DatabaseClient, suffix: string): Promise<Fixture> {
  const market = await sql<{ readonly id: string }>`insert into platform.markets(
    market_code, enabled
  ) values (
    ${`adapter-market-${suffix}`}, true
  ) returning id`.execute(client.database);
  const provider = await sql<{ readonly id: string }>`insert into platform.providers(
    provider_code, enabled
  ) values (
    ${`adapter-provider-${suffix}`}, true
  ) returning id`.execute(client.database);
  const btcInstrumentId = await insertInstrument(
    client,
    market.rows[0]!.id,
    provider.rows[0]!.id,
    `adapter-btc-${suffix}`,
    "BTC-USD",
  );
  const ethInstrumentId = await insertInstrument(
    client,
    market.rows[0]!.id,
    provider.rows[0]!.id,
    `adapter-eth-${suffix}`,
    "ETH-USD",
  );
  await sql`insert into platform.market_data_policies(
    instrument_id, enabled, max_ingestion_age_ms, max_event_age_ms, max_future_skew_ms
  ) values
    (${btcInstrumentId}, true, 600000, 600000, 60000),
    (${ethInstrumentId}, true, 600000, 600000, 60000)`.execute(client.database);
  return { providerId: provider.rows[0]!.id, btcInstrumentId, ethInstrumentId };
}

function observation(tradeId: string) {
  return {
    providerId: "coinbase",
    instrumentId: "btc",
    providerSymbol: "BTC-USD",
    providerSequence: tradeId,
    tradeId,
    eventAtUs: (BigInt(Date.now()) * 1000n).toString(),
    receivedAt: new Date(),
    bid: "99",
    bidSize: "1",
    ask: "101",
    askSize: "1",
    lastPrice: "100",
    lastSize: "1",
    volume24h: "0",
  };
}

async function withWriterRole(
  client: DatabaseClient,
  action: () => Promise<void>,
): Promise<void> {
  await sql`set role platform_market_data`.execute(client.database);
  try {
    await action();
  } finally {
    await sql`reset role`.execute(client.database);
  }
}

async function adapterAgreesWithPortSemantics(
  client: DatabaseClient,
  data: Fixture,
): Promise<void> {
  await withWriterRole(client, async () => {
    const port = await PostgresPersistencePort.fromCatalog(client.database, catalogConfiguration(data.providerId));
    const request = observation("1");
    const first = await port.appendObservation(request);
    const duplicate = await port.appendObservation(request);
    assert(first.outcome === "ACCEPTED", "adapter must preserve accepted outcome.");
    assert(duplicate.outcome === "DUPLICATE_IDENTICAL", "adapter must preserve duplicate outcome.");
    const conflict = await port.appendObservation({ ...request, lastPrice: "101" });
    assert(
      conflict.outcome === "IDEMPOTENCY_CONFLICT" && conflict.haltId !== null,
      "adapter must preserve an atomic idempotency conflict halt.",
    );
  });
  const halted = await sql<{ readonly count: string }>`select count(*)::text as count
    from platform.market_data_halts
    where instrument_id = ${data.btcInstrumentId}
      and reason_code = 'IDEMPOTENCY_CONFLICT'`.execute(client.database);
  assert(halted.rows[0]?.count === "1", "conflict must create exactly one durable halt.");
  console.log("marketDataPersistencePortAcceptedDuplicateAndConflict");
}

async function adapterHaltTransitionAndQualityReplay(
  client: DatabaseClient,
  data: Fixture,
): Promise<void> {
  await withWriterRole(client, async () => {
    const port = await PostgresPersistencePort.fromCatalog(client.database, catalogConfiguration(data.providerId));
    await port.transitionState({
      providerId: "coinbase",
      instrumentId: "eth",
      newBaseAvailability: "UNAVAILABLE_PERSISTENCE",
      reasonCode: "PERSISTENCE_TIMEOUT",
    });
    let lostAcknowledgements = 1;
    const losingAcknowledgement: PostgresPersistenceRepository = {
      appendObservation: appendMarketDataObservation,
      openHalt: openMarketDataHalt,
      transitionState: transitionMarketDataState,
      appendQualityBucket: async (database, request) => {
        await appendMarketDataQualityBucket(database, request);
        if (lostAcknowledgements > 0) {
          lostAcknowledgements -= 1;
          throw new Error("acknowledgement lost after commit");
        }
      },
    };
    const replayPort = await PostgresPersistencePort.fromCatalog(
      client.database,
      catalogConfiguration(data.providerId),
      losingAcknowledgement,
    );
    const bucket = {
      flushId: "quality-1",
      providerId: "coinbase",
      instrumentId: null,
      reasonCode: "MALFORMED",
      bucketStartedAt: new Date("2026-01-01T00:00:00Z"),
      count: 2n,
    };
    let lost: unknown;
    try {
      await replayPort.appendQualityBucket(bucket);
    } catch (error) {
      lost = error;
    }
    assert(lost instanceof PostgresPersistenceError, "the lost acknowledgement must surface as a safe error.");
    await replayPort.appendQualityBucket(bucket);
  });
  const outcome = await sql<{ readonly count: string; readonly state: string }>`select
    (
      select rejected_count::text
      from platform.market_data_quality_buckets
      where provider_id = ${data.providerId}
        and instrument_id is null
    ) as count,
    (
      select base_availability
      from platform.market_data_instrument_state
      where instrument_id = ${data.ethInstrumentId}
    ) as state`.execute(client.database);
  assert(outcome.rows[0]?.count === "2", "quality replay must not double count.");
  assert(
    outcome.rows[0]?.state === "UNAVAILABLE_PERSISTENCE",
    "transition must persist through the writer role.",
  );
  console.log("marketDataPersistencePortTransitionAndQualityReplay");
  await withWriterRole(client, async () => {
    const port = await PostgresPersistencePort.fromCatalog(client.database, catalogConfiguration(data.providerId));
    await port.openHalt({
      providerId: "coinbase",
      instrumentId: "eth",
      reasonCode: "LOCKED_OR_CROSSED",
      eventAtUs: null,
      tradeId: null,
      providerSequence: null,
      candidatePrice: null,
      candidateSize: null,
      referencePrice: null,
    });
  });
  const halted = await sql<{ readonly count: string }>`select count(*)::text as count
    from platform.market_data_halts
    where instrument_id = ${data.ethInstrumentId}
      and reason_code = 'LOCKED_OR_CROSSED'`.execute(client.database);
  assert(halted.rows[0]?.count === "1", "adapter must open exactly one halt.");
  console.log("marketDataPersistencePortHaltOpen");
}

interface MappingCase {
  readonly name: string;
  readonly symbol: string;
  readonly providerEnabled: boolean;
  readonly marketEnabled: boolean;
  readonly instrumentEnabled: boolean;
  readonly symbolEnabled: boolean;
  readonly policyEnabled: boolean;
}

async function insertCase(client: DatabaseClient, suffix: string, item: MappingCase): Promise<string> {
  const market = await sql<{ readonly id: string }>`insert into platform.markets(market_code, enabled)
    values (${`case-market-${item.name}-${suffix}`}, ${item.marketEnabled}) returning id`.execute(client.database);
  const provider = await sql<{ readonly id: string }>`insert into platform.providers(provider_code, enabled)
    values (${`case-provider-${item.name}-${suffix}`}, ${item.providerEnabled}) returning id`.execute(client.database);
  const instrument = await sql<{ readonly id: string }>`insert into platform.instruments(
    market_id, instrument_code, enabled, price_increment, size_increment
  ) values (
    ${market.rows[0]!.id}, ${`case-instrument-${item.name}-${suffix}`}, ${item.instrumentEnabled}, '0.01', '0.00000001'
  ) returning id`.execute(client.database);
  await sql`insert into platform.provider_instrument_symbols(
    provider_id, instrument_id, provider_symbol, enabled
  ) values (
    ${provider.rows[0]!.id}, ${instrument.rows[0]!.id}, ${item.symbol}, ${item.symbolEnabled}
  )`.execute(client.database);
  await sql`insert into platform.market_data_policies(
    instrument_id, enabled, max_ingestion_age_ms, max_event_age_ms, max_future_skew_ms
  ) values (${instrument.rows[0]!.id}, ${item.policyEnabled}, 600000, 600000, 60000)`.execute(client.database);
  return provider.rows[0]!.id;
}

async function catalogRefusals(client: DatabaseClient, suffix: string): Promise<void> {
  const good: MappingCase = {
    name: "good",
    symbol: "GOOD-USD",
    providerEnabled: true,
    marketEnabled: true,
    instrumentEnabled: true,
    symbolEnabled: true,
    policyEnabled: true,
  };
  const goodProvider = await insertCase(client, suffix, good);
  const refused: readonly MappingCase[] = [
    { ...good, name: "policy", symbol: "POLICY-OFF-USD", policyEnabled: false },
    { ...good, name: "symbol", symbol: "SYMBOL-OFF-USD", symbolEnabled: false },
    { ...good, name: "instrument", symbol: "INSTRUMENT-OFF-USD", instrumentEnabled: false },
    { ...good, name: "provider", symbol: "PROVIDER-OFF-USD", providerEnabled: false },
    { ...good, name: "market", symbol: "MARKET-OFF-USD", marketEnabled: false },
  ];
  const refusedProviders = new Map<string, string>();
  for (const item of refused) {
    refusedProviders.set(item.name, await insertCase(client, suffix, item));
  }
  await withWriterRole(client, async () => {
    const accepted = await PostgresPersistencePort.fromCatalog(client.database, {
      providerLabel: "coinbase",
      providerUuid: goodProvider,
      instruments: [{ label: "good", symbol: "GOOD-USD" }],
    });
    assert(accepted instanceof PostgresPersistencePort, "the fully enabled control mapping must be accepted.");
    for (const item of refused) {
      await rejectsCatalog(client, {
        providerLabel: "coinbase",
        providerUuid: refusedProviders.get(item.name)!,
        instruments: [{ label: "good", symbol: item.symbol }],
      });
    }
    await rejectsCatalog(client, {
      providerLabel: "coinbase",
      providerUuid: goodProvider,
      instruments: [{ label: "good", symbol: "UNKNOWN-USD" }],
    });
  });
  console.log("marketDataPersistencePortCatalogRefusals");
}

async function rejectsCatalog(
  client: DatabaseClient,
  configuration: Parameters<typeof PostgresPersistencePort.fromCatalog>[1],
): Promise<void> {
  try {
    await PostgresPersistencePort.fromCatalog(client.database, configuration);
  } catch (error) {
    assert(
      error instanceof Error && error.message === "Market-data persistence catalog failed.",
      "catalog refusal must remain safe.",
    );
    return;
  }
  throw new Error("Expected catalog refusal.");
}

async function main(): Promise<void> {
  const client = createDatabaseClient({ runtimeMode: "test", environment: environment() });
  const suffix = `${process.pid}${Date.now()}`;
  try {
    await sql`drop schema if exists platform cascade`.execute(client.database);
    await runPendingMigrations(client, {
      migrationFolder: path.join(__dirname, "../../packages/database/src/migrations"),
      migrationTableName: `adapter_${suffix}`,
      migrationLockTableName: `adapter_lock_${suffix}`,
    });
    const data = await fixture(client, suffix);
    await adapterAgreesWithPortSemantics(client, data);
    await adapterHaltTransitionAndQualityReplay(client, data);
    await catalogRefusals(client, suffix);
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  throw error;
});
