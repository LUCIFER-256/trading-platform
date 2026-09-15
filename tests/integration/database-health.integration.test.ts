import { createDatabaseClient } from "../../packages/database/src";

async function main(): Promise<void> {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (testDatabaseUrl === undefined || testDatabaseUrl.trim() === "") {
    throw new Error("TEST_DATABASE_URL is required for the database integration test.");
  }

  const client = createDatabaseClient({
    runtimeMode: "test",
    environment: {
      TEST_DATABASE_URL: testDatabaseUrl,
      DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE,
      DATABASE_SSL_CA_PATH: process.env.DATABASE_SSL_CA_PATH,
      DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
      DATABASE_CONNECTION_TIMEOUT_MS: process.env.DATABASE_CONNECTION_TIMEOUT_MS,
      DATABASE_IDLE_TIMEOUT_MS: process.env.DATABASE_IDLE_TIMEOUT_MS,
      DATABASE_STATEMENT_TIMEOUT_MS: process.env.DATABASE_STATEMENT_TIMEOUT_MS,
      DATABASE_LOCK_TIMEOUT_MS: process.env.DATABASE_LOCK_TIMEOUT_MS,
      DATABASE_TRANSACTION_TIMEOUT_MS: process.env.DATABASE_TRANSACTION_TIMEOUT_MS,
      DATABASE_APPLICATION_NAME: process.env.DATABASE_APPLICATION_NAME
    }
  });

  try {
    await client.checkHealth();
    console.log("Database health integration test passed.");
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  throw error;
});
