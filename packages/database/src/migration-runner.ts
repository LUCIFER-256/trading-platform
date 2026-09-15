import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DatabaseClient } from "./client";

type MigrationStatus = "Success" | "Error" | "NotExecuted";
interface MigrationResult {
  readonly migrationName: string;
  readonly status: MigrationStatus;
}
interface MigrationInfo {
  readonly executedAt?: Date;
}
interface MigrationResultSet {
  readonly error?: unknown;
  readonly results?: readonly MigrationResult[];
}
interface KyselyMigrator {
  getMigrations(): Promise<readonly MigrationInfo[]>;
  migrateUp(options: Readonly<{ disableTransactions: false }>): Promise<MigrationResultSet>;
}
interface KyselyMigrationApi {
  readonly Migrator: new (options: Record<string, unknown>) => KyselyMigrator;
  readonly FileMigrationProvider: new (options: Record<string, unknown>) => unknown;
}

// The project emits CommonJS, while Kysely's migration subpath is ESM-only.
// Node 22 loads it at runtime; legacy TypeScript resolution cannot type-resolve
// that subpath, so its narrow local interface is declared above.
const migrationModuleName = "kysely" + "/migration";
const { Migrator, FileMigrationProvider } = require(migrationModuleName) as KyselyMigrationApi;

export const MIGRATION_NAME_PATTERN = /^\d{14}_[a-z][a-z0-9_]*$/;

export class DatabaseMigrationError extends Error {
  readonly name = "DatabaseMigrationError";

  constructor(
    readonly code: "MIGRATION_FAILURE" | "INVALID_MIGRATION_CONFIGURATION",
    message: string,
    readonly migrationName?: string
  ) {
    super(message);
  }

  toJSON(): Readonly<{ name: string; code: string; message: string; migrationName?: string }> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.migrationName === undefined ? {} : { migrationName: this.migrationName })
    };
  }
}

export interface MigrationRunnerOptions {
  /** Production uses the compiled migrations beside this module. Tests may supply an isolated folder. */
  readonly migrationFolder?: string;
  /** Test seam only; production migration metadata names must remain stable. */
  readonly migrationTableName?: string;
  /** Test seam only; production migration lock names must remain stable. */
  readonly migrationLockTableName?: string;
}

export interface MigrationRunReport {
  readonly applied: readonly string[];
}

/**
 * Applies pending migrations one at a time. Each `migrateUp` call uses
 * PostgreSQL transactional DDL and writes its journal row in that same
 * transaction. Never replace this loop with `migrateToLatest`: that wraps a
 * whole pending batch in one transaction rather than one transaction each.
 */
export async function runPendingMigrations(
  client: DatabaseClient,
  options: MigrationRunnerOptions = {}
): Promise<MigrationRunReport> {
  if (client.getStatus() !== "ready") {
    throw new DatabaseMigrationError("MIGRATION_FAILURE", "Database client is not ready for migrations.");
  }

  const migrator = new Migrator({
    db: client.database,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: options.migrationFolder ?? path.join(__dirname, "migrations")
    }),
    allowUnorderedMigrations: false,
    disableTransactions: false,
    ...(options.migrationTableName === undefined ? {} : { migrationTableName: options.migrationTableName }),
    ...(options.migrationLockTableName === undefined ? {} : { migrationLockTableName: options.migrationLockTableName })
  });

  const applied: string[] = [];
  while (true) {
    if (client.getStatus() !== "ready") {
      throw new DatabaseMigrationError("MIGRATION_FAILURE", "Database client became unavailable during migrations.");
    }

    let migrations;
    try {
      migrations = await migrator.getMigrations();
    } catch {
      throw new DatabaseMigrationError("MIGRATION_FAILURE", "Migration state could not be inspected.");
    }
    if (!migrations.some((migration) => migration.executedAt === undefined)) return { applied };

    const result = await migrator.migrateUp({ disableTransactions: false });
    if (result.error !== undefined) {
      throw new DatabaseMigrationError(
        "MIGRATION_FAILURE",
        "Database migration failed.",
        failedMigrationName(result.results)
      );
    }
    const successful = result.results?.find((entry) => entry.status === "Success");
    if (result.results?.length === 0) continue;
    if (successful === undefined) {
      throw new DatabaseMigrationError("MIGRATION_FAILURE", "Migration runner returned an invalid result.");
    }
    applied.push(successful.migrationName);
  }
}

function failedMigrationName(results: readonly MigrationResult[] | undefined): string | undefined {
  return results?.find((entry) => entry.status === "Error")?.migrationName;
}
