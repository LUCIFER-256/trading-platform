import { resolveRuntimeConfiguration } from "../../../packages/core/src";
import { createDatabaseClient, sql } from "../../../packages/database/src";
import { createProductionPasswordHasher } from "./auth";
import { requireTtyPassword } from "./terminal";

function userCode(): string { const index = process.argv.indexOf("--user-code"); const value = index < 0 ? undefined : process.argv[index + 1]; if (value === undefined || value.startsWith("--")) throw new Error("--user-code is required."); return value; }
async function main(): Promise<void> {
  if (process.env.PLATFORM_AUTH_BOOTSTRAP !== "enabled") throw new Error("PLATFORM_AUTH_BOOTSTRAP=enabled is required.");
  if (process.env.PLATFORM_PROVISIONING_DATABASE_URL === undefined) throw new Error("PLATFORM_PROVISIONING_DATABASE_URL is required.");
  const password = await requireTtyPassword("New SUPER_ADMIN password: "); const confirmation = await requireTtyPassword("Confirm new SUPER_ADMIN password: ");
  if (password !== confirmation) throw new Error("Password confirmation does not match.");
  const runtime = resolveRuntimeConfiguration(process.env.TRADING_MODE); if (!runtime.ok) throw new Error("A valid TRADING_MODE is required.");
  const database = createDatabaseClient({ runtimeMode: runtime.value.mode, environment: { ...process.env, DATABASE_URL: process.env.PLATFORM_PROVISIONING_DATABASE_URL } });
  try {
    await sql.raw("set role platform_provisioner").execute(database.database);
    const hash = await createProductionPasswordHasher().hash(password);
    const result = await sql<{ readonly id: string }>`select platform.bootstrap_first_super_admin(${userCode()}, ${hash}) as id`.execute(database.database);
    console.log(JSON.stringify({ userId: result.rows[0]?.id }));
  } finally { await database.close(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Bootstrap failed."); process.exitCode = 1; });
