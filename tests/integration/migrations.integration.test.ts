import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { sql } from "kysely";
import {
  createDatabaseClient,
  DatabaseMigrationError,
  runPendingMigrations,
  type DatabaseClient,
  type DatabaseEnvironment
} from "../../packages/database/src";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function log(step: string): void {
  console.error(`[CHECKPOINT] ${step}`);
}

function testEnvironment(): DatabaseEnvironment {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (testDatabaseUrl === undefined || testDatabaseUrl.trim() === "") {
    throw new Error("TEST_DATABASE_URL is required for the migration integration test.");
  }
  return {
    TEST_DATABASE_URL: testDatabaseUrl,
    DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE,
    DATABASE_SSL_CA_PATH: process.env.DATABASE_SSL_CA_PATH
  };
}

function createClient(environment: DatabaseEnvironment): DatabaseClient {
  return createDatabaseClient({ runtimeMode: "test", environment });
}

async function assertRelationExists(client: DatabaseClient, name: string, expected: boolean): Promise<void> {
  const result = await sql<{ readonly relation: string | null }>`select to_regclass(${name}) as relation`.execute(client.database);
  assert((result.rows[0]?.relation !== null) === expected, `${name} existence did not match expectation.`);
}

async function assertSchemaExists(client: DatabaseClient, name: string, expected: boolean): Promise<void> {
  const result = await sql<{ readonly exists: boolean }>`select exists(select 1 from information_schema.schemata where schema_name = ${name}) as exists`.execute(client.database);
  assert(result.rows[0]?.exists === expected, `${name} schema existence did not match expectation.`);
}

async function assertRejected(action: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

function assertUuidV7(value: string, message: string): void {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value), message);
}

async function assertCatalogSchema(client: DatabaseClient): Promise<void> {
  const tables = ["platform.markets", "platform.providers", "platform.instruments", "platform.provider_instrument_symbols"];
  for (const table of tables) await assertRelationExists(client, table, true);

  const constraintResult = await sql<{ readonly conname: string; readonly confdeltype: string | null }>`
    select constraint_data.conname, constraint_data.confdeltype
    from (
      select constraint_entry.conname, constraint_entry.confdeltype
      from pg_constraint as constraint_entry
      join pg_class as relation on relation.oid = constraint_entry.conrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'platform'
    ) as constraint_data
  `.execute(client.database);
  const constraints = new Map(constraintResult.rows.map((row) => [row.conname, row.confdeltype]));
  const expectedConstraints = [
    "markets_pkey",
    "markets_market_code_key",
    "markets_market_code_format_check",
    "providers_pkey",
    "providers_provider_code_key",
    "providers_provider_code_format_check",
    "instruments_pkey",
    "instruments_market_id_instrument_code_key",
    "instruments_instrument_code_format_check",
    "instruments_market_id_fkey",
    "provider_instrument_symbols_pkey",
    "provider_instrument_symbols_provider_id_instrument_id_key",
    "provider_instrument_symbols_provider_id_provider_symbol_key",
    "provider_instrument_symbols_provider_id_fkey",
    "provider_instrument_symbols_instrument_id_fkey"
  ];
  for (const name of expectedConstraints) assert(constraints.has(name), `Missing catalog constraint: ${name}`);
  for (const name of [
    "instruments_market_id_fkey",
    "provider_instrument_symbols_provider_id_fkey",
    "provider_instrument_symbols_instrument_id_fkey"
  ]) {
    assert(constraints.get(name) === "r", `${name} must use ON DELETE RESTRICT.`);
  }

  const indexResult = await sql<{ readonly indexname: string }>`
    select indexname from pg_indexes where schemaname = 'platform'
  `.execute(client.database);
  const indexes = new Set(indexResult.rows.map((row) => row.indexname));
  for (const name of [
    "markets_enabled_lookup_idx",
    "instruments_market_enabled_lookup_idx",
    "provider_instrument_symbols_provider_enabled_lookup_idx",
    "provider_instrument_symbols_instrument_enabled_lookup_idx"
  ]) {
    assert(indexes.has(name), `Missing catalog lookup index: ${name}`);
  }

  const columnResult = await sql<{ readonly table_name: string; readonly column_name: string; readonly data_type: string; readonly is_nullable: string; readonly column_default: string | null; readonly collation_name: string | null }>`
    select table_name, column_name, data_type, is_nullable, column_default, collation_name
    from information_schema.columns
    where table_schema = 'platform'
  `.execute(client.database);
  const columns = new Map(columnResult.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  for (const name of ["markets", "providers", "instruments", "provider_instrument_symbols"]) {
    const id = columns.get(`${name}.id`);
    assert(
      id?.data_type === "uuid" && id.is_nullable === "NO" && id.column_default?.includes("uuidv7"),
      `${name}.id must be database-generated UUIDv7.`
    );
  }
  for (const name of ["markets", "instruments", "provider_instrument_symbols"]) {
    const enabled = columns.get(`${name}.enabled`);
    assert(enabled?.data_type === "boolean" && enabled.is_nullable === "NO", `${name}.enabled must be a non-null boolean.`);
  }
  for (const name of ["markets", "providers", "instruments", "provider_instrument_symbols"]) {
    for (const timestamp of ["created_at", "updated_at"]) {
      const column = columns.get(`${name}.${timestamp}`);
      assert(
        column?.data_type === "timestamp with time zone" && column.is_nullable === "NO" && column.column_default !== null,
        `${name}.${timestamp} must be a non-null UTC timestamp with a default.`
      );
    }
  }
  assert(columns.get("provider_instrument_symbols.provider_symbol")?.collation_name === "C", "Provider symbols must use C collation.");

  const triggerResult = await sql<{ readonly tgname: string }>`
    select trigger_entry.tgname
    from pg_trigger as trigger_entry
    join pg_class as relation on relation.oid = trigger_entry.tgrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'platform' and not trigger_entry.tgisinternal
  `.execute(client.database);
  const triggers = new Set(triggerResult.rows.map((row) => row.tgname));
  for (const name of [
    "markets_set_updated_at",
    "providers_set_updated_at",
    "instruments_set_updated_at",
    "provider_instrument_symbols_set_updated_at"
  ]) {
    assert(triggers.has(name), `Missing catalog updated-at trigger: ${name}`);
  }
}

async function assertCatalogConstraints(client: DatabaseClient): Promise<void> {
  const market = await sql<{ readonly id: string }>`
    insert into platform.markets (market_code, enabled) values ('test-market', true) returning id
  `.execute(client.database);
  const marketId = market.rows[0]?.id;
  assert(marketId !== undefined, "Market fixture must be created.");
  assertUuidV7(marketId, "Market fixture must receive a UUIDv7 primary key.");
  const primaryInstrument = await sql<{ readonly id: string }>`
    insert into platform.instruments (market_id, instrument_code, enabled) values (${marketId}, 'test-instrument', true) returning id
  `.execute(client.database);
  const primaryInstrumentId = primaryInstrument.rows[0]?.id;
  assert(primaryInstrumentId !== undefined, "Primary instrument fixture must be created.");
  const secondaryInstrument = await sql<{ readonly id: string }>`
    insert into platform.instruments (market_id, instrument_code, enabled) values (${marketId}, 'test-instrument-alt', true) returning id
  `.execute(client.database);
  const secondaryInstrumentId = secondaryInstrument.rows[0]?.id;
  assert(secondaryInstrumentId !== undefined, "Secondary instrument fixture must be created.");
  const thirdInstrument = await sql<{ readonly id: string }>`
    insert into platform.instruments (market_id, instrument_code, enabled) values (${marketId}, 'test-instrument-third', true) returning id
  `.execute(client.database);
  const thirdInstrumentId = thirdInstrument.rows[0]?.id;
  assert(thirdInstrumentId !== undefined, "Third instrument fixture must be created.");
  const provider = await sql<{ readonly id: string }>`
    insert into platform.providers (provider_code) values ('test-provider') returning id
  `.execute(client.database);
  const providerId = provider.rows[0]?.id;
  assert(providerId !== undefined, "Provider fixture must be created.");
  assertUuidV7(providerId, "Provider fixture must receive a UUIDv7 primary key.");

  const updatedMarket = await sql<{ readonly updated_at: Date }>`
    update platform.markets set updated_at = timestamp '2000-01-01 00:00:00+00' where id = ${marketId} returning updated_at
  `.execute(client.database);
  const updatedAt = updatedMarket.rows[0]?.updated_at;
  assert(
    updatedAt !== undefined && updatedAt.getUTCFullYear() !== 2000,
    "The market updated_at trigger must replace an application-supplied stale timestamp."
  );

  await sql`
    insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol, enabled)
    values (${providerId}, ${primaryInstrumentId}, 'TEST-SYMBOL', true)
  `.execute(client.database);
  await sql`
    insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol, enabled)
    values (${providerId}, ${secondaryInstrumentId}, 'test-symbol', true)
  `.execute(client.database);

  await assertRejected(
    () => sql`insert into platform.instruments (market_id, instrument_code) values ('00000000-0000-7000-8000-000000000001', 'missing-market')`.execute(client.database),
    "An instrument with a missing market must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol) values ('00000000-0000-7000-8000-000000000002', ${primaryInstrumentId}, 'missing-provider')`.execute(client.database),
    "A mapping with a missing provider must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol) values (${providerId}, '00000000-0000-7000-8000-000000000003', 'missing-instrument')`.execute(client.database),
    "A mapping with a missing instrument must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.instruments (market_id, instrument_code) values (${marketId}, 'test-instrument')`.execute(client.database),
    "A duplicate instrument identity must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol) values (${providerId}, ${thirdInstrumentId}, 'TEST-SYMBOL')`.execute(client.database),
    "A duplicate provider symbol must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol) values (${providerId}, ${primaryInstrumentId}, 'another-symbol')`.execute(client.database),
    "A duplicate provider/instrument mapping must be rejected by PostgreSQL."
  );
}

async function main(): Promise<void> {
  log("start");
  const environment = testEnvironment();
  log("environment resolved");
  const nonce = `${process.pid}_${Date.now()}`;
  const migrationDirectory = path.join(__dirname, "../../packages/database/src/migrations");
  const mainClient = createClient(environment);
  log("mainClient created");

  try {
    await mainClient.checkHealth();
    log("checkHealth OK");
    await sql`drop schema if exists platform cascade`.execute(mainClient.database);
    log("drop schema OK");

    const firstRun = await runPendingMigrations(mainClient, {
      migrationFolder: migrationDirectory,
      migrationTableName: `migration_it_main_${nonce}`,
      migrationLockTableName: `migration_it_main_lock_${nonce}`
    });
    log(`firstRun applied=${firstRun.applied.length}`);
    assert(firstRun.applied.length === 2, "A fresh database must apply both platform migrations.");
    await assertSchemaExists(mainClient, "platform", true);
    log("schema exists OK");
    await assertCatalogSchema(mainClient);
    log("catalog schema verified");
    await assertCatalogConstraints(mainClient);
    log("catalog constraints verified");

    const secondRun = await runPendingMigrations(mainClient, {
      migrationFolder: migrationDirectory,
      migrationTableName: `migration_it_main_${nonce}`,
      migrationLockTableName: `migration_it_main_lock_${nonce}`
    });
    log(`secondRun applied=${secondRun.applied.length}`);
    assert(secondRun.applied.length === 0, "A second migration run must have no pending migrations.");

    const atomicDirectory = await mkdtemp(path.join(__dirname, "trading-migrations-atomic-"));
    log("atomicDirectory created");
    try {
      await writeFile(
        path.join(atomicDirectory, "20260923090001_atomicity_probe.js"),
        "exports.up = async (db) => { await db.schema.createTable('platform.atomicity_probe').addColumn('id', 'integer').execute(); throw new Error('intentional migration failure'); };\n"
      );
      log("atomic probe files written");
      let atomicFailure: unknown;
      try {
        await runPendingMigrations(mainClient, {
          migrationFolder: atomicDirectory,
          migrationTableName: `migration_it_atomic_${nonce}`,
          migrationLockTableName: `migration_it_atomic_lock_${nonce}`
        });
      } catch (error) {
        atomicFailure = error;
      }
      log("atomic run resolved");
      assert(atomicFailure instanceof DatabaseMigrationError, "A failing migration must return a safe migration error.");
      await assertRelationExists(mainClient, "platform.atomicity_probe", false);
      log("atomic rollback verified");
    } finally {
      await rm(atomicDirectory, { recursive: true, force: true });
    }

    const concurrentDirectory = await mkdtemp(path.join(__dirname, "trading-migrations-lock-"));
    log("concurrentDirectory created");
    try {
      const concurrentOptions = {
        migrationFolder: concurrentDirectory,
        migrationTableName: `migration_it_lock_${nonce}`,
        migrationLockTableName: `migration_it_lock_lock_${nonce}`
      };
      await runPendingMigrations(mainClient, concurrentOptions);
      log("pre-concurrent run OK");
      await writeFile(
        path.join(concurrentDirectory, "20260923090002_lock_probe.js"),
        "exports.up = async (db) => { await new Promise((r) => setTimeout(r, 200)); await db.schema.createTable('platform.lock_probe').addColumn('id', 'integer').execute(); };\n"
      );
      const concurrentClient = createClient(environment);
      log("concurrentClient created, entering Promise.all");
      try {
        const [firstConcurrent, secondConcurrent] = await Promise.all([
          runPendingMigrations(mainClient, { ...concurrentOptions}),
          runPendingMigrations(concurrentClient, { ...concurrentOptions})
        ]);
        log(`Promise.all resolved: first=${firstConcurrent.applied.length} second=${secondConcurrent.applied.length}`);
        assert(
          firstConcurrent.applied.length + secondConcurrent.applied.length === 1,
          "The Kysely migration lock must permit exactly one concurrent application."
        );
        await assertRelationExists(mainClient, "platform.lock_probe", true);
        log("lock probe verified");
      } finally {
        await concurrentClient.close();
      }
    } finally {
      await rm(concurrentDirectory, { recursive: true, force: true });
    }
  } finally {
    log("closing mainClient");
    await mainClient.close();
  }

  console.log("Migration integration tests passed.");
}

void main().catch((error: unknown) => {
  console.error("[CHECKPOINT] main() rejected:", error);
  throw error;
});
