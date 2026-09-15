import { readFileSync } from "node:fs";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { DatabaseConfigurationInput } from "./config";
import { loadDatabaseConfiguration } from "./config";
import type { DatabaseTransaction, KyselyDatabase } from "./kysely";

export type DatabaseInfrastructureErrorCode =
  | "CONNECTION_FAILURE"
  | "TRANSACTION_FAILURE"
  | "POOL_RESOURCE_FAILURE"
  | "UNEXPECTED_DATABASE_FAILURE";

export type DatabaseClientStatus = "ready" | "degraded" | "closed";
export type DatabaseOperation = "pool" | "health-check" | "transaction" | "shutdown" | "tls";

/**
 * Public database error boundary. It deliberately contains safe classification
 * only: no driver error, connection string, hostname, or arbitrary driver
 * message is retained on the thrown error (including through `cause`).
 */
export class DatabaseInfrastructureError extends Error {
  readonly name = "DatabaseInfrastructureError";
  readonly sqlState: string | undefined;

  constructor(
    readonly code: DatabaseInfrastructureErrorCode,
    message: string,
    readonly operation: DatabaseOperation,
    sqlState?: string
  ) {
    super(message);
    this.sqlState = sqlState;
  }

  toJSON(): Readonly<{
    name: string;
    code: DatabaseInfrastructureErrorCode;
    message: string;
    operation: DatabaseOperation;
    sqlState?: string;
  }> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      operation: this.operation,
      ...(this.sqlState === undefined ? {} : { sqlState: this.sqlState })
    };
  }
}

export interface TransactionRunner {
  withinTransaction<Value>(operation: (database: DatabaseTransaction) => Promise<Value>): Promise<Value>;
}

/** A single explicit owner of one pg pool and the Kysely client backed by it. */
export interface DatabaseClient extends TransactionRunner {
  readonly database: KyselyDatabase;
  getStatus(): DatabaseClientStatus;
  checkHealth(): Promise<void>;
  close(): Promise<void>;
}

interface DatabaseClientDependencies {
  /** Test seam only. Production always constructs node-postgres's Pool here. */
  readonly createPool?: (configuration: PoolConfig) => Pool;
}

/**
 * Creates an explicit database client. Callers own its lifecycle and must call
 * close during graceful application shutdown. There is intentionally no global
 * pool or singleton: each application composition root decides its one owner.
 */
export function createDatabaseClient(
  input: DatabaseConfigurationInput,
  dependencies: DatabaseClientDependencies = {}
): DatabaseClient {
  const configuration = loadDatabaseConfiguration(input);

  try {
    const pool = (dependencies.createPool ?? ((options: PoolConfig) => new Pool(options)))(
      createPoolConfiguration(configuration, input.environment)
    );
    const database = new Kysely<{}>({ dialect: new PostgresDialect({ pool }) });
    const client = new DatabaseClientImplementation(database, configuration);
    // node-postgres emits this for idle-client failures. The listener must not
    // throw: it records a degraded pool for later callers without attributing
    // the asynchronous event to an unrelated in-flight operation.
    pool.on("error", (error: Error) => client.recordPoolError(error));
    return client;
  } catch (error) {
    if (error instanceof DatabaseInfrastructureError) throw error;
    throw new DatabaseInfrastructureError(
      "POOL_RESOURCE_FAILURE",
      "Database pool could not be created.",
      "pool",
      getSafeSqlState(error)
    );
  }
}

class DatabaseClientImplementation implements DatabaseClient {
  private closePromise: Promise<void> | undefined;
  private poolError: DatabaseInfrastructureError | undefined;

  constructor(
    readonly database: KyselyDatabase,
    private readonly configuration: ReturnType<typeof loadDatabaseConfiguration>
  ) {}

  getStatus(): DatabaseClientStatus {
    if (this.closePromise !== undefined) return "closed";
    return this.poolError === undefined ? "ready" : "degraded";
  }

  async checkHealth(): Promise<void> {
    this.assertOpen();
    try {
      await sql<{ readonly one: number }>`select 1 as one`.execute(this.database);
    } catch (error) {
      throw new DatabaseInfrastructureError(
        "CONNECTION_FAILURE",
        "Database connectivity check failed.",
        "health-check",
        getSafeSqlState(error)
      );
    }
  }

  async withinTransaction<Value>(operation: (database: DatabaseTransaction) => Promise<Value>): Promise<Value> {
    this.assertOpen();
    let operationError: unknown;

    try {
      return await this.database.transaction().execute(async (transaction) => {
        await applyTransactionTimeouts(transaction, this.configuration);
        try {
          return await operation(transaction);
        } catch (error) {
          operationError = error;
          throw error;
        }
      });
    } catch (error) {
      // Kysely has already rolled back and released the same checked-out pg
      // client. Preserve callback failures exactly; normalize infrastructure
      // failures so callers can distinguish transaction problems.
      if (error === operationError) throw error;
      throw new DatabaseInfrastructureError(
        "TRANSACTION_FAILURE",
        "Database transaction failed.",
        "transaction",
        getSafeSqlState(error)
      );
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;

    this.closePromise = this.database.destroy().catch((error: unknown) => {
      throw new DatabaseInfrastructureError(
        "POOL_RESOURCE_FAILURE",
        "Database pool could not be closed.",
        "shutdown",
        getSafeSqlState(error)
      );
    });
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closePromise !== undefined) {
      throw new DatabaseInfrastructureError("POOL_RESOURCE_FAILURE", "Database client is closed.", "shutdown");
    }
    if (this.poolError !== undefined) throw this.poolError;
  }

  recordPoolError(error: Error): void {
    if (this.closePromise !== undefined || this.poolError !== undefined) return;
    this.poolError = new DatabaseInfrastructureError(
      "POOL_RESOURCE_FAILURE",
      "Database pool encountered an asynchronous error.",
      "pool",
      getSafeSqlState(error)
    );
  }
}

/**
 * PostgreSQL SQLSTATE values are a bounded diagnostic classification. Driver
 * messages and all other fields are intentionally discarded at this boundary.
 */
function getSafeSqlState(error: unknown): string | undefined {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
    ? error.code
    : undefined;
  return code;
}

function createPoolConfiguration(
  configuration: ReturnType<typeof loadDatabaseConfiguration>,
  environment: DatabaseConfigurationInput["environment"]
): PoolConfig {
  const connectionString = environment[configuration.connectionSource];
  // loadDatabaseConfiguration already validates the selected source. Keep the
  // raw URL local to this driver-construction function and never return it.
  if (connectionString === undefined) {
    throw new DatabaseInfrastructureError(
      "UNEXPECTED_DATABASE_FAILURE",
      "Database connection configuration is unavailable.",
      "pool"
    );
  }

  return {
    connectionString,
    ...(configuration.poolMax === undefined ? {} : { max: configuration.poolMax }),
    ...(configuration.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMillis: configuration.connectionTimeoutMs }),
    ...(configuration.idleTimeoutMs === undefined ? {} : { idleTimeoutMillis: configuration.idleTimeoutMs }),
    ...(configuration.statementTimeoutMs === undefined ? {} : { statement_timeout: configuration.statementTimeoutMs }),
    ...(configuration.applicationName === undefined ? {} : { application_name: configuration.applicationName }),
    ssl: createSslConfiguration(configuration)
  };
}

function createSslConfiguration(configuration: ReturnType<typeof loadDatabaseConfiguration>): PoolConfig["ssl"] {
  if (configuration.ssl.mode === "disable") return false;
  if (configuration.ssl.mode === "require") return { rejectUnauthorized: true };

  try {
    return {
      ca: readFileSync(configuration.ssl.caPath!, "utf8"),
      rejectUnauthorized: true
    };
  } catch (error) {
    throw new DatabaseInfrastructureError(
      "POOL_RESOURCE_FAILURE",
      "Database TLS certificate authority could not be loaded.",
      "tls",
      getSafeSqlState(error)
    );
  }
}

async function applyTransactionTimeouts(
  transaction: DatabaseTransaction,
  configuration: ReturnType<typeof loadDatabaseConfiguration>
): Promise<void> {
  if (configuration.lockTimeoutMs !== undefined) {
    await sql`select set_config('lock_timeout', ${String(configuration.lockTimeoutMs)}, true)`.execute(transaction);
  }
  if (configuration.statementTimeoutMs !== undefined) {
    await sql`select set_config('statement_timeout', ${String(configuration.statementTimeoutMs)}, true)`.execute(transaction);
  }
  if (configuration.transactionTimeoutMs !== undefined) {
    await sql`select set_config('transaction_timeout', ${String(configuration.transactionTimeoutMs)}, true)`.execute(transaction);
  }
}
