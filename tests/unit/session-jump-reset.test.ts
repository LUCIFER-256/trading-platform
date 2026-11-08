import { canonicalDecimal } from "../../packages/market-data/src";
import { EngineStartError, sessionJumpResets } from "../../apps/market-data/src/engine";
import { ProviderCircuit, type ProviderPolicy } from "../../apps/market-data/src/circuit";
import { CoinbaseProductAssertions } from "../../apps/market-data/src/coinbase/rest-products";
import { CircuitEventRelay, CoinbaseSession } from "../../apps/market-data/src/coinbase/session";
import type { WireCallbacks, WireTransport } from "../../apps/market-data/src/coinbase/ws-client";
import { QualityAggregator } from "../../apps/market-data/src/quality-aggregator";
import { FakeClock, FakeScheduler, InMemoryPersistencePort, SeededPrng } from "./support/market-data-fakes";

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

function ticker(symbol: string, price: string, tradeId = 2): Record<string, unknown> {
  return {
    type: "ticker",
    product_id: symbol,
    sequence: tradeId,
    trade_id: tradeId,
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

type Reset = { readonly confirmedPrice: typeof increment; readonly expiresAtMs: number };

function setup(
  recovery: ReadonlyMap<string, { readonly price: typeof increment; readonly eventTime: string }>,
  jumpResets?: ReadonlyMap<string, Reset>,
) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const port = new InMemoryPersistencePort();
  const relay = new CircuitEventRelay();
  const circuit = new ProviderCircuit("coinbase", policy, clock, scheduler, port, relay);
  const products = new CoinbaseProductAssertions(
    "coinbase",
    {
      async getProduct(id) {
        return { status: 200, body: product(id) as never };
      },
    },
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
    recovery,
    ...(jumpResets === undefined ? {} : { jumpResets }),
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
  return { port, scheduler, session, wire, clock };
}

async function connect(value: ReturnType<typeof setup>): Promise<void> {
  const pending = value.session.connect();
  await Promise.resolve();
  await Promise.resolve();
  value.scheduler.advanceTo(100);
  await pending;
}

const seed = (instrument: string): ReadonlyMap<string, { readonly price: typeof increment; readonly eventTime: string }> =>
  new Map([[instrument, { price: recoveryPrice, eventTime: "0" }]]);
const reset = (instrument: string, expiresAtMs: number): ReadonlyMap<string, Reset> =>
  new Map([[instrument, { confirmedPrice: canonicalDecimal("2.00")!, expiresAtMs }]]);

async function confirmedResetIsTheFirstReference(): Promise<void> {
  const control = setup(seed("btc"));
  await connect(control);
  control.wire.frame(ticker("BTC-USD", "2.00"));
  await turns();
  assert(control.port.haltRequests[0]?.reasonCode === "PRICE_JUMP", "Without a reset the jump must halt.");

  const active = setup(seed("btc"), reset("btc", 60_000));
  await connect(active);
  active.wire.frame(ticker("BTC-USD", "2.00"));
  await turns();
  assert(active.port.haltRequests.length === 0, "A tick at the confirmed price must not halt under an active reset.");
  assert(active.port.calls.includes("append:btc"), "A tick at the confirmed price must reach persistence.");
  console.log("confirmedResetIsTheFirstReference");
}

async function resetDoesNotWidenTheBand(): Promise<void> {
  const away = setup(seed("btc"), reset("btc", 60_000));
  await connect(away);
  away.wire.frame(ticker("BTC-USD", "1.00"));
  await turns();
  assert(away.port.haltRequests[0]?.reasonCode === "PRICE_JUMP", "A tick back at the old price must halt under a reset.");
  assert(
    away.port.haltRequests[0]?.referencePrice === canonicalDecimal("2.00"),
    "The halt must name the confirmed price as reference.",
  );
  const far = setup(seed("btc"), reset("btc", 60_000));
  await connect(far);
  far.wire.frame(ticker("BTC-USD", "4.00"));
  await turns();
  assert(far.port.haltRequests[0]?.reasonCode === "PRICE_JUMP", "A tick far from the confirmed price must halt.");
  assert(!far.port.calls.includes("append:btc"), "A halted tick must not be persisted.");
  console.log("resetDoesNotWidenTheBand");
}

async function expiredResetIsIgnored(): Promise<void> {
  const value = setup(seed("btc"), reset("btc", 1));
  await connect(value);
  value.wire.frame(ticker("BTC-USD", "2.00"));
  await turns();
  assert(value.port.haltRequests[0]?.reasonCode === "PRICE_JUMP", "An expired reset must not suppress the jump halt.");
  assert(value.port.haltRequests[0]?.referencePrice === recoveryPrice, "An expired reset must leave the seed as reference.");
  console.log("expiredResetIsIgnored");
}

async function resetIsUsedOnce(): Promise<void> {
  const value = setup(seed("btc"), reset("btc", 60_000));
  await connect(value);
  value.wire.frame(ticker("BTC-USD", "2.01", 2));
  await turns();
  assert(value.port.calls.filter((call) => call === "append:btc").length === 1, "The first tick must be accepted.");
  value.wire.frame(ticker("BTC-USD", "2.03", 3));
  await turns();
  assert(value.port.haltRequests.length === 0, "After acceptance the reference is the accepted price, so 2.03 is in band.");
  assert(value.port.calls.filter((call) => call === "append:btc").length === 2, "The second tick must be accepted.");
  value.wire.frame(ticker("BTC-USD", "4.00", 4));
  await turns();
  assert(value.port.haltRequests[0]?.reasonCode === "PRICE_JUMP", "A later jump must halt.");
  assert(
    value.port.haltRequests[0]?.referencePrice === canonicalDecimal("2.03"),
    "The reference after use must be the last accepted price.",
  );
  console.log("resetIsUsedOnce");
}

async function resetIsPerInstrument(): Promise<void> {
  const value = setup(
    new Map([
      ["btc", { price: recoveryPrice, eventTime: "0" }],
      ["eth", { price: recoveryPrice, eventTime: "0" }],
    ]),
    reset("btc", 60_000),
  );
  await connect(value);
  value.wire.frame(ticker("ETH-USD", "2.00"));
  value.wire.frame(ticker("BTC-USD", "2.00"));
  await turns();
  assert(value.port.calls.includes("append:btc"), "The reset must apply to btc.");
  assert(
    value.port.haltRequests.length === 1 && value.port.haltRequests[0]?.instrumentId === "eth",
    "The reset must not apply to eth.",
  );
  console.log("resetIsPerInstrument");
}

async function resetForTheSecondInstrumentOnly(): Promise<void> {
  const value = setup(
    new Map([
      ["btc", { price: recoveryPrice, eventTime: "0" }],
      ["eth", { price: recoveryPrice, eventTime: "0" }],
    ]),
    reset("eth", 60_000),
  );
  await connect(value);
  value.wire.frame(ticker("BTC-USD", "2.00"));
  value.wire.frame(ticker("ETH-USD", "2.00"));
  await turns();
  assert(value.port.calls.includes("append:eth"), "A reset held only for eth must apply to eth.");
  assert(
    value.port.haltRequests.length === 1 && value.port.haltRequests[0]?.instrumentId === "btc",
    "A reset held only for eth must not apply to btc.",
  );
  console.log("resetForTheSecondInstrumentOnly");
}

async function resetsForBothInstrumentsApplyIndependently(): Promise<void> {
  const both = new Map([...reset("btc", 60_000), ...reset("eth", 60_000)]);
  const value = setup(
    new Map([
      ["btc", { price: recoveryPrice, eventTime: "0" }],
      ["eth", { price: recoveryPrice, eventTime: "0" }],
    ]),
    both,
  );
  await connect(value);
  value.wire.frame(ticker("ETH-USD", "2.00"));
  value.wire.frame(ticker("BTC-USD", "2.00"));
  await turns();
  const beforeSecondJump: number = value.port.haltRequests.length;
  assert(beforeSecondJump === 0, "Both instruments hold a reset, so neither may halt.");
  assert(value.port.calls.includes("append:btc") && value.port.calls.includes("append:eth"), "Both ticks must persist.");
  value.wire.frame(ticker("BTC-USD", "9.00", 3));
  await turns();
  assert(
    value.port.haltRequests.length === 1 && value.port.haltRequests[0]?.instrumentId === "btc",
    "Each reset is consumed on its own: btc's second jump halts after its reset was used.",
  );
  console.log("resetsForBothInstrumentsApplyIndependently");
}

async function expiryBoundaryIsExclusive(): Promise<void> {
  const atNow = setup(seed("btc"));
  await connect(atNow);
  const now = atNow.clock.nowMs();
  const expired = setup(seed("btc"), reset("btc", now));
  await connect(expired);
  assert(expired.clock.nowMs() === now, "Both sessions must be at the same clock time.");
  expired.wire.frame(ticker("BTC-USD", "2.00"));
  await turns();
  assert(expired.port.haltRequests[0]?.reasonCode === "PRICE_JUMP", "A reset expiring exactly now is expired.");
  const live = setup(seed("btc"), reset("btc", now + 1));
  await connect(live);
  live.wire.frame(ticker("BTC-USD", "2.00"));
  await turns();
  assert(live.port.haltRequests.length === 0, "A reset expiring one millisecond from now is still active.");
  console.log("expiryBoundaryIsExclusive");
}

async function rejectedTickDoesNotConsumeReset(): Promise<void> {
  const value = setup(seed("btc"), reset("btc", 60_000));
  await connect(value);
  value.wire.frame(ticker("BTC-USD", "2.005", 2));
  await turns();
  assert(value.port.haltRequests.length === 0, "An off-grid tick is rejected, not halted.");
  assert(!value.port.calls.includes("append:btc"), "A rejected tick must not be persisted.");
  value.wire.frame(ticker("BTC-USD", "2.00", 3));
  await turns();
  assert(value.port.calls.includes("append:btc"), "The reset must survive a rejected tick.");
  assert(value.port.haltRequests.length === 0, "The confirmed price must still be accepted after a rejected tick.");
  console.log("rejectedTickDoesNotConsumeReset");
}

async function haltedTickKeepsResetForNothingElse(): Promise<void> {
  const value = setup(seed("btc"), reset("btc", 60_000));
  await connect(value);
  value.wire.frame(ticker("BTC-USD", "4.00", 2));
  await turns();
  assert(value.port.haltRequests.length === 1, "A tick far from the confirmed price halts once.");
  value.wire.frame(ticker("BTC-USD", "2.00", 3));
  await turns();
  assert(value.port.haltRequests.length === 1, "A halted instrument drops later frames silently.");
  assert(!value.port.calls.includes("append:btc"), "Nothing may be persisted for a halted instrument.");
  console.log("haltedTickKeepsResetForNothingElse");
}

function engineConvertsStartupResets(): void {
  const expiresAt = new Date(1_700_000_000_123);
  const converted = sessionJumpResets(
    new Map([
      ["btc", { confirmedPrice: "2.000000000000000000", expiresAt }],
      ["eth", { confirmedPrice: "3.5", expiresAt: new Date(5) }],
    ]),
  );
  assert(converted.size === 2, "Every startup reset must be converted.");
  assert(converted.get("btc")?.confirmedPrice === canonicalDecimal("2.00"), "The price must be canonical.");
  assert(converted.get("btc")?.expiresAtMs === 1_700_000_000_123, "Expiry must be milliseconds since the epoch.");
  assert(converted.get("eth")?.confirmedPrice === canonicalDecimal("3.50"), "Each label keeps its own price.");
  assert(converted.get("eth")?.expiresAtMs === 5, "Each label keeps its own expiry.");
  assert(sessionJumpResets(new Map()).size === 0, "No resets convert to none.");
  for (const bad of ["", "abc", "1e5", "-1", "2,00"]) {
    let refused: unknown;
    try {
      sessionJumpResets(new Map([["btc", { confirmedPrice: bad, expiresAt }]]));
    } catch (error) {
      refused = error;
    }
    assert(
      refused instanceof EngineStartError &&
        refused.code === "SEED" &&
        refused.message === "Market-data engine could not start: SEED.",
      `A confirmed price of "${bad}" must stop the engine with SEED and not echo the value.`,
    );
  }
  console.log("engineConvertsStartupResets");
}

let finished = false;

process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("Session jump reset test ended without finishing.");
    process.exitCode = 1;
  }
});

void confirmedResetIsTheFirstReference()
  .then(resetDoesNotWidenTheBand)
  .then(expiredResetIsIgnored)
  .then(resetIsUsedOnce)
  .then(resetIsPerInstrument)
  .then(resetForTheSecondInstrumentOnly)
  .then(resetsForBothInstrumentsApplyIndependently)
  .then(expiryBoundaryIsExclusive)
  .then(rejectedTickDoesNotConsumeReset)
  .then(haltedTickKeepsResetForNothingElse)
  .then(() => {
    engineConvertsStartupResets();
    finished = true;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
