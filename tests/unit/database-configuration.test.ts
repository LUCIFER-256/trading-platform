import {
  DatabaseConfigurationError,
  loadDatabaseConfiguration,
  type DatabaseEnvironment
} from "../../packages/database/src";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function environment(values: DatabaseEnvironment): DatabaseEnvironment {
  return { DATABASE_SSL_MODE: "disable", ...values };
}

function expectConfigurationError(action: () => unknown, expectedCode: string, secret?: string): void {
  try {
    action();
    throw new Error("Expected configuration error.");
  } catch (error) {
    assert(error instanceof DatabaseConfigurationError, "Expected DatabaseConfigurationError.");
    assert(error.code === expectedCode, `Expected ${expectedCode}, received ${error.code}.`);
    if (secret !== undefined) {
      assert(!String(error.message).includes(secret), "Error message must not expose credentials.");
      assert(!JSON.stringify(error).includes(secret), "Serialized error must not expose credentials.");
    }
  }
}

const development = loadDatabaseConfiguration({
  runtimeMode: "development",
  environment: environment({
    DATABASE_URL: "postgresql://user:password@localhost:5432/trading_platform",
    DATABASE_POOL_MAX: "12",
    DATABASE_CONNECTION_TIMEOUT_MS: "5000",
    DATABASE_IDLE_TIMEOUT_MS: "30000",
    DATABASE_STATEMENT_TIMEOUT_MS: "15000",
    DATABASE_LOCK_TIMEOUT_MS: "4000",
    DATABASE_TRANSACTION_TIMEOUT_MS: "20000",
    DATABASE_APPLICATION_NAME: "trading-platform"
  })
});
assert(development.connectionSource === "DATABASE_URL", "Development must use DATABASE_URL.");
assert(development.poolMax === 12, "Pool size must be normalized.");
assert(development.connectionTimeoutMs === 5000, "Timeout must be normalized.");
assert(development.idleTimeoutMs === 30000, "Idle timeout must be normalized.");
assert(development.statementTimeoutMs === 15000, "Statement timeout must be normalized.");
assert(development.lockTimeoutMs === 4000, "Lock timeout must be normalized.");
assert(development.transactionTimeoutMs === 20000, "Transaction timeout must be normalized.");
assert(!JSON.stringify(development).includes("password"), "Serialized configuration must not expose credentials.");

const testConfiguration = loadDatabaseConfiguration({
  runtimeMode: "test",
  environment: environment({
    TEST_DATABASE_URL: "postgresql://test_user:test_password@localhost:5432/trading_platform_test"
  })
});
assert(testConfiguration.connectionSource === "TEST_DATABASE_URL", "Test must use TEST_DATABASE_URL.");

expectConfigurationError(
  () => loadDatabaseConfiguration({ runtimeMode: "paper", environment: environment({}) }),
  "MISSING_DATABASE_URL"
);
expectConfigurationError(
  () => loadDatabaseConfiguration({ runtimeMode: "development", environment: environment({ DATABASE_URL: "https://example.test/db" }) }),
  "INVALID_DATABASE_URL"
);
expectConfigurationError(
  () => loadDatabaseConfiguration({
    runtimeMode: "test",
    environment: environment({ DATABASE_URL: "postgresql://user:password@localhost:5432/application" })
  }),
  "MISSING_TEST_DATABASE_URL",
  "password"
);
expectConfigurationError(
  () => loadDatabaseConfiguration({
    runtimeMode: "development",
    environment: environment({ DATABASE_URL: "postgresql://user:password@localhost:5432/trading", DATABASE_POOL_MAX: "0" })
  }),
  "INVALID_NUMERIC_CONFIGURATION"
);
expectConfigurationError(
  () => loadDatabaseConfiguration({
    runtimeMode: "development",
    environment: environment({ DATABASE_URL: "postgresql://user:password@localhost:5432/trading", DATABASE_LOCK_TIMEOUT_MS: "1.5" })
  }),
  "INVALID_NUMERIC_CONFIGURATION"
);
expectConfigurationError(
  () => loadDatabaseConfiguration({
    runtimeMode: "development",
    environment: { DATABASE_URL: "postgresql://user:password@localhost:5432/trading", DATABASE_SSL_MODE: "verify-full" }
  }),
  "INVALID_SSL_CONFIGURATION"
);

const verifiedSsl = loadDatabaseConfiguration({
  runtimeMode: "development",
  environment: environment({
    DATABASE_URL: "postgresql://user:password@localhost:5432/trading",
    DATABASE_SSL_MODE: "verify-full",
    DATABASE_SSL_CA_PATH: "/tmp/test-ca.pem"
  })
});
assert(verifiedSsl.ssl.mode === "verify-full", "Verified SSL mode must be retained.");
assert(verifiedSsl.ssl.caPath === "/tmp/test-ca.pem", "Verified SSL CA path must be retained.");
expectConfigurationError(
  () => loadDatabaseConfiguration({
    runtimeMode: "development",
    environment: {
      DATABASE_URL: "postgresql://user:password@localhost:5432/trading",
      DATABASE_SSL_MODE: "verify-ca",
      DATABASE_SSL_CA_PATH: "  "
    }
  }),
  "INVALID_SSL_CONFIGURATION"
);
expectConfigurationError(
  () => loadDatabaseConfiguration({
    runtimeMode: "development",
    environment: environment({ DATABASE_URL: "postgresql://user:password@localhost:5432/trading", DATABASE_SSL_CA_PATH: "/tmp/ca.pem" })
  }),
  "INVALID_SSL_CONFIGURATION"
);

console.log("Database configuration unit tests passed.");
