import * as path from "node:path";
import { Client as PgClient } from "pg";
import {
  clearMarketDataHalt,
  createDatabaseClient,
  runPendingMigrations,
  sql,
  type DatabaseClient,
  type DatabaseEnvironment,
} from "../../packages/database/src";
import { createTestPasswordHasher } from "../../apps/api/src/auth";
import {
  AdvisoryLock,
  AdvisoryLockError,
  createAdvisoryLockConnectionFactory,
} from "../../apps/market-data/src/advisory-lock";
import { RealTimerScheduler } from "../../apps/market-data/src/runtime-ports";
import {
  PostgresPersistencePort,
  type CatalogConfiguration,
} from "../../apps/market-data/src/persistence/postgres-persistence-port";
import {
  loadStartupCatalog,
  recoverMarketDataStartup,
  type StartupResult,
} from "../../apps/market-data/src/persistence/startup";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function environment(): DatabaseEnvironment {
  if (process.env.TEST_DATABASE_URL === undefined) throw new Error("TEST_DATABASE_URL is required.");
  return {
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE,
    DATABASE_POOL_MAX: "1",
  };
}

interface InstrumentSpec {
  readonly label: string;
  readonly instrumentEnabled?: boolean;
  readonly mappingEnabled?: boolean;
  readonly marketKey?: "enabled" | "disabled";
  readonly policy?: "enabled" | "none";
  readonly jumpResetTtlMs?: number;
}

interface Fixture {
  readonly providerId: string;
  readonly ids: ReadonlyMap<string, string>;
  readonly configuration: CatalogConfiguration;
}

async function insertMarket(client: DatabaseClient, code: string, enabled: boolean): Promise<string> {
  const row = await sql<{ readonly id: string }>`insert into platform.markets(market_code, enabled)
    values (${code}, ${enabled}) returning id`.execute(client.database);
  return row.rows[0]!.id;
}

async function insertProvider(client: DatabaseClient, code: string, enabled: boolean): Promise<string> {
  const row = await sql<{ readonly id: string }>`insert into platform.providers(provider_code, enabled)
    values (${code}, ${enabled}) returning id`.execute(client.database);
  return row.rows[0]!.id;
}

async function insertInstrument(
  client: DatabaseClient,
  ids: { readonly marketId: string; readonly providerId: string },
  suffix: string,
  spec: InstrumentSpec,
): Promise<{ readonly instrumentId: string; readonly symbol: string }> {
  const symbol = `${spec.label.toUpperCase()}${suffix}-USD`;
  const row = await sql<{ readonly id: string }>`insert into platform.instruments(
    market_id, instrument_code, enabled, price_increment, size_increment
  ) values (
    ${ids.marketId}, ${`startup-${spec.label}-${suffix}`}, ${spec.instrumentEnabled ?? true}, '0.01', '0.00000001'
  ) returning id`.execute(client.database);
  const instrumentId = row.rows[0]!.id;
  await sql`insert into platform.provider_instrument_symbols(provider_id, instrument_id, provider_symbol, enabled)
    values (${ids.providerId}, ${instrumentId}, ${symbol}, ${spec.mappingEnabled ?? true})`.execute(client.database);
  if (spec.policy !== "none") {
    await sql`insert into platform.market_data_policies(
      instrument_id, enabled, max_ingestion_age_ms, max_event_age_ms, max_future_skew_ms, jump_reset_ttl_ms
    ) values (${instrumentId}, true, 600000, 600000, 60000, ${spec.jumpResetTtlMs ?? 300000})`.execute(client.database);
  }
  return { instrumentId, symbol };
}

async function fixture(
  client: DatabaseClient,
  suffix: string,
  specs: readonly InstrumentSpec[],
  options: { readonly providerEnabled?: boolean } = {},
): Promise<Fixture> {
  const enabledMarket = await insertMarket(client, `startup-market-${suffix}`, true);
  const disabledMarket = await insertMarket(client, `startup-closed-market-${suffix}`, false);
  const providerId = await insertProvider(client, `startup-provider-${suffix}`, options.providerEnabled ?? true);
  const ids = new Map<string, string>();
  const instruments: { label: string; symbol: string }[] = [];
  for (const spec of specs) {
    const marketId = spec.marketKey === "disabled" ? disabledMarket : enabledMarket;
    const inserted = await insertInstrument(client, { marketId, providerId }, suffix, spec);
    ids.set(spec.label, inserted.instrumentId);
    instruments.push({ label: spec.label, symbol: inserted.symbol });
  }
  return { providerId, ids, configuration: { providerLabel: "coinbase", providerUuid: providerId, instruments } };
}

async function withWriterRole<T>(client: DatabaseClient, action: () => Promise<T>): Promise<T> {
  await sql`set role platform_market_data`.execute(client.database);
  try {
    return await action();
  } finally {
    await sql`reset role`.execute(client.database);
  }
}

async function startup(client: DatabaseClient, data: Fixture): Promise<StartupResult> {
  return withWriterRole(client, async () => {
    const catalog = await loadStartupCatalog(client.database, data.configuration);
    return recoverMarketDataStartup(client.database, catalog.mapping, data.configuration);
  });
}

async function portFor(client: DatabaseClient, data: Fixture): Promise<PostgresPersistencePort> {
  return withWriterRole(client, () => PostgresPersistencePort.fromCatalog(client.database, data.configuration));
}

function symbolOf(data: Fixture, label: string): string {
  const found = data.configuration.instruments.find((item) => item.label === label);
  assert(found !== undefined, `Fixture must configure ${label}.`);
  return found.symbol;
}

function haltRequest(label: string) {
  return {
    providerId: "coinbase",
    instrumentId: label,
    reasonCode: "LOCKED_OR_CROSSED",
    eventAtUs: null,
    tradeId: null,
    providerSequence: null,
    candidatePrice: null,
    candidateSize: null,
    referencePrice: null,
  } as const;
}

async function advisoryLockAllowsSingleWriter(): Promise<void> {
  const independent = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
  independent.on("error", () => undefined);
  await independent.connect();
  const input = { runtimeMode: "test" as const, environment: environment() };
  const scheduler = new RealTimerScheduler();
  let one: AdvisoryLock | undefined;
  try {
    one = await AdvisoryLock.acquire(createAdvisoryLockConnectionFactory(input), scheduler, () => undefined);
    const held = await independent.query<{ readonly locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended('platform.market_data.engine.v1', 0)) as locked",
    );
    assert(held.rows[0]?.locked === false, "Independent connection must observe the named lock held.");
    let refusal: unknown;
    try {
      await AdvisoryLock.acquire(createAdvisoryLockConnectionFactory(input), scheduler, () => undefined);
    } catch (error) {
      refusal = error;
    }
    assert(refusal instanceof AdvisoryLockError && refusal.code === "UNAVAILABLE", "Second writer must refuse.");
    await one.release();
    one = undefined;
    const released = await independent.query<{ readonly locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended('platform.market_data.engine.v1', 0)) as locked",
    );
    assert(released.rows[0]?.locked === true, "Independent connection must acquire after release.");
    await independent.query("select pg_advisory_unlock(hashtextextended('platform.market_data.engine.v1', 0))");
    console.log("advisoryLockAllowsSingleWriter");
  } finally {
    if (one !== undefined) await one.release().catch(() => undefined);
    await independent.end().catch(() => undefined);
  }
}

async function advisoryLockLossAbortsEngine(): Promise<void> {
  const killer = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
  killer.on("error", () => undefined);
  await killer.connect();
  const input = { runtimeMode: "test" as const, environment: environment() };
  const scheduler = new RealTimerScheduler();
  let aborts = 0;
  let lock: AdvisoryLock | undefined;
  try {
    lock = await AdvisoryLock.acquire(createAdvisoryLockConnectionFactory(input), scheduler, () => {
      aborts += 1;
    });
    const holder = await killer.query<{ readonly pid: number }>(`select a.pid
      from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory'
        and l.granted
        and l.objsubid = 1
        and ((l.classid::bigint << 32) + l.objid::bigint) = hashtextextended(
          'platform.market_data.engine.v1', 0
        )`);
    assert(holder.rows.length === 1, "The named advisory lock must identify one backend.");
    const started = Date.now();
    await killer.query("select pg_terminate_backend($1)", [holder.rows[0]!.pid]);
    while (aborts === 0 && Date.now() - started < 700) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(aborts === 1, "Terminated lock connection must abort exactly once within 700 ms, before the next one-second probe.");
    console.log("advisoryLockLossAbortsEngine");
  } finally {
    if (lock !== undefined) await lock.release().catch(() => undefined);
    await killer.end().catch(() => undefined);
  }
}

async function policylessInstrumentIsSkipped(client: DatabaseClient, suffix: string): Promise<void> {
  const data = await fixture(client, suffix, [
    { label: "control" },
    { label: "policyless", policy: "none" },
  ]);
  const result = await startup(client, data);
  assert(result.started.some((item) => item.label === "control"), "The same fixture must start an instrument with a policy.");
  assert(result.skipped.get("policyless") === "NO_POLICY", "An instrument without a policy must be skipped as NO_POLICY.");
  assert(!result.started.some((item) => item.label === "policyless"), "An instrument without a policy must not start.");
  assert(result.failures.size === 0, "A policyless skip is not a failure.");
  console.log("policylessInstrumentIsSkipped");
}

async function disabledScopeInstrumentsAreSkipped(client: DatabaseClient, suffix: string): Promise<void> {
  const data = await fixture(client, suffix, [
    { label: "control" },
    { label: "instrument", instrumentEnabled: false },
    { label: "mapping", mappingEnabled: false },
    { label: "market", marketKey: "disabled" },
  ]);
  const disabledProvider = await fixture(client, `${suffix}p`, [{ label: "provider" }], { providerEnabled: false });
  const configuration: CatalogConfiguration = {
    providerLabel: "coinbase",
    providerUuid: data.providerId,
    instruments: [
      ...data.configuration.instruments,
      ...disabledProvider.configuration.instruments,
      { label: "unmapped", symbol: `UNMAPPED${suffix}-USD` },
    ],
  };
  const combined: Fixture = { providerId: data.providerId, ids: data.ids, configuration };
  const result = await startup(client, combined);
  assert(result.started.length === 1 && result.started[0]?.label === "control", "Only the fully enabled instrument may start.");
  for (const label of ["instrument", "mapping", "market", "provider", "unmapped"]) {
    assert(result.skipped.get(label) === "DISABLED_SCOPE", `A disabled ${label} scope must be skipped as DISABLED_SCOPE.`);
  }
  assert(result.failures.size === 0, "Disabled scopes are skips, not failures.");
  console.log("disabledScopeInstrumentsAreSkipped");
}

async function humanHaltedInstrumentIsSkipped(client: DatabaseClient, suffix: string): Promise<void> {
  const data = await fixture(client, suffix, [{ label: "active" }, { label: "human" }]);
  const before = await startup(client, data);
  assert(before.started.length === 2 && before.humanHalted.size === 0, "Both instruments must start before the halt.");
  const port = await portFor(client, data);
  await withWriterRole(client, () => port.openHalt(haltRequest("human")));
  const result = await startup(client, data);
  assert(result.skipped.get("human") === "HUMAN_HALT", "A human-halted instrument must be skipped.");
  assert(result.humanHalted.has("human") && !result.humanHalted.has("active"), "Only the halted instrument is human-halted.");
  console.log("humanHaltedInstrumentIsSkipped");
}

async function haltOnOneInstrumentDoesNotBlockOtherRestart(client: DatabaseClient, suffix: string): Promise<void> {
  const data = await fixture(client, suffix, [{ label: "active" }, { label: "human" }, { label: "third" }]);
  const port = await portFor(client, data);
  await withWriterRole(client, () => port.openHalt(haltRequest("human")));
  const result = await startup(client, data);
  const started = result.started.map((item) => item.label).sort();
  assert(started.length === 2 && started[0] === "active" && started[1] === "third", "Other instruments must still start.");
  assert(result.skipped.get("human") === "HUMAN_HALT", "The halted instrument must be skipped.");
  console.log("haltOnOneInstrumentDoesNotBlockOtherRestart");
}

async function humanHaltSurvivesRestart(client: DatabaseClient, suffix: string): Promise<void> {
  const data = await fixture(client, suffix, [{ label: "active" }, { label: "human" }]);
  const firstRun = await portFor(client, data);
  await withWriterRole(client, () => firstRun.openHalt(haltRequest("human")));
  const secondRun = await startup(client, data);
  assert(secondRun.humanHalted.has("human"), "A halt opened by a previous run must still latch.");
  assert(secondRun.skipped.get("human") === "HUMAN_HALT", "The halted instrument must not restart.");
  assert(secondRun.started.some((item) => item.label === "active"), "The other instrument must restart.");
  console.log("humanHaltSurvivesRestart");
}

async function startupCatalogAgreesWithPersistenceCatalog(client: DatabaseClient, suffix: string): Promise<void> {
  const data = await fixture(client, suffix, [{ label: "alpha" }, { label: "beta" }]);
  const port = await portFor(client, data);
  await withWriterRole(client, () => port.openHalt(haltRequest("beta")));
  const result = await startup(client, data);
  assert(result.humanHalted.has("beta") && !result.humanHalted.has("alpha"), "Both catalogs must resolve beta to one instrument.");
  const row = await sql<{ readonly instrument_id: string }>`select instrument_id from platform.market_data_halts
    where instrument_id = ${data.ids.get("beta")!}`.execute(client.database);
  assert(row.rows.length === 1, "The halt must be stored under the catalog's beta instrument.");
  console.log("startupCatalogAgreesWithPersistenceCatalog");
}

async function twoProvidersWithTheSameSymbolResolveSeparately(client: DatabaseClient, suffix: string): Promise<void> {
  const first = await fixture(client, suffix, [{ label: "shared" }]);
  const symbol = first.configuration.instruments[0]!.symbol;
  const secondMarket = await insertMarket(client, `startup-second-market-${suffix}`, true);
  const secondProvider = await insertProvider(client, `startup-second-provider-${suffix}`, true);
  const secondInstrument = await sql<{ readonly id: string }>`insert into platform.instruments(
    market_id, instrument_code, enabled, price_increment, size_increment
  ) values (${secondMarket}, ${`startup-second-${suffix}`}, true, '0.01', '0.00000001') returning id`.execute(client.database);
  const secondInstrumentId = secondInstrument.rows[0]!.id;
  await sql`insert into platform.provider_instrument_symbols(provider_id, instrument_id, provider_symbol, enabled)
    values (${secondProvider}, ${secondInstrumentId}, ${symbol}, true)`.execute(client.database);
  await sql`insert into platform.market_data_policies(
    instrument_id, enabled, max_ingestion_age_ms, max_event_age_ms, max_future_skew_ms, jump_reset_ttl_ms
  ) values (${secondInstrumentId}, true, 600000, 600000, 60000, 300000)`.execute(client.database);
  const second: Fixture = {
    providerId: secondProvider,
    ids: new Map([["shared", secondInstrumentId]]),
    configuration: { providerLabel: "coinbase", providerUuid: secondProvider, instruments: first.configuration.instruments },
  };
  for (const data of [first, second]) {
    const catalog = await withWriterRole(client, () => loadStartupCatalog(client.database, data.configuration));
    assert(catalog.mapping?.providerUuid === data.providerId, "Each provider id must resolve to its own provider.");
    assert(
      catalog.mapping.instrumentsByLabel.get("shared") === data.ids.get("shared"),
      "Each provider must resolve the shared symbol to its own instrument.",
    );
    assert((await portFor(client, data)) instanceof PostgresPersistencePort, "The persistence catalog must resolve each provider.");
  }
  const wrong: Fixture = {
    ...first,
    configuration: { ...first.configuration, providerUuid: "00000000-0000-7000-8000-0000000000ff" },
  };
  const none = await withWriterRole(client, () => loadStartupCatalog(client.database, wrong.configuration));
  assert(none.mapping === undefined && none.unresolved.length === 1, "A provider with no mapping resolves nothing.");
  const inspected = await withWriterRole(client, () =>
    recoverMarketDataStartup(client.database, none.mapping, wrong.configuration),
  );
  assert(
    inspected.skipped.get("shared") === "DISABLED_SCOPE",
    "Scope inspection must stay inside the configured provider, not see another provider's active row.",
  );
  let refused = false;
  try {
    await portFor(client, wrong);
  } catch {
    refused = true;
  }
  assert(refused, "The persistence catalog must refuse a provider with no mapping.");
  console.log("twoProvidersWithTheSameSymbolResolveSeparately");
}

async function startupSeedComesFromRealAcceptedObservation(client: DatabaseClient, suffix: string): Promise<void> {
  const data = await fixture(client, suffix, [{ label: "seeded" }, { label: "fresh" }]);
  const port = await portFor(client, data);
  const eventAtUs = ((BigInt(Math.floor(Date.now() / 1000)) - 1n) * 1000n * 1000n + 345123n).toString();
  const result0 = await withWriterRole(client, () => port.appendObservation({
    providerId: "coinbase",
    instrumentId: "seeded",
    providerSymbol: symbolOf(data, "seeded"),
    providerSequence: "1",
    tradeId: "1",
    eventAtUs,
    receivedAt: new Date(),
    bid: "99",
    bidSize: "1",
    ask: "101",
    askSize: "1",
    lastPrice: "100",
    lastSize: "1",
    volume24h: "0",
  }));
  assert(result0.outcome === "ACCEPTED", "The observation must be accepted before it can seed a restart.");
  const result = await startup(client, data);
  const seed = result.recovery.get("seeded");
  assert(seed !== undefined, "An accepted observation must seed the restart.");
  assert(seed.price === "100.000000000000000000", "The seed price must be the stored decimal.");
  const expectedMicros = (BigInt(eventAtUs) / 1000n * 1000n).toString();
  assert(seed.eventTime === expectedMicros, "The seed time must be the stored time truncated to milliseconds.");
  assert(!result.recovery.has("fresh"), "An instrument with no accepted price has no seed.");
  assert(result.started.some((item) => item.label === "fresh"), "An instrument with no state row starts fresh.");
  console.log("startupSeedComesFromRealAcceptedObservation");
}

async function createClearSession(client: DatabaseClient, suffix: string): Promise<{ id: string; secret: string }> {
  const user = await sql<{ readonly id: string }>`insert into platform.users(user_code, enabled)
    values (${`startup-admin-${suffix}`}, true) returning id`.execute(client.database);
  const passwordHash = await createTestPasswordHasher().hash("integration-password");
  await sql`insert into platform.password_credentials(user_id, password_hash, credential_version)
    values (${user.rows[0]!.id}, ${passwordHash}, 1)`.execute(client.database);
  await sql`insert into platform.account_role_assignments(user_id, account_id, role, enabled)
    values (${user.rows[0]!.id}, null, 'SUPER_ADMIN', true)`.execute(client.database);
  const secret = `startup-${suffix}-session-secret-sufficiently-long`;
  const session = await sql<{ readonly id: string }>`select platform.create_auth_session(
    ${user.rows[0]!.id}, ${secret}, 1, clock_timestamp() + interval '30 minutes',
    clock_timestamp() + interval '8 hours'
  ) as id`.execute(client.database);
  return { id: session.rows[0]!.id, secret };
}

async function clearedPriceJump(client: DatabaseClient, data: Fixture, suffix: string): Promise<void> {
  const port = await portFor(client, data);
  const haltId = await withWriterRole(client, () => port.openHalt({
    ...haltRequest("jump"),
    reasonCode: "PRICE_JUMP",
    eventAtUs: "1760698800123456",
    tradeId: "10",
    providerSequence: "10",
    candidatePrice: "125",
    candidateSize: "1",
    referencePrice: "100",
  }));
  const session = await createClearSession(client, suffix);
  await clearMarketDataHalt(client.database, {
    sessionId: session.id,
    sessionSecret: session.secret,
    haltId,
    instrumentId: data.ids.get("jump")!,
    resolutionReason: "synthetic review",
    typedCandidatePrice: "125",
  });
}

async function jumpResetSurvivesRestart(client: DatabaseClient, suffix: string): Promise<void> {
  const data = await fixture(client, suffix, [{ label: "jump" }, { label: "other" }]);
  const before = await startup(client, data);
  assert(before.jumpResets.size === 0, "No reset exists before the clear.");
  await clearedPriceJump(client, data, suffix);
  const result = await startup(client, data);
  const reset = result.jumpResets.get("jump");
  assert(reset !== undefined, "An unexpired reset must load during restart.");
  assert(reset.confirmedPrice === "125.000000000000000000", "The loaded reset must carry the confirmed price.");
  assert(result.started.some((item) => item.label === "jump"), "A cleared instrument must restart.");
  assert(!result.jumpResets.has("other"), "Another instrument has no reset.");
  console.log("jumpResetSurvivesRestart");
}

async function expiredJumpResetIsNotLoaded(client: DatabaseClient, suffix: string): Promise<void> {
  const data = await fixture(client, suffix, [{ label: "jump", jumpResetTtlMs: 1000 }]);
  await clearedPriceJump(client, data, suffix);
  const live = await startup(client, data);
  assert(live.jumpResets.has("jump"), "The reset must load while it is unexpired.");
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const expired = await startup(client, data);
  assert(!expired.jumpResets.has("jump"), "An expired reset must not load.");
  assert(expired.started.some((item) => item.label === "jump"), "The instrument still restarts after expiry.");
  console.log("expiredJumpResetIsNotLoaded");
}

async function main(): Promise<void> {
  const client = createDatabaseClient({ runtimeMode: "test", environment: environment() });
  const suffix = `${process.pid}${Date.now()}`;
  try {
    await sql`drop schema if exists platform cascade`.execute(client.database);
    await runPendingMigrations(client, {
      migrationFolder: path.join(__dirname, "../../packages/database/src/migrations"),
      migrationTableName: `startup_${suffix}`,
      migrationLockTableName: `startup_lock_${suffix}`,
    });
    await advisoryLockAllowsSingleWriter();
    await advisoryLockLossAbortsEngine();
    await policylessInstrumentIsSkipped(client, `${suffix}a`);
    await disabledScopeInstrumentsAreSkipped(client, `${suffix}b`);
    await humanHaltedInstrumentIsSkipped(client, `${suffix}c`);
    await haltOnOneInstrumentDoesNotBlockOtherRestart(client, `${suffix}d`);
    await humanHaltSurvivesRestart(client, `${suffix}e`);
    await startupCatalogAgreesWithPersistenceCatalog(client, `${suffix}f`);
    await startupSeedComesFromRealAcceptedObservation(client, `${suffix}g`);
    await jumpResetSurvivesRestart(client, `${suffix}h`);
    await expiredJumpResetIsNotLoaded(client, `${suffix}i`);
    await twoProvidersWithTheSameSymbolResolveSeparately(client, `${suffix}j`);
  } finally {
    await sql`drop schema if exists platform cascade`.execute(client.database);
    await client.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
