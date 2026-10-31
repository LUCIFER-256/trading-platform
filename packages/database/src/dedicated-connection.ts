import { Client, type ClientConfig, type QueryResultRow } from "pg";
import type { DatabaseConfigurationInput } from "./config";
import { loadDatabaseConfiguration } from "./config";
import { createPoolConfiguration } from "./client";

export interface DedicatedConnection {
  query<Row extends QueryResultRow>(statement: string): Promise<readonly Row[]>;
  onLost(listener: () => void): void;
  close(): Promise<void>;
}

export async function createDedicatedConnection(
  input: DatabaseConfigurationInput,
): Promise<DedicatedConnection> {
  const configuration = loadDatabaseConfiguration(input);
  const poolConfiguration = createPoolConfiguration(configuration, input.environment);
  const { max: _max, idleTimeoutMillis: _idleTimeoutMillis, ...clientConfiguration } = poolConfiguration;
  const client = new Client(clientConfiguration as ClientConfig);
  const listeners = new Set<() => void>();
  let lost = false;
  const notifyLost = (): void => {
    if (lost) return;
    lost = true;
    for (const listener of listeners) listener();
  };
  client.on("error", notifyLost);
  client.on("end", notifyLost);
  try {
    await client.connect();
  } catch {
    await client.end().catch(() => undefined);
    throw new Error("Dedicated database connection failed.");
  }
  return {
    async query<Row extends QueryResultRow>(statement: string): Promise<readonly Row[]> {
      const result = await client.query<Row>(statement);
      return result.rows;
    },
    onLost(listener: () => void): void {
      listeners.add(listener);
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
}
