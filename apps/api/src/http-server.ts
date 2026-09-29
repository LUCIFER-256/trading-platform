import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRuntimeConfiguration } from "../../../packages/core/src";
import { createDatabaseClient } from "../../../packages/database/src";
import { createHttpApiServer, parseAllowedOrigins } from "./http";

async function main(): Promise<void> {
  const socketPath = process.env.API_LISTEN_SOCKET;
  if (socketPath === undefined || !path.isAbsolute(socketPath)) throw new Error("API_LISTEN_SOCKET must be an absolute Unix socket path.");
  const runtime = resolveRuntimeConfiguration(process.env.TRADING_MODE);
  if (!runtime.ok) throw new Error("A valid TRADING_MODE is required.");
  fs.rmSync(socketPath, { force: true });
  const database = createDatabaseClient({ runtimeMode: runtime.value.mode, environment: process.env });
  const api = createHttpApiServer({ database: database.database, allowedOrigins: parseAllowedOrigins(process.env.PLATFORM_ALLOWED_ORIGINS) });
  await new Promise<void>((resolve, reject) => api.server.listen(socketPath, () => resolve()).once("error", reject));
  const shutdown = async () => { await api.close(); await database.close(); };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}
void main().catch(() => { process.exitCode = 1; });
