import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { canonicalDecimal } from "../../../packages/market-data/src";
import { ProviderCircuit, type ProviderPolicy } from "../../../apps/market-data/src/circuit";
import {
  CoinbaseProductAssertions,
  type ProductFetcher,
} from "../../../apps/market-data/src/coinbase/rest-products";
import {
  CircuitEventRelay,
  CoinbaseSession,
  type CircuitRelayEvent,
  type SafeSessionRecord,
} from "../../../apps/market-data/src/coinbase/session";
import { CoinbaseWsTransport } from "../../../apps/market-data/src/coinbase/ws-client";
import { QualityAggregator } from "../../../apps/market-data/src/quality-aggregator";
import { FakeClock, FakeScheduler, InMemoryPersistencePort, SeededPrng } from "./market-data-fakes";

export interface TestPki {
  readonly caPem: string;
  readonly serverKeyPem: string;
  readonly serverCertPem: string;
  readonly unknownCaPem: string;
  readonly unknownCaServerKeyPem: string;
  readonly unknownCaServerCertPem: string;
  cleanup(): void;
}

function openssl(directory: string, args: readonly string[]): void {
  execFileSync("openssl", [...args], { cwd: directory, stdio: "pipe" });
}

function issueAuthority(directory: string, name: string): void {
  openssl(directory, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`]);
  openssl(directory, [
    "req",
    "-x509",
    "-new",
    "-key",
    `${name}.key`,
    "-days",
    "1",
    "-subj",
    `/CN=${name}`,
    "-out",
    `${name}.pem`,
  ]);
}

function issueServer(directory: string, name: string, authority: string): void {
  fs.writeFileSync(
    path.join(directory, `${name}.ext`),
    "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n",
  );
  openssl(directory, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`]);
  openssl(directory, ["req", "-new", "-key", `${name}.key`, "-subj", "/CN=127.0.0.1", "-out", `${name}.csr`]);
  openssl(directory, [
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${authority}.pem`,
    "-CAkey",
    `${authority}.key`,
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    `${name}.ext`,
    "-out",
    `${name}.pem`,
  ]);
}

export function createTestPki(): TestPki {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "md-wire-"));
  try {
    issueAuthority(directory, "ca");
    issueAuthority(directory, "unknown-ca");
    issueServer(directory, "server", "ca");
    issueServer(directory, "unknown-server", "unknown-ca");
    const read = (name: string): string => fs.readFileSync(path.join(directory, name), "utf8");
    return {
      caPem: read("ca.pem"),
      serverKeyPem: read("server.key"),
      serverCertPem: read("server.pem"),
      unknownCaPem: read("unknown-ca.pem"),
      unknownCaServerKeyPem: read("unknown-server.key"),
      unknownCaServerCertPem: read("unknown-server.pem"),
      cleanup(): void {
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after 5000 ms waiting for: ${description}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

export async function settle(milliseconds = 1000): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function turns(count = 50): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

export function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

export function size(values: readonly unknown[]): number {
  return values.length;
}

export function passed(name: string): void {
  console.log(name);
}

export const increment = canonicalDecimal("0.01")!;

export const policy: ProviderPolicy = {
  heartbeatTimeoutMs: 5000,
  circuitFailureThreshold: 5,
  circuitFailureWindowMs: 60000,
  circuitCooldownMs: 30000,
  circuitHalfOpenReadyMs: 10000,
  heartbeatAheadCount: 4,
  heartbeatAheadSpanMs: 2500,
  heartbeatSettleCount: 4,
  heartbeatSettleSpanMs: 3000,
};

export function product(symbol = "BTC-USD"): Record<string, unknown> {
  return {
    id: symbol,
    status: "online",
    trading_disabled: false,
    cancel_only: false,
    limit_only: false,
    post_only: false,
    auction_mode: false,
    status_message: "",
    quote_increment: "0.01",
    base_increment: "0.01",
  };
}

export function ticker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ticker",
    product_id: "BTC-USD",
    sequence: 1,
    trade_id: 1,
    time: "1970-01-01T00:00:00.000000Z",
    best_bid: "1.00",
    best_bid_size: "1.00",
    best_ask: "2.00",
    best_ask_size: "1.00",
    price: "1.00",
    last_size: "1.00",
    volume_24h: "0",
    ...overrides,
  };
}

export function match(id: number, symbol = "BTC-USD"): Record<string, unknown> {
  return {
    type: "match",
    product_id: symbol,
    sequence: id,
    trade_id: id,
    time: "1970-01-01T00:00:00.000000Z",
    price: "1.00",
    size: "1.00",
  };
}

export function heartbeat(symbol: string, sequence: number, lastTradeId: number): Record<string, unknown> {
  return {
    type: "heartbeat",
    product_id: symbol,
    sequence,
    last_trade_id: lastTradeId,
    time: "1970-01-01T00:00:00.000000Z",
  };
}

export interface WireSessionOptions {
  readonly endpoint: string;
  readonly ca?: string;
  readonly instrumentCount?: number;
  readonly ordered?: string[];
}

export interface WireSession {
  readonly clock: FakeClock;
  readonly scheduler: FakeScheduler;
  readonly port: InMemoryPersistencePort;
  readonly session: CoinbaseSession;
  readonly circuit: ProviderCircuit;
  readonly events: CircuitRelayEvent[];
  readonly logs: SafeSessionRecord[];
  readonly restCalls: string[];
  readonly ordered: string[];
}

export function buildWireSession(options: WireSessionOptions): WireSession {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const port = new InMemoryPersistencePort();
  const ordered = options.ordered ?? [];
  const restCalls: string[] = [];
  const events: CircuitRelayEvent[] = [];
  const logs: SafeSessionRecord[] = [];
  const relay = new CircuitEventRelay((event) => events.push(event));
  const circuit = new ProviderCircuit("coinbase", policy, clock, scheduler, port, relay);
  const fetcher: ProductFetcher = {
    async getProduct(productId) {
      restCalls.push(productId);
      ordered.push(`rest:${productId}`);
      return { status: 200, body: product(productId) as never };
    },
  };
  const products = new CoinbaseProductAssertions("coinbase", fetcher, scheduler, port, circuit);
  const count = options.instrumentCount ?? 1;
  const session = new CoinbaseSession({
    providerId: "coinbase",
    endpoint: options.endpoint,
    instruments: Array.from({ length: count }, (_, index) => ({
      instrumentId: index === 0 ? "btc" : "eth",
      symbol: index === 0 ? "BTC-USD" : "ETH-USD",
      priceIncrement: increment,
      sizeIncrement: increment,
      ticker: {
        priceIncrement: increment,
        sizeIncrement: increment,
        maxInitialEventDelayMs: 1000,
        maxFutureSkewMs: 1000,
        maxPriceJumpBps: 100,
      },
    })),
    humanHalted: [],
    transport: new CoinbaseWsTransport(options.ca === undefined ? {} : { ca: options.ca }),
    products,
    circuit,
    relay,
    persistence: port,
    quality: new QualityAggregator(clock),
    clock,
    scheduler,
    prng: new SeededPrng(7),
    correlationId: () => "correlation",
    log: (entry) => logs.push(entry),
  });
  return { clock, scheduler, port, session, circuit, events, logs, restCalls, ordered };
}
