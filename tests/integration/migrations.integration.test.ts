import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

async function main(): Promise<void> {
  const environment = testEnvironment();
  const nonce = `${process.pid}_${Date.now()}`;
  const migrationDirectory = path.join(__dirname, "../../packages/database/src/migrations");
  const firstMigration = "20260915090000_create_platform_schema.js";
  const mainClient = createClient(environment);

  try {
    await mainClient.checkHealth();
    // TEST_DATABASE_URL must identify a dedicated disposable database.
    await sql`drop schema if exists platform cascade`.execute(mainClient.database);

    const firstRun = await runPendingMigrations(mainClient, {
      migrationFolder: migrationDirectory,
      migrationTableName: `migration_it_main_${nonce}`,
      migrationLockTableName: `migration_it_main_lock_${nonce}`
    });
    assert(firstRun.applied.length === 1, "A fresh database must apply the platform-schema migration.");
    await assertSchemaExists(mainClient, "platform", true);

    const secondRun = await runPendingMigrations(mainClient, {
      migrationFolder: migrationDirectory,
      migrationTableName: `migration_it_main_${nonce}`,
      migrationLockTableName: `migration_it_main_lock_${nonce}`
    });
    assert(secondRun.applied.length === 0, "A second migration run must have no pending migrations.");

    const atomicDirectory = await mkdtemp(path.join(tmpdir(), "trading-migrations-atomic-"));
    try {
      await copyFile(path.join(migrationDirectory, firstMigration), path.join(atomicDirectory, firstMigration));
      await writeFile(
        path.join(atomicDirectory, "20260915090001_atomicity_probe.js"),
        "exports.up = async (db) => { await db.schema.createTable('atomicity_probe').inSchema('platform').addColumn('id', 'integer').execute(); throw new Error('intentional migration failure'); };\n"
      );
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
      assert(atomicFailure instanceof DatabaseMigrationError, "A failing migration must return a safe migration error.");
      await assertRelationExists(mainClient, "platform.atomicity_probe", false);
    } finally {
      await rm(atomicDirectory, { recursive: true, force: true });
    }

    const concurrentDirectory = await mkdtemp(path.join(tmpdir(), "trading-migrations-lock-"));
    try {
      await copyFile(path.join(migrationDirectory, firstMigration), path.join(concurrentDirectory, firstMigration));
      const concurrentOptions = {
        migrationFolder: concurrentDirectory,
        migrationTableName: `migration_it_lock_${nonce}`,
        migrationLockTableName: `migration_it_lock_lock_${nonce}`
      };
      await runPendingMigrations(mainClient, concurrentOptions);
      await writeFile(
        path.join(concurrentDirectory, "20260915090002_lock_probe.js"),
        "const { sql } = require('kysely'); exports.up = async (db) => { await sql`select pg_sleep(0.2)`.execute(db); await db.schema.createTable('lock_probe').inSchema('platform').addColumn('id', 'integer').execute(); };\n"
      );
      const concurrentClient = createClient(environment);
      try {
        const [firstConcurrent, secondConcurrent] = await Promise.all([
          runPendingMigrations(mainClient, concurrentOptions),
          runPendingMigrations(concurrentClient, concurrentOptions)
        ]);
        assert(
          firstConcurrent.applied.length + secondConcurrent.applied.length === 1,
          "The Kysely migration lock must permit exactly one concurrent application."
        );
        await assertRelationExists(mainClient, "platform.lock_probe", true);
      } finally {
        await concurrentClient.close();
      }
    } finally {
      await rm(concurrentDirectory, { recursive: true, force: true });
    }
  } finally {
    await mainClient.close();
  }

  console.log("Migration integration tests passed.");
}

void main().catch((error: unknown) => {
  throw error;
});
