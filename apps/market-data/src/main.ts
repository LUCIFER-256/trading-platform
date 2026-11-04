import { readFileSync } from "node:fs";
import { createDatabaseClient } from "../../../packages/database/src";
import { AdvisoryLockError, createAdvisoryLockConnectionFactory } from "./advisory-lock";
import { HttpsProductFetcher } from "./coinbase/rest-fetcher";
import { CoinbaseWsTransport } from "./coinbase/ws-client";
import { parseEngineEnvironment } from "./engine-config";
import { EngineStartError, MarketDataEngine, type EngineLogRecord } from "./engine";
import { RealClock, RealPrng, RealTimerScheduler } from "./runtime-ports";
import { TermsGateError } from "./terms-gate";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_LOCK_HELD = 3;
export const EXIT_ABORT = 70;

function write(record: EngineLogRecord): void {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

export function failureFields(error: unknown): EngineLogRecord["fields"] {
  if (error instanceof Error && error.name.endsWith("Error") && /^[A-Za-z]+Error$/.test(error.name)) {
    const known = error instanceof AdvisoryLockError
      || error instanceof EngineStartError
      || error instanceof TermsGateError
      || error.name === "EngineConfigurationError"
      || error.name === "EnginePolicyError"
      || error.name === "StartupRecoveryError"
      || error.name === "PostgresPersistenceError";
    if (known) return { name: error.name, message: error.message };
    return { name: error.name };
  }
  return { name: "UnknownFailure" };
}

async function run(): Promise<void> {
  const configuration = parseEngineEnvironment(process.env);
  const ca = configuration.extraCaFile === undefined ? undefined : readFileSync(configuration.extraCaFile);
  const database = createDatabaseClient({ runtimeMode: configuration.runtimeMode, environment: process.env });
  const abort = (): void => {
    write({ event: "abort", fields: { reason: "ADVISORY_LOCK_LOST" } });
    process.exit(EXIT_ABORT);
  };
  let engine: MarketDataEngine | undefined;
  try {
    engine = await MarketDataEngine.start({
      database: database.database,
      lockConnection: createAdvisoryLockConnectionFactory({ runtimeMode: configuration.runtimeMode, environment: process.env }),
      catalog: configuration.catalog,
      termsAcknowledgement: configuration.termsAcknowledgement,
      endpoint: configuration.endpoint,
      transport: new CoinbaseWsTransport(ca === undefined ? {} : { ca }),
      products: new HttpsProductFetcher({ baseUrl: configuration.restBaseUrl, ...(ca === undefined ? {} : { ca }) }),
      clock: new RealClock(),
      scheduler: new RealTimerScheduler(),
      prng: new RealPrng(),
      abort,
      log: write,
      ...(configuration.qualityFlushIntervalMs === undefined ? {} : { qualityFlushIntervalMs: configuration.qualityFlushIntervalMs }),
    });
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
  const started = engine;
  let signalled = false;
  const shutdown = (signal: string): void => {
    if (signalled) process.exit(EXIT_FAILURE);
    signalled = true;
    write({ event: "signal", fields: { signal } });
    void started
      .stop()
      .then(() => database.close())
      .then(() => process.exit(EXIT_OK), () => process.exit(EXIT_FAILURE));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  write({ event: "running", fields: { started: started.summary().started.length } });
}

function fatal(error: unknown): never {
  const code = error instanceof AdvisoryLockError && error.code === "UNAVAILABLE" ? EXIT_LOCK_HELD : EXIT_FAILURE;
  write({ event: "fatal", fields: failureFields(error) });
  process.exit(code);
}

if (require.main === module) {
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  run().catch(fatal);
}
