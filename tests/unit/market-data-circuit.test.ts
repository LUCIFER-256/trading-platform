import { ProviderCircuit, agreedProviderPolicy, backoffDelayMs } from "../../apps/market-data/src/circuit";
import type { CircuitEvents, ProviderPolicy } from "../../apps/market-data/src/circuit";
import type { AppendObservationRequest } from "../../apps/market-data/src/ports";
import { FakeClock, FakeScheduler, InMemoryPersistencePort, SeededPrng } from "./support/market-data-fakes";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function passed(name: string): void { console.log(name); }
function flush(): Promise<void> { return Promise.resolve().then(() => Promise.resolve()); }
const policy: ProviderPolicy = { heartbeatTimeoutMs: 5_000, circuitFailureThreshold: 5, circuitFailureWindowMs: 60_000, circuitCooldownMs: 30_000, circuitHalfOpenReadyMs: 10_000, heartbeatAheadCount: 4, heartbeatAheadSpanMs: 2_500, heartbeatSettleCount: 4, heartbeatSettleSpanMs: 3_000 };
const request: AppendObservationRequest = { providerId: "p", instrumentId: "ETH", providerSymbol: "ETH-USD", providerSequence: "1", tradeId: "1", eventAtUs: "0", receivedAt: new Date(0), bid: "1", bidSize: "1", ask: "2", askSize: "1", lastPrice: "1", lastSize: "1", volume24h: null };

function setup(): { clock: FakeClock; scheduler: FakeScheduler; port: InMemoryPersistencePort; events: string[]; circuit: ProviderCircuit } {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const port = new InMemoryPersistencePort();
  const events: string[] = [];
  const callbacks: CircuitEvents = { recovery: (reason) => events.push(`recovery:${reason}`), reconnect: () => events.push("reconnect"), failedAttempt: (reason) => events.push(`failure:${reason}`), remediationRequired: () => events.push("remediation") };
  return { clock, scheduler, port, events, circuit: new ProviderCircuit("p", policy, clock, scheduler, port, callbacks) };
}
function open(circuit: ProviderCircuit, clock: FakeClock): void { for (const at of [0, 1_000, 3_000, 7_000, 15_000]) { clock.now = at; circuit.connectionFailed(); } }
async function halfOpen(setupValue: ReturnType<typeof setup>): Promise<void> {
  open(setupValue.circuit, setupValue.clock);
  setupValue.scheduler.advanceTo(45_000);
  setupValue.circuit.consumeConnectionAttempt();
  setupValue.circuit.productAssertionsPassed();
  setupValue.circuit.subscriptionsAcknowledged();
  await setupValue.circuit.validTicker("ETH", request);
}

async function heartbeatAheadSettlesBeforeReconnect(): Promise<void> {
  const value = setup();
  value.circuit.beginReady(["ETH"], []);
  assert(value.circuit.heartbeat("ETH", "1", "101", "100") === "PENDING", "Ahead heartbeat is pending.");
  value.clock.now = 500;
  assert(value.circuit.heartbeat("ETH", "2", "101", "101") === "ACCEPTED", "Match catches up.");
  value.clock.now = 1_000;
  assert(value.circuit.heartbeat("ETH", "3", "101", "101") === "ACCEPTED", "Ahead count clears.");
  await flush();
  assert(value.events.length === 0, "No recovery or failure occurs.");
  passed("heartbeatAheadSettlesBeforeReconnect");
}
async function heartbeatAheadFourHeartbeatsAcross2500msRebaselines(): Promise<void> {
  const value = setup();
  value.circuit.beginReady(["ETH", "BTC"], ["BTC"]);
  for (const at of [0, 1_000, 2_000, 2_499]) { value.clock.now = at; value.circuit.heartbeat("ETH", String(at + 1), "101", "100"); }
  assert(value.events.length === 0, "One millisecond inside span does not recover.");
  value.clock.now = 2_500;
  value.circuit.heartbeat("ETH", "2501", "101", "100");
  await flush();
  assert(JSON.stringify(value.events) === JSON.stringify(["recovery:HEARTBEAT_GAP", "reconnect", "failure:HEARTBEAT_GAP"]), "Confirmed gap recovers once.");
  assert(value.port.availability.get("ETH") === "UNAVAILABLE_REBASELINING" && value.port.availability.get("BTC") === undefined, "Only non-halted instruments transition.");
  const other = setup();
  other.circuit.beginReady(["ETH"], []);
  for (const at of [0, 1_000, 3_000]) { other.clock.now = at; other.circuit.heartbeat("ETH", String(at), "101", "100"); }
  assert(other.events.length === 0, "Three heartbeats never confirm.");
  other.circuit.heartbeat("ETH", "3001", "100", "100");
  assert(other.circuit.heartbeat("ETH", "3002", "101", "100") === "PENDING", "Non-ahead heartbeat resets count.");
  passed("heartbeatAheadFourHeartbeatsAcross2500msRebaselines");
}
async function heartbeatBehindMatchDoesNotHalt(): Promise<void> {
  const value = setup();
  assert(value.circuit.heartbeat("ETH", "1", "99", "100") === "ACCEPTED", "Behind heartbeat is accepted.");
  await flush();
  assert(value.events.length === 0 && value.port.calls.length === 0, "No recovery, failure, or transition.");
  passed("heartbeatBehindMatchDoesNotHalt");
}
async function heartbeatSequenceLowerOnlyIsOutOfSequence(): Promise<void> {
  const value = setup();
  value.circuit.heartbeat("ETH", "10", "1", "1");
  assert(value.circuit.heartbeat("ETH", "9", "1", "1") === "OUT_OF_SEQUENCE", "Lower sequence rejects.");
  assert(value.circuit.heartbeat("ETH", "10", "1", "1") === "ACCEPTED", "Equal sequence accepts.");
  assert(value.circuit.heartbeat("ETH", "2783", "1", "1") === "ACCEPTED", "Non-contiguous higher sequence accepts.");
  passed("heartbeatSequenceLowerOnlyIsOutOfSequence");
}
async function heartbeatTimeoutAt5000msForcesFailedReconnect(): Promise<void> {
  const value = setup();
  value.circuit.beginReady(["ETH"], []);
  value.circuit.subscriptionsAcknowledged();
  value.scheduler.advanceTo(4_999);
  assert(value.events.length === 0, "No timeout at 4,999.");
  value.scheduler.advanceTo(5_000);
  await flush();
  assert(JSON.stringify(value.events) === JSON.stringify(["recovery:HEARTBEAT_TIMEOUT", "reconnect", "failure:HEARTBEAT_TIMEOUT"]), "Timeout recovers exactly once.");
  const transitionFailure = setup();
  transitionFailure.circuit.beginReady(["ETH"], []);
  transitionFailure.port.throwTransition = true;
  transitionFailure.circuit.heartbeatTimeout();
  await flush();
  assert(JSON.stringify(transitionFailure.events) === JSON.stringify(["recovery:HEARTBEAT_TIMEOUT", "reconnect", "failure:HEARTBEAT_TIMEOUT"]), "Transition failure does not lose recovery accounting.");
  const rearmed = setup();
  rearmed.circuit.beginReady(["ETH"], []);
  rearmed.circuit.subscriptionsAcknowledged();
  rearmed.scheduler.advanceTo(4_999);
  rearmed.circuit.heartbeat("ETH", "1", "1", "1");
  rearmed.scheduler.advanceTo(5_000);
  assert(rearmed.events.length === 0, "Heartbeat at 4,999 rearms timer.");
  passed("heartbeatTimeoutAt5000msForcesFailedReconnect");
}
async function reconnectRebaselineReturnsAvailableAfterAutomaticEvent(): Promise<void> {
  const value = setup();
  value.port.availability.set("BTC", "UNAVAILABLE_HUMAN_HALT");
  value.circuit.beginReady(["ETH", "BTC"], ["BTC"]);
  value.circuit.heartbeatTimeout();
  await flush();
  await value.circuit.validTicker("ETH", request);
  await value.circuit.validTicker("BTC", { ...request, instrumentId: "BTC" });
  assert(JSON.stringify(value.port.calls) === JSON.stringify(["transition:ETH:UNAVAILABLE_REBASELINING", "append:ETH", "append:BTC"]), "Circuit never transitions AVAILABLE or halted BTC.");
  assert(value.port.availability.get("ETH") === "AVAILABLE" && value.port.availability.get("BTC") === "UNAVAILABLE_HUMAN_HALT", "Only accepted observation restores availability.");
  passed("reconnectRebaselineReturnsAvailableAfterAutomaticEvent");
}
async function disconnectCountsFailedAttempt(): Promise<void> {
  const value = setup();
  for (const reason of ["CONNECT", "CLOSE", "DROP", "RESET", "POST_ACK_DROP"]) {
    if (reason === "POST_ACK_DROP") value.circuit.subscriptionsAcknowledged();
    value.circuit.connectionFailed(reason);
  }
  assert(value.circuit.state() === "OPEN", "Five failures, including a post-ack failure, open the circuit.");
  assert(value.events.filter((event) => event.startsWith("failure:")).length === 5, "Every connection failure is observable.");
  const acknowledged = setup();
  for (const reason of ["CONNECT", "CLOSE", "DROP", "RESET"]) {
    acknowledged.circuit.subscriptionsAcknowledged();
    acknowledged.circuit.connectionFailed(reason);
  }
  assert(acknowledged.circuit.state() === "CLOSED", "Acknowledgements add no failed attempts.");
  passed("disconnectCountsFailedAttempt");
}
async function seededBackoffIsDeterministic(): Promise<void> {
  const sequence = Array.from({ length: 10 }, (_, index) => backoffDelayMs(index + 1, new SeededPrng(7)));
  const first = new SeededPrng(7);
  const second = new SeededPrng(7);
  const one = Array.from({ length: 10 }, (_, index) => backoffDelayMs(index + 1, first));
  const two = Array.from({ length: 10 }, (_, index) => backoffDelayMs(index + 1, second));
  const different = Array.from({ length: 10 }, (_, index) => backoffDelayMs(index + 1, new SeededPrng(8)));
  assert(JSON.stringify(one) === JSON.stringify([518, 1027, 2072, 4079, 8187, 16215, 30221, 30024, 30194, 30179]), "Seed 7 exact delays.");
  assert(sequence.every((value) => value >= 500), "Every backoff includes its base delay.");
  assert(JSON.stringify(one) === JSON.stringify(two) && JSON.stringify(one) !== JSON.stringify(different), "Seeded sequences are deterministic and distinct.");
  passed("seededBackoffIsDeterministic");
}
async function backoffAttemptOneAndJitterBounds(): Promise<void> {
  assert(backoffDelayMs(1, { nextIntInclusive: () => 0 }) === 500 && backoffDelayMs(1, { nextIntInclusive: () => 250 }) === 750, "Attempt one bounds.");
  assert(backoffDelayMs(7, { nextIntInclusive: () => 0 }) === 30_000 && backoffDelayMs(7, { nextIntInclusive: () => 250 }) === 30_250, "Cap before jitter.");
  for (const invalid of [0, 1.5]) { let thrown = false; try { backoffDelayMs(invalid, { nextIntInclusive: () => 0 }); } catch { thrown = true; } assert(thrown, "Invalid attempts throw."); }
  for (const jitter of [-1, 251]) { let thrown = false; try { backoffDelayMs(1, { nextIntInclusive: () => jitter }); } catch { thrown = true; } assert(thrown, "Invalid jitter throws."); }
  passed("backoffAttemptOneAndJitterBounds");
}
async function reconnectStormOpensProviderCircuit(): Promise<void> {
  const value = setup();
  open(value.circuit, value.clock);
  assert(value.circuit.state() === "OPEN", "Fifth failure opens.");
  value.scheduler.advanceTo(44_999);
  assert(!value.circuit.mayAttemptConnection(), "Open refuses early attempt.");
  value.scheduler.advanceTo(45_000);
  assert(value.circuit.consumeConnectionAttempt() && !value.circuit.mayAttemptConnection(), "Half-open permits exactly one attempt.");
  const openFailures = setup();
  open(openFailures.circuit, openFailures.clock);
  const failuresBefore = openFailures.events.filter((event) => event.startsWith("failure:")).length;
  openFailures.clock.now = 20_000;
  openFailures.circuit.connectionFailed("IGNORED_WHILE_OPEN");
  openFailures.circuit.heartbeatTimeout();
  for (const at of [20_000, 20_001, 20_002]) {
    openFailures.clock.now = at;
    openFailures.circuit.malformedPayload();
  }
  await flush();
  assert(openFailures.events.filter((event) => event.startsWith("failure:")).length === failuresBefore, "Failures while open emit no failed-attempt event.");
  openFailures.scheduler.advanceTo(44_999);
  assert(openFailures.circuit.state() === "OPEN", "Failures while open do not extend the existing hold.");
  openFailures.scheduler.advanceTo(45_000);
  assert(openFailures.circuit.state() === "HALF_OPEN", "Circuit half-opens at its original deadline.");
  const inclusive = setup();
  for (const at of [0, 15_000, 30_000, 45_000, 60_000]) { inclusive.clock.now = at; inclusive.circuit.connectionFailed(); }
  assert(inclusive.circuit.state() === "OPEN", "Failure exactly 60,000 ms after the first counts.");
  const outside = setup();
  for (const at of [0, 15_000, 30_000, 45_000, 60_001]) { outside.clock.now = at; outside.circuit.connectionFailed(); }
  assert(outside.circuit.state() === "CLOSED", "60,001 excludes first failure.");
  passed("reconnectStormOpensProviderCircuit");
}
async function halfOpenTimesOutAtTenSeconds(): Promise<void> {
  const ready = setup();
  open(ready.circuit, ready.clock);
  ready.scheduler.advanceTo(45_000);
  ready.circuit.consumeConnectionAttempt();
  ready.scheduler.advanceTo(54_999);
  ready.circuit.productAssertionsPassed();
  ready.circuit.subscriptionsAcknowledged();
  await ready.circuit.validTicker("ETH", request);
  assert(ready.circuit.state() === "SETTLING", "Readiness completed at 9,999 reaches settling.");
  ready.scheduler.advanceTo(55_000);
  assert(ready.circuit.state() === "SETTLING", "Cancelled readiness timer never fires.");
  const value = setup();
  open(value.circuit, value.clock);
  value.scheduler.advanceTo(45_000);
  value.scheduler.advanceTo(54_999);
  assert(value.circuit.state() === "HALF_OPEN", "Ready at 9,999 remains half-open.");
  value.scheduler.advanceTo(55_000);
  assert(value.circuit.state() === "OPEN", "Ready timeout fires at 10,000.");
  assert(value.events.filter((event) => event === "failure:HALF_OPEN_TIMEOUT").length === 1, "Timeout records one failed attempt.");
  value.scheduler.advanceTo(85_000);
  assert(value.circuit.state() === "HALF_OPEN", "Circuit half-opens again exactly 30,000 ms later.");
  passed("halfOpenTimesOutAtTenSeconds");
}
async function halfOpenSettlesAfterFourHeartbeatsAcross3000ms(): Promise<void> {
  const value = setup();
  await halfOpen(value);
  assert(value.circuit.state() === "SETTLING", "Readiness enters settling.");
  for (const at of [45_000, 46_000, 47_000, 47_999]) { value.clock.now = at; value.circuit.heartbeat("ETH", String(at), "1", "1"); }
  assert(value.circuit.state() === "SETTLING", "One millisecond inside span settles not.");
  value.clock.now = 48_000;
  value.circuit.heartbeat("ETH", "48000", "1", "1");
  assert(value.circuit.state() === "CLOSED", "Four spanning 3,000 settles.");
  const three = setup();
  await halfOpen(three);
  for (const at of [45_000, 46_500, 48_000]) { three.clock.now = at; three.circuit.heartbeat("ETH", String(at), "1", "1"); }
  assert(three.circuit.state() === "SETTLING", "Three heartbeats over 3,000 ms do not settle.");
  const outOfSequence = setup();
  await halfOpen(outOfSequence);
  for (const at of [45_000, 46_000]) { outOfSequence.clock.now = at; outOfSequence.circuit.heartbeat("ETH", String(at), "1", "1"); }
  outOfSequence.clock.now = 47_000;
  outOfSequence.circuit.heartbeat("ETH", "1", "1", "1");
  for (const at of [48_000, 49_000, 50_000]) { outOfSequence.clock.now = at; outOfSequence.circuit.heartbeat("ETH", String(at), "1", "1"); }
  assert(outOfSequence.circuit.state() === "SETTLING", "Three valid heartbeats after an out-of-sequence reset stay settling.");
  outOfSequence.clock.now = 51_000;
  outOfSequence.circuit.heartbeat("ETH", "51000", "1", "1");
  assert(outOfSequence.circuit.state() === "CLOSED", "Out-of-sequence heartbeat resets settling count.");
  const ahead = setup();
  await halfOpen(ahead);
  for (const at of [45_000, 46_000]) { ahead.clock.now = at; ahead.circuit.heartbeat("ETH", String(at), "1", "1"); }
  ahead.clock.now = 47_000;
  ahead.circuit.heartbeat("ETH", "47000", "2", "1");
  for (const at of [48_000, 49_000, 50_000]) { ahead.clock.now = at; ahead.circuit.heartbeat("ETH", String(at), "1", "1"); }
  assert(ahead.circuit.state() === "SETTLING", "Three valid heartbeats after an ahead reset stay settling.");
  ahead.clock.now = 51_000;
  ahead.circuit.heartbeat("ETH", "51000", "1", "1");
  assert(ahead.circuit.state() === "CLOSED", "Ahead heartbeat resets settling count.");
  const timeout = setup();
  await halfOpen(timeout);
  timeout.clock.now = 45_000;
  timeout.circuit.heartbeat("ETH", "1", "1", "1");
  timeout.scheduler.advanceTo(50_000);
  await flush();
  assert(timeout.circuit.state() === "OPEN", "Heartbeat timeout during settling reopens the circuit.");
  timeout.scheduler.advanceTo(80_000);
  assert(timeout.circuit.state() === "HALF_OPEN", "Settling heartbeat timeout holds for exactly 30,000 ms.");
  passed("halfOpenSettlesAfterFourHeartbeatsAcross3000ms");
}
async function partialOutageLeavesHumanHaltLatched(): Promise<void> {
  const value = setup();
  value.port.availability.set("BTC", "UNAVAILABLE_HUMAN_HALT");
  value.circuit.beginReady(["ETH", "BTC"], ["BTC"]);
  value.circuit.heartbeatTimeout();
  await flush();
  assert(value.port.availability.get("BTC") === "UNAVAILABLE_HUMAN_HALT" && !value.port.calls.some((call) => call.includes("BTC")), "Human halt is untouched.");
  passed("partialOutageLeavesHumanHaltLatched");
}
async function partialOutageExcludesHumanHaltedInstrumentFromHalfOpen(): Promise<void> {
  const value = setup();
  value.circuit.beginReady(["ETH", "BTC"], ["BTC"]);
  await halfOpen(value);
  for (const at of [45_000, 46_000, 47_000, 48_000]) { value.clock.now = at; value.circuit.heartbeat("ETH", String(at), "1", "1"); }
  assert(value.circuit.state() === "CLOSED", "BTC is not required to settle.");
  passed("partialOutageExcludesHumanHaltedInstrumentFromHalfOpen");
}
async function malformedThresholdReconnects(): Promise<void> {
  const value = setup();
  for (const at of [0, 30_000, 60_000]) { value.clock.now = at; value.circuit.malformedPayload(); }
  assert(JSON.stringify(value.events) === JSON.stringify(["failure:MALFORMED_PAYLOAD_THRESHOLD", "reconnect"]), "Inclusive window triggers once.");
  for (const at of [60_001, 60_002]) { value.clock.now = at; value.circuit.malformedPayload(); }
  assert(value.events.filter((event) => event === "reconnect").length === 1, "Two post-trigger malformed payloads do not reconnect.");
  value.clock.now = 60_003;
  value.circuit.malformedPayload();
  assert(value.events.filter((event) => event === "reconnect").length === 2, "The third post-trigger malformed payload causes the next reconnect.");
  value.clock.now = 60_004;
  value.circuit.malformedPayload();
  assert(value.events.filter((event) => event === "reconnect").length === 2, "A fourth malformed payload does not trigger twice.");
  const outside = setup();
  for (const at of [0, 30_000, 60_001]) { outside.clock.now = at; outside.circuit.malformedPayload(); }
  assert(outside.events.length === 0, "Outside window does not trigger.");
  const otherRejects = setup();
  for (let count = 0; count < 50; count += 1) otherRejects.circuit.heartbeat("ETH", String(count), "1", "1", count % 2 === 0);
  assert(otherRejects.events.length === 0, "Other reject kinds never enter the malformed counter.");
  passed("malformedThresholdReconnects");
}
async function http429HonorsRetryAfter(): Promise<void> {
  const value = setup();
  assert(value.circuit.http429("7") === 7_000 && value.circuit.state() === "CLOSED", "Single 429 remains closed.");
  for (const at of [1_000, 2_000, 3_000, 4_000]) { value.clock.now = at; value.circuit.http429("7"); }
  assert(value.circuit.state() === "OPEN", "Five failures including 429s open.");
  for (const invalid of [undefined, "abc", "-1", "1.5", "Wed, 21 Oct 2015 07:28:00 GMT"]) assert(setup().circuit.http429(invalid) === 60_000, "Invalid retry-after defaults.");
  const halfOpen = setup();
  open(halfOpen.circuit, halfOpen.clock);
  halfOpen.scheduler.advanceTo(45_000);
  halfOpen.circuit.http429("7");
  halfOpen.scheduler.advanceTo(51_999);
  assert(halfOpen.circuit.state() === "OPEN", "429 during half-open retains Retry-After hold.");
  halfOpen.scheduler.advanceTo(52_000);
  assert(halfOpen.circuit.state() === "HALF_OPEN", "429 half-open hold ends exactly at Retry-After.");
  passed("http429HonorsRetryAfter");
}
async function authTlsFailureRequiresRemediation(): Promise<void> {
  const value = setup();
  value.circuit.authOrTlsFailed();
  value.scheduler.advanceTo(1_799_999);
  assert(!value.circuit.mayAttemptConnection(), "Auth/TLS hold remains.");
  value.scheduler.advanceTo(1_800_000);
  assert(value.circuit.mayAttemptConnection() && value.events.includes("remediation"), "Remediation signal persists past hold.");
  assert(value.events.filter((event) => event === "remediation").length === 1, "Remediation is emitted once at failure.");
  const halfOpen = setup();
  open(halfOpen.circuit, halfOpen.clock);
  halfOpen.scheduler.advanceTo(45_000);
  halfOpen.circuit.authOrTlsFailed();
  halfOpen.scheduler.advanceTo(1_844_999);
  assert(halfOpen.circuit.state() === "OPEN", "Auth/TLS failure during half-open retains the remediation hold.");
  halfOpen.scheduler.advanceTo(1_845_000);
  assert(halfOpen.circuit.state() === "HALF_OPEN", "Auth/TLS half-open hold ends exactly at 1,800,000 ms.");
  assert(halfOpen.events.filter((event) => event === "remediation").length === 1, "Half-open remediation is not repeated after its hold.");
  passed("authTlsFailureRequiresRemediation");
}
async function circuitParametersAgreeAcrossEnabledPolicies(): Promise<void> {
  assert(agreedProviderPolicy([policy, { ...policy }]).heartbeatTimeoutMs === 5_000, "Agreeing rows return policy.");
  for (const key of Object.keys(policy) as (keyof ProviderPolicy)[]) { let thrown = false; try { agreedProviderPolicy([policy, { ...policy, [key]: policy[key] + 1 }]); } catch (error) { thrown = String(error).includes(key); } assert(thrown, `Names differing ${key}.`); }
  let empty = false;
  try { agreedProviderPolicy([]); } catch { empty = true; }
  assert(empty, "No rows throws.");
  passed("circuitParametersAgreeAcrossEnabledPolicies");
}
async function ordinaryRejectsAndIdempotencyConflictNeverCountAsFailedAttempts(): Promise<void> {
  const value = setup();
  for (let count = 0; count < 50; count += 1) value.circuit.heartbeat("ETH", String(100 - count), "1", "1", count % 2 === 0);
  value.port.appendOutcome = "IDEMPOTENCY_CONFLICT";
  await value.circuit.validTicker("ETH", request);
  assert(value.circuit.state() === "CLOSED" && !value.events.some((event) => event.startsWith("failure:")), "Invalid and out-of-sequence heartbeats plus idempotency conflicts never fail circuit.");
  const idempotency = setup();
  idempotency.circuit.beginReady(["ETH", "BTC"], []);
  idempotency.port.appendOutcome = "IDEMPOTENCY_CONFLICT";
  await idempotency.circuit.validTicker("BTC", { ...request, instrumentId: "BTC" });
  assert(idempotency.events.length === 0, "Idempotency conflict produces no failed attempt event.");
  open(idempotency.circuit, idempotency.clock);
  idempotency.scheduler.advanceTo(45_000);
  idempotency.circuit.consumeConnectionAttempt();
  idempotency.circuit.productAssertionsPassed();
  idempotency.circuit.subscriptionsAcknowledged();
  idempotency.port.appendOutcome = "ACCEPTED";
  await idempotency.circuit.validTicker("ETH", request);
  assert(idempotency.circuit.state() === "SETTLING", "Idempotency conflict human-halts its instrument, so readiness no longer waits for it.");
  const priceJump = setup();
  priceJump.circuit.beginReady(["ETH", "BTC"], []);
  priceJump.port.appendOutcome = "PRICE_JUMP_HALT";
  await priceJump.circuit.validTicker("BTC", { ...request, instrumentId: "BTC" });
  assert(priceJump.events.length === 0, "Price jump halt produces no failed attempt event.");
  open(priceJump.circuit, priceJump.clock);
  priceJump.scheduler.advanceTo(45_000);
  priceJump.circuit.consumeConnectionAttempt();
  priceJump.circuit.productAssertionsPassed();
  priceJump.circuit.subscriptionsAcknowledged();
  priceJump.port.appendOutcome = "ACCEPTED";
  await priceJump.circuit.validTicker("ETH", request);
  assert(priceJump.circuit.state() === "SETTLING", "Price jump halt human-halts without delaying readiness.");
  passed("ordinaryRejectsAndIdempotencyConflictNeverCountAsFailedAttempts");
}

void (async () => {
  await heartbeatAheadSettlesBeforeReconnect();
  await heartbeatAheadFourHeartbeatsAcross2500msRebaselines();
  await heartbeatBehindMatchDoesNotHalt();
  await heartbeatSequenceLowerOnlyIsOutOfSequence();
  await heartbeatTimeoutAt5000msForcesFailedReconnect();
  await reconnectRebaselineReturnsAvailableAfterAutomaticEvent();
  await disconnectCountsFailedAttempt();
  await seededBackoffIsDeterministic();
  await backoffAttemptOneAndJitterBounds();
  await reconnectStormOpensProviderCircuit();
  await halfOpenTimesOutAtTenSeconds();
  await halfOpenSettlesAfterFourHeartbeatsAcross3000ms();
  await partialOutageLeavesHumanHaltLatched();
  await partialOutageExcludesHumanHaltedInstrumentFromHalfOpen();
  await malformedThresholdReconnects();
  await http429HonorsRetryAfter();
  await authTlsFailureRequiresRemediation();
  await circuitParametersAgreeAcrossEnabledPolicies();
  await ordinaryRejectsAndIdempotencyConflictNeverCountAsFailedAttempts();
})();
