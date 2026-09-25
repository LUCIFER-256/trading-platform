import { open, stat } from "node:fs/promises";
import * as path from "node:path";
import { resolveRuntimeConfiguration } from "../../../packages/core/src";
import { createDatabaseClient, sql } from "../../../packages/database/src";
import { authenticateAndCreateCommandSession, createOpaqueSecret, revokeCommandSession } from "./auth";
import { requireTtyPassword } from "./terminal";

function argument(name: string): string {
  const index = process.argv.indexOf(name); const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}
async function main(): Promise<void> {
  const target = argument("--target-user-code"); const outputPath = path.resolve(argument("--token-output"));
  const parent = await stat(path.dirname(outputPath));
  if ((parent.mode & 0o077) !== 0) throw new Error("The token output directory must not be group/world accessible.");
  const runtime = resolveRuntimeConfiguration(process.env.TRADING_MODE); if (!runtime.ok) throw new Error("A valid TRADING_MODE is required.");
  const database = createDatabaseClient({ runtimeMode: runtime.value.mode, environment: process.env });
  let session: Awaited<ReturnType<typeof authenticateAndCreateCommandSession>>;
  try {
    const issuer = await requireTtyPassword("SUPER_ADMIN user code: "); const password = await requireTtyPassword("SUPER_ADMIN password: ");
    session = await authenticateAndCreateCommandSession(database.database, issuer, password);
    if (session === undefined) throw new Error("Authentication failed.");
    const secret = createOpaqueSecret();
    const result = await sql<{ readonly id: string }>`select platform.issue_password_reset(${session.sessionId}, ${session.sessionSecret}, ${target}, ${secret}) as id`.execute(database.database);
    const file = await open(outputPath, "wx", 0o600); try { await file.writeFile(secret + "\n"); } finally { await file.close(); }
    console.log(JSON.stringify({ targetUserCode: target, auditEvent: result.rows[0]?.id }));
  } finally { if (session !== undefined) await revokeCommandSession(database.database, session.sessionId); await database.close(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Password reset issuance failed."); process.exitCode = 1; });
