import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { resolveRuntimeConfiguration } from "../../../../packages/core/src";
import { applyMarketDataCatalogManifest, createDatabaseClient } from "../../../../packages/database/src";

function manifestPath(): string {
  const value = process.argv[2];
  if (value === undefined || value.startsWith("-")) throw new Error("A manifest path is required.");
  return path.resolve(value);
}

async function main(): Promise<void> {
  const runtime = resolveRuntimeConfiguration(process.env.TRADING_MODE);
  if (!runtime.ok) throw new Error("A valid TRADING_MODE is required.");
  const manifest = JSON.parse(await readFile(manifestPath(), "utf8")) as unknown;
  const client = createDatabaseClient({ runtimeMode: runtime.value.mode, environment: process.env });
  try {
    await applyMarketDataCatalogManifest(client.database, manifest);
    console.log(JSON.stringify({ applied: true }));
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Catalog manifest application failed."); process.exitCode = 1; });
