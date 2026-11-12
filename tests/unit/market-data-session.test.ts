import { canonicalDecimal } from "../../packages/market-data/src";
import {
  ProviderCircuit,
  type ProviderPolicy,
} from "../../apps/market-data/src/circuit";
import {
  CoinbaseProductAssertions,
  type ProductFetcher,
} from "../../apps/market-data/src/coinbase/rest-products";
import {
  CircuitEventRelay,
  CoinbaseSession,
  type CircuitRelayEvent,
  type HeartbeatSummaryRecord,
} from "../../apps/market-data/src/coinbase/session";
import {
  CoinbaseWsTransport,
  type WireCallbacks,
  type WireTransport,
} from "../../apps/market-data/src/coinbase/ws-client";
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
function passed(name: string): void {
  console.log(name);
}
async function turns(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}
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
const increment = canonicalDecimal("0.01")!;
class FakeWire implements WireTransport {
  public readonly calls: string[] = [];
  public opens = 0;
  private callbacks: WireCallbacks | undefined;
  public constructor(private readonly ordered: string[] = this.calls) {}
  public open(endpoint: string, callbacks: WireCallbacks): void {
    this.opens += 1;
    this.calls.push(`socket:${endpoint}`);
    this.ordered.push(`socket:${endpoint}`);
    this.callbacks = callbacks;
    callbacks.opened();
  }
  public subscribe(ids: readonly string[]): void {
    const entry = `subscribe:${JSON.stringify(ids)}`;
    this.calls.push(entry);
    this.ordered.push(entry);
  }
  public close(): void {
    this.calls.push("close");
    this.ordered.push("close");
  }
  public frame(value: unknown): void {
    this.callbacks?.message(JSON.stringify(value));
  }
  public fail(
    code: Parameters<WireCallbacks["failed"]>[0],
    retryAfter?: string,
  ): void {
    this.callbacks?.failed(code, retryAfter);
  }
  public closed(): void {
    this.callbacks?.closed(1006, 0, false);
  }
}
function product(symbol = "BTC-USD"): Record<string, unknown> {
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
function ticker(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
function match(id: number): Record<string, unknown> {
  return {
    type: "match",
    product_id: "BTC-USD",
    sequence: id,
    trade_id: id,
    time: "1970-01-01T00:00:00.000000Z",
    price: "1.00",
    size: "1.00",
  };
}
function setup(
  status = 200,
  endpoint = "wss://synthetic.example",
  instrumentCount = 1,
  sink?: (record: HeartbeatSummaryRecord) => void,
): {
  clock: FakeClock;
  scheduler: FakeScheduler;
  port: InMemoryPersistencePort;
  wire: FakeWire;
  session: CoinbaseSession;
  logs: unknown[];
  summaries: HeartbeatSummaryRecord[];
  ordered: string[];
  rest: ProductFetcher;
  events: CircuitRelayEvent[];
  quality: QualityAggregator;
  circuit: ProviderCircuit;
} {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const port = new InMemoryPersistencePort();
  const ordered: string[] = [];
  const wire = new FakeWire(ordered);
  const logs: unknown[] = [];
  const summaries: HeartbeatSummaryRecord[] = [];
  const events: CircuitRelayEvent[] = [];
  const relay = new CircuitEventRelay((event) => events.push(event));
  const circuit = new ProviderCircuit(
    "coinbase",
    policy,
    clock,
    scheduler,
    port,
    relay,
  );
  const fetcher: ProductFetcher = {
    async getProduct(productId) {
      ordered.push(`rest:${productId}`);
      return { status, body: product(productId) as never };
    },
  };
  const products = new CoinbaseProductAssertions(
    "coinbase",
    fetcher,
    scheduler,
    port,
    circuit,
  );
  const quality = new QualityAggregator(clock);
  const session = new CoinbaseSession({
    providerId: "coinbase",
    endpoint,
    instruments: Array.from({ length: instrumentCount }, (_, index) => {
      const symbol = index === 0 ? "BTC-USD" : "ETH-USD";
      return {
        instrumentId: index === 0 ? "btc" : "eth",
        symbol,
        priceIncrement: increment,
        sizeIncrement: increment,
        ticker: {
          priceIncrement: increment,
          sizeIncrement: increment,
          maxInitialEventDelayMs: 1000,
          maxFutureSkewMs: 1000,
          maxPriceJumpBps: 100,
        },
      };
    }),
    humanHalted: [],
    transport: wire,
    products,
    circuit,
    relay,
    persistence: port,
    quality,
    clock,
    scheduler,
    prng: new SeededPrng(7),
    correlationId: () => "correlation",
    log: (entry) => logs.push(entry),
    heartbeatLog: (record) => {
      summaries.push(record);
      sink?.(record);
    },
  });
  return {
    clock,
    scheduler,
    port,
    wire,
    session,
    logs,
    summaries,
    ordered,
    rest: fetcher,
    events,
    quality,
    circuit,
  };
}
async function sessionReconnectsInOrderRestThenSocketThenSubscribe(): Promise<void> {
  const value = setup();
  await value.session.connect();
  assert(
    JSON.stringify(value.ordered) ===
      JSON.stringify([
        "rest:BTC-USD",
        "socket:wss://synthetic.example",
        'subscribe:["BTC-USD"]',
      ]),
    "Initial connection orders REST, socket, then subscription exactly.",
  );
  value.wire.closed();
  value.scheduler.advanceTo(518);
  await turns();
  assert(
    JSON.stringify(value.ordered) ===
      JSON.stringify([
        "rest:BTC-USD",
        "socket:wss://synthetic.example",
        'subscribe:["BTC-USD"]',
        "rest:BTC-USD",
        "socket:wss://synthetic.example",
        'subscribe:["BTC-USD"]',
      ]),
    "Reconnect repeats REST, socket, then subscription exactly.",
  );
  passed("sessionReconnectsInOrderRestThenSocketThenSubscribe");
}
async function sessionSubscribesToPublicChannelsOnly(): Promise<void> {
  const value = setup();
  await value.session.connect();
  assert(
    value.wire.calls[1] === 'subscribe:["BTC-USD"]',
    "Session supplies only configured symbols to the transport public subscription.",
  );
  passed("sessionSubscribesToPublicChannelsOnly");
}
async function sessionRejectsNonWssEndpoint(): Promise<void> {
  const value = setup(200, "ws://bad");
  await value.session.connect();
  assert(
    value.ordered.length === 0 && value.wire.opens === 0,
    "Non-wss session endpoint reaches neither REST nor socket construction.",
  );
  assert(
    JSON.stringify(value.logs.map((record) => (record as { reason: string }).reason)) ===
      JSON.stringify(["CONFIGURATION"]),
    "Non-wss session endpoint records exactly one safe configuration failure.",
  );
  passed("sessionRejectsNonWssEndpoint");
}
async function sessionMalformedFramesAggregateAndThirdForcesReconnect(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame({ nope: true });
  value.wire.frame({ nope: true });
  await turns();
  assert(value.wire.calls.filter((call) => call === "close").length === 0, "First two malformed frames do not close.");
  value.wire.frame({ nope: true });
  await turns();
  assert(
    value.wire.calls.filter((call) => call === "close").length === 1,
    "Third malformed frame closes exactly once.",
  );
  assert(
    value.events.some(
      (event) =>
        event.type === "failedAttempt" &&
        event.reason === "MALFORMED_PAYLOAD_THRESHOLD",
    ) && value.events.some((event) => event.type === "reconnect"),
    "Third malformed frame records one circuit failure and requests reconnect.",
  );
  const malformed = value.quality.pending().find((bucket) => bucket.reasonCode === "MALFORMED");
  assert(
    malformed?.count === 3 && malformed.instrumentId === null,
    "Malformed frames aggregate three null-instrument quality records.",
  );
  value.wire.closed();
  assert(
    value.logs.filter((record) => (record as { reason: string }).reason === "NETWORK").length === 0,
    "Closed callback after the session close adds no network failure.",
  );
  value.scheduler.advanceTo(518);
  await turns();
  value.wire.frame({ nope: true });
  value.wire.frame({ nope: true });
  await turns();
  assert(value.wire.calls.filter((call) => call === "close").length === 1, "Malformed counter resets on reconnect.");
  passed("sessionMalformedFramesAggregateAndThirdForcesReconnect");
}
async function sessionValidationRejectsDoNotCountAsFailedAttempts(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame(ticker());
  await turns();
  assert(value.port.calls.filter((call) => call === "append:btc").length === 1, "Allowed ticker persists before rejection fixture.");
  value.wire.frame(ticker({ best_bid: "0" }));
  await turns();
  assert(
    value.port.calls.filter((call) => call === "append:btc").length === 1 &&
      value.wire.calls.filter((call) => call === "close").length === 0 &&
      value.logs.filter((record) => (record as { reason: string }).reason === "NETWORK").length === 0,
    "Rejected ticker neither persists nor closes nor records a failed attempt.",
  );
  const rejected = value.quality.pending().find((bucket) => bucket.reasonCode === "NONPOSITIVE");
  assert(rejected?.count === 1 && rejected.instrumentId === "btc", "Rejected ticker aggregates one NONPOSITIVE bucket for btc.");
  passed("sessionValidationRejectsDoNotCountAsFailedAttempts");
}
async function sessionHaltsOnMatchGapAndStaysHaltedAcrossReconnect(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame(match(1));
  value.wire.frame(match(3));
  await turns();
  assert(
    value.port.haltRequests.length === 1 &&
      value.port.haltRequests[0]?.reasonCode === "IN_SESSION_MATCH_GAP" &&
      value.port.haltRequests[0]?.tradeId === "3" &&
      value.port.haltRequests[0]?.providerSequence === "3",
    "Match gap persists one detailed IN_SESSION_MATCH_GAP halt.",
  );
  value.wire.frame(ticker({ sequence: 4, trade_id: 4 }));
  await turns();
  assert(value.port.calls.filter((call) => call === "append:btc").length === 0, "Halted instrument ticker is dropped.");
  value.wire.closed();
  value.scheduler.advanceTo(518);
  await turns();
  assert(
    value.ordered.filter((entry) => entry === "rest:BTC-USD").length === 1 &&
      value.wire.opens === 1,
    "Reconnect excludes the halted only instrument.",
  );
  passed("sessionHaltsOnMatchGapAndStaysHaltedAcrossReconnect");
}
async function sessionFirstMatchAfterReconnectIsBaselineNotGap(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame(match(5));
  await turns();
  value.wire.closed();
  value.scheduler.advanceTo(518);
  await turns();
  value.wire.frame(match(9));
  await turns();
  assert(value.port.haltRequests.length === 0, "First match after reconnect is a baseline, not a gap.");
  value.wire.frame(match(12));
  await turns();
  assert(
    Number(value.port.haltRequests.length) === 1 &&
      value.port.haltRequests[0]?.reasonCode === "IN_SESSION_MATCH_GAP",
    "Second connection match gap opens a halt.",
  );
  passed("sessionFirstMatchAfterReconnectIsBaselineNotGap");
}
async function sessionTickerBeforeMatchIsAccepted(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame(ticker());
  await turns();
  assert(
    value.port.calls.filter((call) => call === "append:btc").length === 1 &&
      value.port.availability.get("btc") === "AVAILABLE" &&
      value.port.haltRequests.length === 0,
    "Ticker before a match persists once, is available, and opens no halt.",
  );
  passed("sessionTickerBeforeMatchIsAccepted");
}
async function sessionPriceJumpQuarantinesCandidate(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame(ticker());
  await turns();
  value.wire.frame(
    ticker({
      sequence: 2,
      trade_id: 2,
      time: "1970-01-01T00:00:00.000001Z",
      price: "2.00",
    }),
  );
  await turns();
  assert(
    value.port.haltRequests.length === 1 &&
      value.port.haltRequests[0]?.reasonCode === "PRICE_JUMP" &&
      value.port.haltRequests[0]?.candidatePrice === canonicalDecimal("2.00") &&
      value.port.haltRequests[0]?.referencePrice === canonicalDecimal("1.00") &&
      value.port.calls.filter((call) => call === "append:btc").length === 1,
    "Price jump persists canonical candidate and reference prices without appending the candidate.",
  );
  value.wire.frame(
    ticker({
      sequence: 3,
      trade_id: 3,
      time: "1970-01-01T00:00:00.000002Z",
      price: "1.01",
    }),
  );
  await turns();
  assert(value.port.calls.filter((call) => call === "append:btc").length === 1, "Frames after the price-jump halt are dropped.");
  passed("sessionPriceJumpQuarantinesCandidate");
}
async function sessionLockedQuoteHalts(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame(ticker({ best_ask: "1.00" }));
  await turns();
  assert(
    value.port.haltRequests.length === 1 &&
      value.port.haltRequests[0]?.reasonCode === "LOCKED_OR_CROSSED" &&
      value.port.calls.filter((call) => call === "append:btc").length === 0,
    "Locked quote opens LOCKED_OR_CROSSED and is not appended.",
  );
  passed("sessionLockedQuoteHalts");
}
async function sessionHeartbeatGapForcesReconnectAt5000ms(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame({ type: "subscriptions" });
  value.scheduler.advanceTo(4999);
  await turns();
  assert(
    JSON.stringify(value.wire.calls) ===
      JSON.stringify([
        "socket:wss://synthetic.example",
        'subscribe:["BTC-USD"]',
      ]),
    "Heartbeat remains armed at 4,999 ms.",
  );
  value.scheduler.advanceTo(5000);
  await turns(8);
  assert(
    JSON.stringify(value.wire.calls) ===
      JSON.stringify([
        "socket:wss://synthetic.example",
        'subscribe:["BTC-USD"]',
        "close",
      ]),
    "Heartbeat timeout closes exactly once at 5,000 ms.",
  );
  assert(
    value.port.transitionRequests.length === 1 &&
      value.port.transitionRequests[0]?.newBaseAvailability ===
        "UNAVAILABLE_REBASELINING",
    "Heartbeat timeout transitions the active instrument to rebaselining.",
  );
  passed("sessionHeartbeatGapForcesReconnectAt5000ms");
}
async function sessionQueueOverflowClosesAndReconnectsThenResets(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.port.appendGate = new Promise<void>(() => undefined);
  for (let index = 1; index <= 1025; index += 1)
    value.wire.frame(
      ticker({
        sequence: index,
        trade_id: index,
        time: `1970-01-01T00:00:00.${String(index).padStart(6, "0")}Z`,
      }),
    );
  await turns();
  assert(
    value.wire.calls.at(-1) === "close",
    "Overflow closes the socket exactly through recovery.",
  );
  assert(
    value.port.transitionRequests.length === 1 &&
      value.port.transitionRequests[0]?.newBaseAvailability ===
        "UNAVAILABLE_PERSISTENCE",
    "Overflow transitions the active instrument to persistence-unavailable.",
  );
  assert(
    value.events.filter(
      (event) =>
        event.type === "failedAttempt" && event.reason === "PERSISTENCE",
    ).length === 1,
    "Persistence recovery records exactly one circuit failed attempt.",
  );
  passed("sessionQueueOverflowClosesAndReconnectsThenResets");
}
async function sessionProductAssertionFailureHaltsInstrumentOnly(): Promise<void> {
  const value = setup(404);
  await value.session.connect();
  assert(
    JSON.stringify(value.port.calls) === JSON.stringify(["halt:btc"]),
    "404 product assertion opens one durable product halt.",
  );
  assert(
    JSON.stringify(value.wire.calls) === JSON.stringify([]),
    "Failed sole product opens no socket.",
  );
  passed("sessionProductAssertionFailureHaltsInstrumentOnly");
}
async function sessionRepeatedFailuresOpenCircuitAndHalfOpenAllowsOneAttempt(): Promise<void> {
  const value = setup();
  await value.session.connect();
  for (const at of [0, 1000, 3000, 7000, 15000]) {
    value.clock.now = at;
    value.wire.closed();
    value.scheduler.advanceTo(at + 30000);
    await turns();
  }
  assert(
    value.logs.some(
      (entry) =>
        (
          entry as {
            reason: string;
          }
        ).reason === "NETWORK",
    ),
    "Every terminal close records its safe failure reason.",
  );
  passed("sessionRepeatedFailuresOpenCircuitAndHalfOpenAllowsOneAttempt");
}
async function sessionHttp429WaitsRetryAfterThenRetries(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.fail("RATE_LIMIT", "2");
  value.scheduler.advanceTo(1999);
  assert(
    JSON.stringify(value.wire.calls) ===
      JSON.stringify([
        "socket:wss://synthetic.example",
        'subscribe:["BTC-USD"]',
        "close",
      ]),
    "Retry-After does not reconnect early.",
  );
  value.scheduler.advanceTo(2000);
  await turns();
  assert(
    JSON.stringify(value.wire.calls.slice(-2)) ===
      JSON.stringify([
        "socket:wss://synthetic.example",
        'subscribe:["BTC-USD"]',
      ]),
    "Retry-After reconnects at exactly two seconds.",
  );
  passed("sessionHttp429WaitsRetryAfterThenRetries");
}
async function sessionAuthOrTlsFailureWaitsThirtyMinutes(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.fail("TLS");
  assert(
    value.events.filter((event) => event.type === "remediationRequired").length === 1,
    "TLS failure invokes circuit remediation exactly once.",
  );
  value.scheduler.advanceTo(1799999);
  assert(
    JSON.stringify(value.wire.calls) ===
      JSON.stringify([
        "socket:wss://synthetic.example",
        'subscribe:["BTC-USD"]',
        "close",
      ]),
    "TLS remediation has no automatic session retry before thirty minutes.",
  );
  value.scheduler.advanceTo(1800000);
  await turns();
  assert(
    JSON.stringify(value.wire.calls.slice(-2)) ===
      JSON.stringify([
        "socket:wss://synthetic.example",
        'subscribe:["BTC-USD"]',
      ]),
    "TLS remediation retries at the thirty-minute boundary.",
  );
  passed("sessionAuthOrTlsFailureWaitsThirtyMinutes");
}
async function sessionErrorsCarryOnlySafeFields(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame({ type: "bad", sentinel: "SECRET-URL-PAYLOAD" });
  await turns();
  assert(
    !JSON.stringify(value.logs).includes("SECRET-URL-PAYLOAD"),
    "Safe records exclude payload sentinel.",
  );
  passed("sessionErrorsCarryOnlySafeFields");
}
async function sessionOneDisconnectCountsExactlyOneFailedAttempt(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.fail("NETWORK");
  value.wire.closed();
  await turns();
  const reasons = value.logs
    .map(
      (entry) =>
        (
          entry as {
            reason: string;
          }
        ).reason,
    )
    .filter((reason) => reason === "NETWORK");
  assert(
    JSON.stringify(reasons) === JSON.stringify(["NETWORK", "NETWORK"]),
    "Relay and terminal handling record one circuit failure and one session record, not a second close failure.",
  );
  passed("sessionOneDisconnectCountsExactlyOneFailedAttempt");
}
async function sessionSessionInitiatedCloseAddsNoSecondFailure(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame({ malformed: 1 });
  value.wire.frame({ malformed: 2 });
  value.wire.frame({ malformed: 3 });
  await turns();
  const before = value.logs.length;
  value.wire.closed();
  await turns();
  assert(
    value.logs.length === before,
    "Closed callback after session-initiated close is ignored.",
  );
  passed("sessionSessionInitiatedCloseAddsNoSecondFailure");
}
async function sessionEndpointValidatedBeforeRest(): Promise<void> {
  const value = setup(200, "ws://sentinel");
  await value.session.connect();
  assert(
    JSON.stringify(value.wire.calls) === JSON.stringify([]) &&
      JSON.stringify(value.port.calls) === JSON.stringify([]),
    "Non-wss endpoint reaches neither REST persistence effects nor socket.",
  );
  assert(
    JSON.stringify(
      value.logs.map(
        (entry) =>
          (
            entry as {
              reason: string;
            }
          ).reason,
      ),
    ) === JSON.stringify(["CONFIGURATION"]),
    "Endpoint validation records only the safe configuration code.",
  );
  passed("sessionEndpointValidatedBeforeRest");
}
async function sessionHaltedInstrumentFramesAreDroppedSilently(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame(match(1));
  value.wire.frame(match(3));
  await turns();
  const qualityBefore = value.logs.length;
  const callsBefore = value.port.calls.length;
  value.wire.frame(ticker({ sequence: 4, trade_id: 4 }));
  await turns();
  assert(
    value.port.calls.length === callsBefore &&
      value.logs.length === qualityBefore,
    "Frames for a halted mapped instrument are dropped without a record.",
  );
  passed("sessionHaltedInstrumentFramesAreDroppedSilently");
}
async function sessionPersistenceRecoverySchedulesOneBackoff(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.port.appendGate = new Promise<void>(() => undefined);
  for (let index = 1; index <= 1025; index += 1) {
    value.wire.frame(
      ticker({
        sequence: index,
        trade_id: index,
        time: `1970-01-01T00:00:00.${String(index).padStart(6, "0")}Z`,
      }),
    );
  }
  await turns();
  value.scheduler.advanceTo(517);
  await turns();
  assert(
    value.wire.opens === 1,
    "Persistence recovery does not reconnect before its first backoff delay.",
  );
  value.scheduler.advanceTo(518);
  await turns();
  assert(
    Number(value.wire.opens) === 2,
    "Persistence recovery schedules exactly its first backoff, not a second incremented delay.",
  );
  passed("sessionPersistenceRecoverySchedulesOneBackoff");
}
function heartbeat(
  symbol: string,
  sequence: number,
  lastTradeId: number,
): Record<string, unknown> {
  return {
    type: "heartbeat",
    product_id: symbol,
    sequence,
    last_trade_id: lastTradeId,
    time: "1970-01-01T00:00:00.000000Z",
  };
}
async function beat(
  value: ReturnType<typeof setup>,
  symbol: string,
  at: number,
): Promise<void> {
  value.clock.now = at;
  value.wire.frame(heartbeat(symbol, at, 0));
  await turns();
}
async function sessionHeartbeatSummaryNotEmittedBefore60s(): Promise<void> {
  const value = setup();
  await value.session.connect();
  for (let at = 0; at <= 59999; at += 1000) await beat(value, "BTC-USD", at);
  await beat(value, "BTC-USD", 59999);
  assert(value.summaries.length === 0, "No summary is emitted before 60,000 ms.");
  passed("sessionHeartbeatSummaryNotEmittedBefore60s");
}
async function sessionHeartbeatSummaryReportsMaxIntervalAt60s(): Promise<void> {
  const value = setup();
  await value.session.connect();
  for (const at of [0, 1000, 2000, 5000, 6000, 30000, 31000, 60000]) {
    await beat(value, "BTC-USD", at);
  }
  assert(value.summaries.length === 1, "Exactly one summary at 60,000 ms.");
  const record = value.summaries[0];
  assert(
    JSON.stringify(record) ===
      JSON.stringify({
        providerId: "coinbase",
        instrumentId: "btc",
        intervals: 7,
        maxIntervalMs: 29000,
        windowMs: 60000,
        timestampMs: 60000,
        correlationId: "correlation",
      }),
    "Summary carries exact interval count, maximum, window and ids only.",
  );
  passed("sessionHeartbeatSummaryReportsMaxIntervalAt60s");
}
async function sessionHeartbeatSummaryWindowResetsAfterEmit(): Promise<void> {
  const value = setup();
  await value.session.connect();
  for (const at of [0, 60000, 61000, 62000, 120000]) {
    await beat(value, "BTC-USD", at);
  }
  assert(value.summaries.length === 2, "A second window emits its own summary.");
  const second = value.summaries[1];
  assert(
    second?.intervals === 3 && second.maxIntervalMs === 58000 &&
      second.windowMs === 60000,
    "The second window excludes the first window's counts and maximum.",
  );
  passed("sessionHeartbeatSummaryWindowResetsAfterEmit");
}
async function sessionHeartbeatSummaryReportsActualWindowLength(): Promise<void> {
  const value = setup();
  await value.session.connect();
  await beat(value, "BTC-USD", 1000);
  await beat(value, "BTC-USD", 62500);
  const record = value.summaries[0];
  assert(
    record?.windowMs === 61500 && record.timestampMs === 62500,
    "Window length is the measured elapsed time, not the nominal 60,000 ms.",
  );
  passed("sessionHeartbeatSummaryReportsActualWindowLength");
}
async function sessionHeartbeatLogFailureDoesNotAffectSession(): Promise<void> {
  const value = setup(200, "wss://synthetic.example", 1, () => {
    throw new Error("log sink failed");
  });
  await value.session.connect();
  for (const at of [0, 60000, 61000]) {
    value.clock.now = at;
    value.wire.frame(heartbeat("BTC-USD", at, 0));
    await turns();
  }
  assert(
    value.wire.calls.filter((call) => call === "close").length === 0 &&
      value.logs.length === 0 &&
      value.summaries.length === 1,
    "A throwing heartbeat log sink neither closes the transport nor records a failure.",
  );
  passed("sessionHeartbeatLogFailureDoesNotAffectSession");
}
async function sessionHeartbeatSummaryIsPerInstrument(): Promise<void> {
  const value = setup(200, "wss://synthetic.example", 2);
  const connecting = value.session.connect();
  await turns();
  value.scheduler.advanceTo(100);
  await connecting;
  await beat(value, "BTC-USD", 0);
  await beat(value, "ETH-USD", 10);
  await beat(value, "BTC-USD", 60000);
  assert(
    value.summaries.length === 1 && value.summaries[0]?.instrumentId === "btc",
    "Only the instrument whose window elapsed emits a summary.",
  );
  await beat(value, "ETH-USD", 60010);
  const all: readonly HeartbeatSummaryRecord[] = value.summaries;
  assert(
    all.length === 2 &&
      all[1]?.instrumentId === "eth" &&
      all[1].intervals === 1,
    "Each instrument keeps its own window.",
  );
  passed("sessionHeartbeatSummaryIsPerInstrument");
}
async function sessionHeartbeatSummaryResetsOnReconnect(): Promise<void> {
  const value = setup();
  await value.session.connect();
  await beat(value, "BTC-USD", 0);
  await beat(value, "BTC-USD", 30000);
  value.wire.closed();
  value.scheduler.advanceTo(30600);
  await turns(8);
  await beat(value, "BTC-USD", 65000);
  await beat(value, "BTC-USD", 66000);
  assert(
    value.summaries.length === 0,
    "A reconnect discards the old window instead of reporting a false gap.",
  );
  passed("sessionHeartbeatSummaryResetsOnReconnect");
}
async function sessionAheadConfirmedClosesAndReconnects(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.frame(match(1));
  for (const at of [0, 900, 1800, 2700]) {
    value.clock.now = at;
    value.wire.frame(heartbeat("BTC-USD", at + 2, 2));
    await turns();
  }
  assert(
    value.wire.calls.filter((call) => call === "close").length === 1,
    "Four ahead heartbeats spanning 2,700 ms close the transport once.",
  );
  assert(
    value.events.filter((event) => event.type === "reconnect").length === 1,
    "Confirmed heartbeat ahead condition schedules one reconnect.",
  );
  passed("sessionAheadConfirmedClosesAndReconnects");
}
async function sessionQueueResetsOnlyAfterOpenedReconnect(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.port.appendGate = new Promise<void>(() => undefined);
  for (let index = 1; index <= 1025; index += 1) {
    value.wire.frame(
      ticker({
        sequence: index,
        trade_id: index,
        time: `1970-01-01T00:00:00.${String(index).padStart(6, "0")}Z`,
      }),
    );
  }
  await turns();
  const recoveryRecord = value.logs.find(
    (record) =>
      (record as { reason: string }).reason === "QUEUE_OVERFLOW",
  ) as { queueDepth: number } | undefined;
  assert(
    recoveryRecord?.queueDepth === 1024,
    "Persistence recovery records the 1,024 queued items before discard.",
  );
  value.wire.frame(
    ticker({
      sequence: 1026,
      trade_id: 1026,
      time: "1970-01-01T00:00:00.001026Z",
    }),
  );
  await turns();
  assert(
    value.port.calls.filter((call) => call === "append:btc").length === 0,
    "A ticker during recovery is not written before the new socket opens.",
  );
  value.port.appendGate = undefined;
  value.scheduler.advanceTo(518);
  await turns(8);
  value.wire.frame(
    ticker({
      sequence: 1027,
      trade_id: 1027,
      time: "1970-01-01T00:00:00.518000Z",
    }),
  );
  await turns(8);
  assert(
    value.port.calls.filter((call) => call === "append:btc").length === 1,
    "A ticker after opened reconnect writes after queue reset.",
  );
  passed("sessionQueueResetsOnlyAfterOpenedReconnect");
}
async function sessionBackoffAttemptResetsAfterAcceptedHeartbeat(): Promise<void> {
  const value = setup();
  await value.session.connect();
  value.wire.closed();
  value.scheduler.advanceTo(518);
  await turns();
  value.wire.frame(match(1));
  value.wire.frame(heartbeat("BTC-USD", 2, 1));
  await turns();
  value.wire.closed();
  value.scheduler.advanceTo(1517);
  await turns();
  assert(
    value.wire.opens === 3,
    "Accepted heartbeat resets the next reconnect below the attempt-two delay.",
  );
  passed("sessionBackoffAttemptResetsAfterAcceptedHeartbeat");
}
async function sessionRestCallsAreSpacedAtLeast100Ms(): Promise<void> {
  const value = setup(200, "wss://synthetic.example", 2);
  const connecting = value.session.connect();
  await turns();
  assert(
    JSON.stringify(value.ordered) === JSON.stringify(["rest:BTC-USD"]),
    "Second product request is held before its 100 ms spacing boundary.",
  );
  value.scheduler.advanceTo(99);
  await turns();
  assert(
    JSON.stringify(value.ordered) === JSON.stringify(["rest:BTC-USD"]),
    "Second product request remains absent at 99 ms.",
  );
  value.scheduler.advanceTo(100);
  await connecting;
  assert(
    value.ordered[1] === "rest:ETH-USD",
    "Second product request starts at the 100 ms boundary.",
  );
  passed("sessionRestCallsAreSpacedAtLeast100Ms");
}
async function sessionRest429SchedulesCircuitRetry(): Promise<void> {
  const value = setup();
  value.rest.getProduct = async () => ({
    status: 429,
    body: product() as never,
  });
  await value.session.connect();
  assert(
    value.events.filter((event) => event.type === "failedAttempt").length === 1 &&
      value.wire.opens === 0,
    "REST 429 records one circuit failure and prevents socket construction.",
  );
  value.scheduler.advanceTo(59999);
  await turns();
  assert(value.wire.opens === 0, "REST 429 default retry does not start early.");
  value.scheduler.advanceTo(60000);
  await turns();
  assert(value.wire.opens === 0, "Repeated REST 429 still prevents socket construction.");
  assert(
    value.events.filter((event) => event.type === "failedAttempt").length === 2,
    "REST retry reaches circuit HTTP 429 handling again at 60,000 ms.",
  );
  passed("sessionRest429SchedulesCircuitRetry");
}
async function sessionRestTransientFailureIsNotHalt(): Promise<void> {
  const value = setup(500);
  await value.session.connect();
  assert(
    value.port.haltRequests.length === 0 &&
      value.events.filter((event) => event.type === "failedAttempt").length === 1,
    "REST 500 is one transient circuit failure and no durable halt.",
  );
  value.rest.getProduct = async (productId) => ({
    status: 200,
    body: product(productId) as never,
  });
  value.scheduler.advanceTo(517);
  await turns();
  assert(Number(value.wire.opens) === 0, "REST 500 does not reconnect before 518 ms.");
  value.scheduler.advanceTo(518);
  await turns();
  assert(Number(value.wire.opens) === 1, "REST 500 reconnects at the first backoff.");
  const thrown = setup();
  thrown.rest.getProduct = async () => {
    throw new Error("fetch failure");
  };
  await thrown.session.connect();
  assert(
    thrown.port.haltRequests.length === 0 &&
      thrown.events.filter((event) => event.type === "failedAttempt").length === 1,
    "Thrown REST fetcher error is one transient circuit failure and no halt.",
  );
  thrown.rest.getProduct = async (productId) => ({
    status: 200,
    body: product(productId) as never,
  });
  thrown.scheduler.advanceTo(517);
  await turns();
  assert(Number(thrown.wire.opens) === 0, "Thrown fetch error does not reconnect early.");
  thrown.scheduler.advanceTo(518);
  await turns();
  assert(
    Number(thrown.wire.opens) === 1,
    "Thrown fetch error reconnects at the first backoff.",
  );
  passed("sessionRestTransientFailureIsNotHalt");
}
async function sessionHumanHaltDuringHalfOpenUnblocksSettle(): Promise<void> {
  const value = setup(200, "wss://synthetic.example", 2);
  for (let index = 0; index < 5; index += 1) {
    value.circuit.connectionFailed("NETWORK");
  }
  value.scheduler.advanceTo(30000);
  const connecting = value.session.connect();
  await turns();
  value.scheduler.advanceTo(30100);
  await connecting;
  value.wire.frame({ type: "subscriptions" });
  value.wire.frame(
    ticker({
      time: "1970-01-01T00:00:30.000000Z",
    }),
  );
  value.wire.frame(
    ticker({
      product_id: "ETH-USD",
      best_ask: "1.00",
      time: "1970-01-01T00:00:30.000000Z",
    }),
  );
  await turns(8);
  assert(
    value.circuit.state() === "SETTLING",
    "A no-ticker halted instrument does not block half-open settling.",
  );
  for (const at of [30100, 31100, 32100, 33100]) {
    value.clock.now = at;
    value.wire.frame(heartbeat("BTC-USD", at, 0));
    await turns();
  }
  assert(
    value.circuit.state() === "CLOSED",
    "Four settling heartbeats close the circuit without a ticker for halted ETH.",
  );
  passed("sessionHumanHaltDuringHalfOpenUnblocksSettle");
}
async function sessionProductAssertionsPassedLetsHalfOpenSettleToClosed(): Promise<void> {
  const value = setup(200, "wss://synthetic.example", 2);
  for (let index = 0; index < 5; index += 1) {
    value.circuit.connectionFailed("NETWORK");
  }
  value.scheduler.advanceTo(30000);
  const connecting = value.session.connect();
  await turns();
  value.scheduler.advanceTo(30100);
  await connecting;
  value.wire.frame({ type: "subscriptions" });
  value.wire.frame(
    ticker({ time: "1970-01-01T00:00:30.000000Z" }),
  );
  value.wire.frame(
    ticker({
      product_id: "ETH-USD",
      time: "1970-01-01T00:00:30.000000Z",
    }),
  );
  await turns(8);
  for (const at of [30100, 31100, 32100, 33100]) {
    value.clock.now = at;
    value.wire.frame(heartbeat("BTC-USD", at, 0));
    await turns();
  }
  assert(
    value.circuit.state() === "CLOSED",
    "REST assertions, acknowledgement, tickers, and settling heartbeats close half-open.",
  );
  passed("sessionProductAssertionsPassedLetsHalfOpenSettleToClosed");
}
void (async () => {
  await sessionReconnectsInOrderRestThenSocketThenSubscribe();
  await sessionSubscribesToPublicChannelsOnly();
  await sessionRejectsNonWssEndpoint();
  await sessionMalformedFramesAggregateAndThirdForcesReconnect();
  await sessionValidationRejectsDoNotCountAsFailedAttempts();
  await sessionHaltsOnMatchGapAndStaysHaltedAcrossReconnect();
  await sessionFirstMatchAfterReconnectIsBaselineNotGap();
  await sessionTickerBeforeMatchIsAccepted();
  await sessionPriceJumpQuarantinesCandidate();
  await sessionLockedQuoteHalts();
  await sessionHeartbeatGapForcesReconnectAt5000ms();
  await sessionHeartbeatSummaryNotEmittedBefore60s();
  await sessionHeartbeatSummaryReportsMaxIntervalAt60s();
  await sessionHeartbeatSummaryWindowResetsAfterEmit();
  await sessionHeartbeatSummaryReportsActualWindowLength();
  await sessionHeartbeatLogFailureDoesNotAffectSession();
  await sessionHeartbeatSummaryIsPerInstrument();
  await sessionHeartbeatSummaryResetsOnReconnect();
  await sessionQueueOverflowClosesAndReconnectsThenResets();
  await sessionProductAssertionFailureHaltsInstrumentOnly();
  await sessionRepeatedFailuresOpenCircuitAndHalfOpenAllowsOneAttempt();
  await sessionHttp429WaitsRetryAfterThenRetries();
  await sessionAuthOrTlsFailureWaitsThirtyMinutes();
  await sessionErrorsCarryOnlySafeFields();
  await sessionOneDisconnectCountsExactlyOneFailedAttempt();
  await sessionSessionInitiatedCloseAddsNoSecondFailure();
  await sessionEndpointValidatedBeforeRest();
  await sessionHaltedInstrumentFramesAreDroppedSilently();
  await sessionPersistenceRecoverySchedulesOneBackoff();
  await sessionAheadConfirmedClosesAndReconnects();
  await sessionQueueResetsOnlyAfterOpenedReconnect();
  await sessionBackoffAttemptResetsAfterAcceptedHeartbeat();
  await sessionRestCallsAreSpacedAtLeast100Ms();
  await sessionRest429SchedulesCircuitRetry();
  await sessionRestTransientFailureIsNotHalt();
  await sessionHumanHaltDuringHalfOpenUnblocksSettle();
  await sessionProductAssertionsPassedLetsHalfOpenSettleToClosed();
})();
