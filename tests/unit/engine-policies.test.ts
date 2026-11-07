import { EnginePolicyError, loadEnginePolicies, type PolicyRepository } from "../../apps/market-data/src/persistence/policies";
import type { CatalogMapping } from "../../apps/market-data/src/persistence/postgres-persistence-port";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const mapping: CatalogMapping = {
  providerId: "coinbase",
  providerUuid: "00000000-0000-4000-8000-0000000000ff",
  instrumentsByLabel: new Map([["btc", A], ["eth", B]]),
  instrumentsBySymbol: new Map([["BTC-USD", A], ["ETH-USD", B]]),
} as CatalogMapping;

type Row = Awaited<ReturnType<PolicyRepository["policyRows"]>>[number];

function row(id: string, overrides: Partial<Record<keyof Row, unknown>> = {}): Row {
  return {
    instrument_id: id,
    enabled: true,
    price_increment: "0.01",
    size_increment: "0.00000001",
    max_initial_event_delay_ms: 5000,
    max_future_skew_ms: 2000,
    max_price_jump_bps: 2000,
    heartbeat_timeout_ms: 5000,
    circuit_failure_threshold: 5,
    circuit_failure_window_ms: 60000,
    circuit_cooldown_ms: 30000,
    circuit_half_open_ready_ms: 10000,
    heartbeat_ahead_count: 4,
    heartbeat_ahead_span_ms: 2500,
    heartbeat_settle_count: 3,
    heartbeat_settle_span_ms: 2000,
    ...overrides,
  } as Row;
}

function repository(rows: readonly Row[]): PolicyRepository {
  return { policyRows: async () => rows };
}

async function refuses(rows: readonly Row[], labels: readonly string[], code: string, repo?: PolicyRepository): Promise<EnginePolicyError> {
  try {
    await loadEnginePolicies({} as never, mapping, labels, repo ?? repository(rows));
  } catch (error) {
    assert(error instanceof EnginePolicyError, "Loader must use its safe error.");
    assert(error.code === code, `Expected ${code}, got ${error.code}.`);
    return error;
  }
  throw new Error(`Loader must refuse with ${code}.`);
}

async function unitEnginePoliciesLoadAndRefuse(): Promise<void> {
  const ok = await loadEnginePolicies({} as never, mapping, ["btc"], repository([row(A), row(B)]));
  const btc = ok.instruments.get("btc");
  assert(btc !== undefined && ok.instruments.size === 1, "Only started labels get instrument policy.");
  assert(
    Number(btc.priceIncrement) === 0.01 && String(btc.priceIncrement) === "0.010000000000000000" && btc.maxPriceJumpBps === 2000,
    "Instrument values must pass through.",
  );
  assert(ok.provider.heartbeatTimeoutMs === 5000, "Provider policy must come from the agreed rows.");
  await refuses([row(A), row(B, { heartbeat_timeout_ms: 6000 })], ["btc"], "DISAGREEMENT");
  const mixed = repository([row(A), row(B, { enabled: false, heartbeat_timeout_ms: 6000 })]);
  const ignored = await loadEnginePolicies({} as never, mapping, ["btc"], mixed);
  assert(ignored.provider.heartbeatTimeoutMs === 5000, "A disabled row must not take part in agreement.");
  await refuses([row(B)], ["btc"], "MISSING");
  await refuses([row(A, { enabled: false })], ["btc"], "MISSING");
  await refuses([row(A)], ["unknown"], "MISSING");
  await refuses([row(A)], [], "MISSING");
  await refuses([row(A, { price_increment: "abc" })], ["btc"], "INVALID");
  await refuses([row(A, { size_increment: "-1" })], ["btc"], "INVALID");
  const failing: PolicyRepository = {
    policyRows: () => Promise.reject(Object.assign(new Error("secret postgres://user:pw@host detail"), { code: "42501" })),
  };
  const database = await refuses([], ["btc"], "DATABASE", failing);
  assert(database.message.includes("42501"), "The SQLSTATE may be reported.");
  assert(!/secret|postgres:|pw@/.test(database.message), "The database message must not leak.");
  const network: PolicyRepository = {
    policyRows: () => Promise.reject(Object.assign(new Error("socket detail"), { code: "EPIPE" })),
  };
  const refused = await refuses([], ["btc"], "DATABASE", network);
  assert(!refused.message.includes("EPIPE") && !refused.message.includes("SQLSTATE"), "A network error code is not a SQLSTATE.");
  console.log("unitEnginePoliciesLoadAndRefuse");
}

let finished = false;

process.on("exit", () => {
  if (!finished) {
    console.error("unitEnginePoliciesLoadAndRefuse did not finish.");
    process.exitCode = 1;
  }
});

unitEnginePoliciesLoadAndRefuse().then(() => {
  finished = true;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
