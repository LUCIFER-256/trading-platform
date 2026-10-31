import { canonicalDecimal } from "../../packages/market-data/src";
import { ProviderCircuit, type ProviderPolicy } from "../../apps/market-data/src/circuit";
import { CoinbaseProductAssertions } from "../../apps/market-data/src/coinbase/rest-products";
import { CircuitEventRelay, CoinbaseSession } from "../../apps/market-data/src/coinbase/session";
import type { WireCallbacks, WireTransport } from "../../apps/market-data/src/coinbase/ws-client";
import { QualityAggregator } from "../../apps/market-data/src/quality-aggregator";
import {
  FakeClock,
  FakeScheduler,
  InMemoryPersistencePort,
  SeededPrng,
} from "./support/market-data-fakes";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function turns(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const increment = canonicalDecimal("0.01")!;
const recoveryPrice = canonicalDecimal("1.00")!;
const policy: ProviderPolicy = {
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

class Wire implements WireTransport {
  private callbacks: WireCallbacks | undefined;

  public open(_endpoint: string, callbacks: WireCallbacks): void {
    this.callbacks = callbacks;
    callbacks.opened();
  }

  public subscribe(_symbols: readonly string[]): void {}

  public close(): void {}

  public frame(frame: Record<string, unknown>): void {
    this.callbacks?.message(JSON.stringify(frame));
  }
}

function product(symbol: string): Record<string, unknown> {
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

function ticker(symbol: string, price: string): Record<string, unknown> {
  return {
    type: "ticker",
    product_id: symbol,
    sequence: 2,
    trade_id: 2,
    time: "1970-01-01T00:00:00.000000Z",
    best_bid: "99.00",
    best_bid_size: "1.00",
    best_ask: "101.00",
    best_ask_size: "1.00",
    price,
    last_size: "1.00",
    volume_24h: "0",
  };
}

function tickerAt(symbol: string, price: string, time: string): Record<string, unknown> {
  return { ...ticker(symbol, price), time };
}

function setup(recovery?: ReadonlyMap<string, { readonly price: typeof increment; readonly eventTime: string }>) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const port = new InMemoryPersistencePort();
  const relay = new CircuitEventRelay();
  const circuit = new ProviderCircuit("coinbase", policy, clock, scheduler, port, relay);
  const products = new CoinbaseProductAssertions(
    "coinbase",
    { async getProduct(id) { return { status: 200, body: product(id) as never }; } },
    scheduler,
    port,
    circuit,
  );
  const wire = new Wire();
  const session = new CoinbaseSession({
    providerId: "coinbase",
    endpoint: "wss://synthetic.example",
    instruments: ["btc", "eth"].map((instrumentId) => ({
      instrumentId,
      symbol: instrumentId === "btc" ? "BTC-USD" : "ETH-USD",
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
    ...(recovery === undefined ? {} : { recovery }),
    transport: wire,
    products,
    circuit,
    relay,
    persistence: port,
    quality: new QualityAggregator(clock),
    clock,
    scheduler,
    prng: new SeededPrng(7),
    correlationId: () => "correlation",
  });
  return { port, scheduler, session, wire };
}

async function connect(value: ReturnType<typeof setup>): Promise<void> {
  const pending = value.session.connect();
  await Promise.resolve();
  await Promise.resolve();
  value.scheduler.advanceTo(100);
  await pending;
}

async function recoverySeedChecksFirstTickerAfterRestart(): Promise<void> {
  const seeded = setup(new Map([["btc", { price: recoveryPrice, eventTime: "0" }]]));
  await connect(seeded);
  seeded.wire.frame(ticker("BTC-USD", "2.00"));
  await turns();
  assert(seeded.port.haltRequests[0]?.reasonCode === "PRICE_JUMP", "Seed must halt an out-of-band ticker.");

  const accepted = setup(new Map([["btc", { price: recoveryPrice, eventTime: "0" }]]));
  await connect(accepted);
  accepted.wire.frame(ticker("BTC-USD", "1.00"));
  await turns();
  assert(accepted.port.calls.includes("append:btc"), "Seed must accept an in-band ticker.");

  const unseeded = setup();
  await connect(unseeded);
  unseeded.wire.frame(ticker("BTC-USD", "2.00"));
  await turns();
  assert(unseeded.port.calls.includes("append:btc"), "Without a seed the same ticker must be accepted.");
  console.log("recoverySeedChecksFirstTickerAfterRestart");
}

async function recoverySeedIsPerInstrument(): Promise<void> {
  const first = setup(new Map([["btc", { price: recoveryPrice, eventTime: "0" }]]));
  await connect(first);
  first.wire.frame(ticker("BTC-USD", "2.00"));
  first.wire.frame(ticker("ETH-USD", "2.00"));
  await turns();
  assert(first.port.haltRequests.length === 1, "Only the seeded instrument may halt.");
  assert(first.port.haltRequests[0]?.instrumentId === "btc", "A btc seed must halt btc.");
  assert(first.port.calls.includes("append:eth"), "A btc seed must not apply to eth.");
  const second = setup(new Map([["eth", { price: recoveryPrice, eventTime: "0" }]]));
  await connect(second);
  second.wire.frame(ticker("BTC-USD", "2.00"));
  second.wire.frame(ticker("ETH-USD", "2.00"));
  await turns();
  assert(second.port.haltRequests.length === 1, "Only the seeded instrument may halt.");
  assert(second.port.haltRequests[0]?.instrumentId === "eth", "An eth seed must halt eth.");
  assert(second.port.calls.includes("append:btc"), "An eth seed must not apply to btc.");
  console.log("recoverySeedIsPerInstrument");
}

async function absentRecoveryChangesNothing(): Promise<void> {
  const value = setup();
  await connect(value);
  value.wire.frame(ticker("BTC-USD", "1.00"));
  await turns();
  assert(value.port.calls.includes("append:btc"), "Absent recovery must preserve baseline behavior.");
  console.log("absentRecoveryChangesNothing");
}

async function startupSeedTruncatesEventTimeToMilliseconds(): Promise<void> {
  const value = setup(new Map([["btc", { price: recoveryPrice, eventTime: "0" }]]));
  await connect(value);
  value.wire.frame(tickerAt("BTC-USD", "1.00", "1970-01-01T00:00:00.000001Z"));
  await turns();
  assert(value.port.calls.includes("append:btc"), "A ticker one microsecond after the startup seed must be accepted.");
  console.log("startupSeedTruncatesEventTimeToMilliseconds");
}

void recoverySeedChecksFirstTickerAfterRestart()
  .then(recoverySeedIsPerInstrument)
  .then(absentRecoveryChangesNothing)
  .then(startupSeedTruncatesEventTimeToMilliseconds)
  .catch((error: unknown) => {
    throw error;
  });
