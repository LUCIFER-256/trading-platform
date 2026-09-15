import type { RuntimeMode } from "../../core/src";
import { createDatabaseClient } from "./client";
import type { DatabaseEnvironment } from "./config";
import { runPendingMigrations, type MigrationRunReport } from "./migration-runner";

export class LiveMigrationAuthorizationError extends Error {
  readonly name = "LiveMigrationAuthorizationError";

  constructor(message: string) {
    super(message);
  }
}

/**
 * A migration command is explicitly targeted. Live mode additionally requires
 * protected deployment configuration; browser/API request state is never input.
 */
export async function runMigrationCommand(
  runtimeMode: RuntimeMode,
  environment: DatabaseEnvironment
): Promise<MigrationRunReport> {
  assertMigrationTargetAuthorized(runtimeMode, environment);
  const client = createDatabaseClient({ runtimeMode, environment });
  try {
    await client.checkHealth();
    return await runPendingMigrations(client);
  } finally {
    await client.close();
  }
}

export function assertMigrationTargetAuthorized(runtimeMode: RuntimeMode, environment: DatabaseEnvironment): void {
  if (environment.MIGRATION_TARGET !== runtimeMode) {
    throw new LiveMigrationAuthorizationError("Migration target must explicitly match the server runtime mode.");
  }
  if (runtimeMode !== "live") return;

  if (environment.MIGRATIONS_LIVE_APPROVED !== "approved" || !isSafeReleaseId(environment.MIGRATION_RELEASE_ID)) {
    throw new LiveMigrationAuthorizationError("Live migrations require protected deployment approval and a release identifier.");
  }
}

function isSafeReleaseId(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
