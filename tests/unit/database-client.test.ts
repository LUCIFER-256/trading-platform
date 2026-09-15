import {
  createDatabaseClient,
  DatabaseInfrastructureError,
  type DatabaseEnvironment
} from "../../packages/database/src";
import { EventEmitter } from "node:events";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSafePublicError(
  error: unknown,
  expectedCode: DatabaseInfrastructureError["code"],
  expectedOperation: DatabaseInfrastructureError["operation"]
): asserts error is DatabaseInfrastructureError {
  assert(error instanceof DatabaseInfrastructureError, "Database failures must use the public infrastructure error.");
  assert(error.code === expectedCode, "Database failures must preserve the safe error category.");
  assert(error.operation === expectedOperation, "Database failures must preserve safe operation context.");
  assert(!("cause" in error), "Public database errors must not expose a raw driver error through cause.");

  const publicSurface = JSON.stringify(error.toJSON()) + String(error) + JSON.stringify(error);
  for (const unsafeValue of ["secret", "raw-password", "db.internal.example", "arbitrary driver message"]) {
    assert(!publicSurface.includes(unsafeValue), `Public database errors must not expose ${unsafeValue}.`);
  }
}

interface FakeQueryResult {
  readonly command: "SELECT" | "BEGIN" | "COMMIT" | "ROLLBACK";
  readonly rowCount: number;
  readonly rows: readonly { readonly one?: number }[];
}

class FakePgClient {
  readonly calls: string[] = [];
  released = false;
  failNextQuery: Error | undefined;

  async query(query: string, _parameters: readonly unknown[] = []): Promise<FakeQueryResult> {
    this.calls.push(query.toLowerCase());
    if (this.failNextQuery !== undefined) {
      const error = this.failNextQuery;
      this.failNextQuery = undefined;
      throw error;
    }

    const command = query.trim().split(/\s+/, 1)[0]!.toUpperCase() as FakeQueryResult["command"];
    return {
      command,
      rowCount: command === "SELECT" ? 1 : 0,
      rows: command === "SELECT" ? [{ one: 1 }] : []
    };
  }

  release(): void {
    this.released = true;
  }
}

class FakePgPool extends EventEmitter {
  readonly options = {};
  readonly clients: FakePgClient[] = [];
  endCalls = 0;
  failNextConnectedClientQuery: Error | undefined;

  async connect(): Promise<FakePgClient> {
    const client = new FakePgClient();
    if (this.failNextConnectedClientQuery !== undefined) {
      client.failNextQuery = this.failNextConnectedClientQuery;
      this.failNextConnectedClientQuery = undefined;
    }
    this.clients.push(client);
    return client;
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }

  emitPoolError(error: Error): void {
    this.emit("error", error);
  }
}

function environment(values: DatabaseEnvironment = {}): DatabaseEnvironment {
  return {
    DATABASE_URL: "postgresql://user:password@localhost:5432/trading_platform",
    DATABASE_SSL_MODE: "disable",
    ...values
  };
}

function createFakeClient(values: DatabaseEnvironment = {}): {
  readonly pool: FakePgPool;
  readonly client: ReturnType<typeof createDatabaseClient>;
} {
  const pool = new FakePgPool();
  let receivedOptions: Record<string, unknown> | undefined;
  const client = createDatabaseClient(
    { runtimeMode: "development", environment: environment(values) },
    {
      createPool: (options) => {
        receivedOptions = options as Record<string, unknown>;
        return pool as never;
      }
    }
  );
  if (values.DATABASE_POOL_MAX !== undefined) {
    assert(receivedOptions?.max === Number(values.DATABASE_POOL_MAX), "Pool maximum must reach node-postgres.");
  }
  if (values.DATABASE_CONNECTION_TIMEOUT_MS !== undefined) {
    assert(
      receivedOptions?.connectionTimeoutMillis === Number(values.DATABASE_CONNECTION_TIMEOUT_MS),
      "Connection timeout must reach node-postgres."
    );
  }
  if (values.DATABASE_IDLE_TIMEOUT_MS !== undefined) {
    assert(receivedOptions?.idleTimeoutMillis === Number(values.DATABASE_IDLE_TIMEOUT_MS), "Idle timeout must reach node-postgres.");
  }
  if (values.DATABASE_STATEMENT_TIMEOUT_MS !== undefined) {
    assert(receivedOptions?.statement_timeout === Number(values.DATABASE_STATEMENT_TIMEOUT_MS), "Statement timeout must reach node-postgres.");
  }
  assert(receivedOptions?.ssl === false, "Disabled SSL must explicitly reach node-postgres.");
  return { pool, client };
}

async function main(): Promise<void> {
const lifecycle = createFakeClient({
  DATABASE_POOL_MAX: "7",
  DATABASE_CONNECTION_TIMEOUT_MS: "1200",
  DATABASE_IDLE_TIMEOUT_MS: "3400",
  DATABASE_STATEMENT_TIMEOUT_MS: "5600"
});
await lifecycle.client.checkHealth();
const lifecycleHealthClient = lifecycle.pool.clients[0]!;
assert(lifecycleHealthClient.calls.some((query) => query.includes("select 1 as one")), "Health must execute SELECT 1.");
assert(lifecycleHealthClient.released, "Health-check connection must be released.");
await lifecycle.client.close();
await lifecycle.client.close();
await lifecycle.client.close();
assert(lifecycle.pool.endCalls === 1, "Repeated close calls must end the pool exactly once.");
const lifecycleClientCount = lifecycle.pool.clients.length;
let postCloseError: unknown;
try {
  await lifecycle.client.checkHealth();
} catch (error) {
  postCloseError = error;
}
assert(postCloseError instanceof DatabaseInfrastructureError, "Operations after close must fail through the infrastructure guard.");
assert(postCloseError.code === "POOL_RESOURCE_FAILURE", "Post-close errors must be classified as pool-resource failures.");
assert(lifecycle.pool.clients.length === lifecycleClientCount, "Post-close operations must not acquire a database client.");

const successfulTransaction = createFakeClient();
const value = await successfulTransaction.client.withinTransaction(async (transaction) => {
  assert(transaction !== successfulTransaction.client.database, "Callback must receive transaction-scoped database context.");
  return "committed";
});
assert(value === "committed", "Transaction must return callback value.");
assert(successfulTransaction.pool.clients.length === 1, "A transaction must acquire exactly one physical client.");
const successfulTransactionClient = successfulTransaction.pool.clients[0]!;
assert(successfulTransactionClient.calls[0] === "begin", "Transaction must begin before the callback.");
assert(successfulTransactionClient.calls[1] === "commit", "Transaction must commit after a successful callback.");
assert(successfulTransactionClient.released, "Successful transaction client must be released.");
await successfulTransaction.client.close();

const configuredTransaction = createFakeClient({
  DATABASE_LOCK_TIMEOUT_MS: "4000",
  DATABASE_STATEMENT_TIMEOUT_MS: "5000",
  DATABASE_TRANSACTION_TIMEOUT_MS: "6000"
});
await configuredTransaction.client.withinTransaction(async () => "configured");
assert(
  configuredTransaction.pool.clients[0]!.calls.filter((query) => query.includes("set_config")).length === 3,
  "Configured transaction timeouts must be applied on the transaction connection."
);
await configuredTransaction.client.close();

const failedTransaction = createFakeClient();
const originalError = new Error("original callback failure");
let observedError: unknown;
try {
  await failedTransaction.client.withinTransaction(async () => {
    throw originalError;
  });
} catch (error) {
  observedError = error;
}
assert(observedError === originalError, "Transaction must preserve the original callback error.");
assert(failedTransaction.pool.clients.length === 1, "Failed transaction must stay on one physical client.");
const failedTransactionClient = failedTransaction.pool.clients[0]!;
assert(failedTransactionClient.calls[0] === "begin", "Failed transaction must begin.");
assert(failedTransactionClient.calls[1] === "rollback", "Failed transaction must roll back.");
assert(failedTransactionClient.released, "Failed transaction client must be released.");
await failedTransaction.client.close();

const rollbackFailureTransaction = createFakeClient();
const callbackFailure = new Error("original callback failure before rollback");
const rollbackFailure = Object.assign(new Error("rollback connection failure"), { code: "08006" });
let observedDoubleFailure: unknown;
try {
  await rollbackFailureTransaction.client.withinTransaction(async () => {
    rollbackFailureTransaction.pool.clients[0]!.failNextQuery = rollbackFailure;
    throw callbackFailure;
  });
} catch (error) {
  observedDoubleFailure = error;
}
assertSafePublicError(observedDoubleFailure, "TRANSACTION_FAILURE", "transaction");
assert(observedDoubleFailure.sqlState === "08006", "Rollback failure SQLSTATE must be retained safely.");
assert(
  observedDoubleFailure !== callbackFailure,
  "A rollback failure must replace the callback failure at Kysely's transaction boundary."
);
assert(rollbackFailureTransaction.pool.clients[0]!.calls[1] === "rollback", "Rollback must still be attempted after callback failure.");
assert(rollbackFailureTransaction.pool.clients[0]!.released, "A rollback-failed transaction client must still be released.");
await rollbackFailureTransaction.client.close();

const failedHealth = createFakeClient();
const connectionError = Object.assign(
  new Error("arbitrary driver message: postgresql://user:raw-password@db.internal.example:5432/trading_platform"),
  { code: "08006", host: "db.internal.example", password: "raw-password" }
);
failedHealth.pool.failNextConnectedClientQuery = connectionError;
let observedHealthError: unknown;
try {
  await failedHealth.client.checkHealth();
} catch (error) {
  observedHealthError = error;
}
assertSafePublicError(observedHealthError, "CONNECTION_FAILURE", "health-check");
assert(observedHealthError.sqlState === "08006", "Health failures must retain a valid PostgreSQL SQLSTATE.");
assert(failedHealth.pool.clients[0]!.released, "Failed health-check connection must be released.");
await failedHealth.client.close();

const failedInfrastructureTransaction = createFakeClient();
failedInfrastructureTransaction.pool.failNextConnectedClientQuery = connectionError;
let observedTransactionError: unknown;
try {
  await failedInfrastructureTransaction.client.withinTransaction(async () => "unreachable");
} catch (error) {
  observedTransactionError = error;
}
assertSafePublicError(observedTransactionError, "TRANSACTION_FAILURE", "transaction");
assert(observedTransactionError.sqlState === "08006", "Transaction failures must retain a valid PostgreSQL SQLSTATE.");
await failedInfrastructureTransaction.client.close();

const backgroundFailure = createFakeClient();
const backgroundPoolError = Object.assign(
  new Error("postgresql://user:secret@localhost:5432/trading_platform"),
  { code: "08006" }
);
backgroundFailure.pool.emitPoolError(backgroundPoolError);
assert(backgroundFailure.client.getStatus() === "degraded", "Pool error must degrade the database client.");
let degradedHealthError: unknown;
try {
  await backgroundFailure.client.checkHealth();
} catch (error) {
  degradedHealthError = error;
}
assertSafePublicError(degradedHealthError, "POOL_RESOURCE_FAILURE", "pool");
assert(degradedHealthError.sqlState === "08006", "A valid PostgreSQL SQLSTATE must be retained for diagnosis.");
assert(backgroundFailure.pool.clients.length === 0, "A degraded client must not start an unrelated database operation.");
await backgroundFailure.client.close();
assert(backgroundFailure.client.getStatus() === "closed", "Closing a degraded client must remain deterministic.");

const tlsPool = new FakePgPool();
let tlsOptions: Record<string, unknown> | undefined;
const tlsClient = createDatabaseClient(
  {
    runtimeMode: "development",
    environment: environment({ DATABASE_SSL_MODE: "require" })
  },
  {
    createPool: (options) => {
      tlsOptions = options as Record<string, unknown>;
      return tlsPool as never;
    }
  }
);
assert(
  (tlsOptions?.ssl as { readonly rejectUnauthorized?: boolean }).rejectUnauthorized === true,
  "Required SSL must enable certificate verification explicitly."
);
await tlsClient.close();

console.log("Database client unit tests passed.");
}

void main().catch((error: unknown) => {
  throw error;
});
