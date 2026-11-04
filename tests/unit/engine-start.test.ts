import { MarketDataEngine, type EngineOptions } from "../../apps/market-data/src/engine";
import { TermsGateError } from "../../apps/market-data/src/terms-gate";
import { assert } from "./support/market-data-wire-helpers";

function forbidden(name: string): never {
  throw new Error(`${name} must not be touched before the terms gate passes.`);
}

function touching(name: string): never {
  return new Proxy({}, { get: () => forbidden(name), apply: () => forbidden(name) }) as never;
}

async function unitEngineStartRefusesBeforeAnyDatabaseOrLockUse(): Promise<void> {
  const logs: string[] = [];
  for (const acknowledgement of [undefined, "", "cleared", "ra1_risk_accepted"]) {
    const options: EngineOptions = {
      database: touching("database"),
      lockConnection: touching("lock"),
      catalog: { providerLabel: "coinbase", instruments: [{ label: "btcusd", symbol: "BTC-USD" }] },
      termsAcknowledgement: acknowledgement,
      endpoint: "wss://example.invalid",
      transport: touching("transport"),
      products: touching("products"),
      clock: touching("clock"),
      scheduler: touching("scheduler"),
      prng: touching("prng"),
      abort: () => forbidden("abort"),
      log: (record) => logs.push(record.event),
    };
    let refused = false;
    try {
      await MarketDataEngine.start(options);
    } catch (error) {
      refused = error instanceof TermsGateError;
    }
    assert(refused, `Engine start must refuse acknowledgement ${String(acknowledgement)} with the terms error.`);
  }
  assert(logs.length === 0, "A refused start must log nothing.");
  console.log("unitEngineStartRefusesBeforeAnyDatabaseOrLockUse");
}

let finished = false;

process.on("exit", () => {
  if (!finished) {
    console.error("unitEngineStartRefusesBeforeAnyDatabaseOrLockUse did not finish.");
    process.exitCode = 1;
  }
});

unitEngineStartRefusesBeforeAnyDatabaseOrLockUse().then(() => {
  finished = true;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
