import { resolveRuntimeConfiguration } from "../../../packages/core/src";
import { runMigrationCommand } from "../../../packages/database/src";

async function main(): Promise<void> {
  const runtime = resolveRuntimeConfiguration(process.env.TRADING_MODE);
  if (!runtime.ok) throw new Error("Migration command requires a valid TRADING_MODE.");

  const report = await runMigrationCommand(runtime.value.mode, process.env);
  console.log(JSON.stringify({ applied: report.applied }));
}

void main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Migration command failed.");
  }
  process.exitCode = 1;
});
