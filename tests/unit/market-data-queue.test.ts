import { PersistenceQueue, type QueueRecoveryReason } from "../../apps/market-data/src/queue";
import { QualityAggregator } from "../../apps/market-data/src/quality-aggregator";
import { FakeClock, FakeScheduler, InMemoryPersistencePort } from "./support/market-data-fakes";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function passed(name: string): void { console.log(name); }
function flush(): Promise<void> { return Promise.resolve().then(() => Promise.resolve()); }
async function flushTurns(turns: number): Promise<void> { for (let turn = 0; turn < turns; turn += 1) await flush(); }

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => { resolveValue = resolve; rejectValue = reject; });
  return {
    promise,
    resolve: (value) => resolveValue!(value),
    reject: (error) => rejectValue!(error),
  };
}

function queueSetup(write: (item: number) => Promise<void>): { clock: FakeClock; scheduler: FakeScheduler; recoveries: string[]; failures: string[]; queue: PersistenceQueue<number> } {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const recoveries: string[] = [];
  const failures: string[] = [];
  const queue = new PersistenceQueue(write, scheduler, {
    recover: (reason: QueueRecoveryReason, discardedCount: number) => recoveries.push(`${reason}:${discardedCount}`),
    failedAttempt: (errorCode) => failures.push(errorCode),
  });
  return { clock, scheduler, recoveries, failures, queue };
}

async function queueOverflowRecordsRecovery(): Promise<void> {
  const first = deferred<void>();
  const written: number[] = [];
  const value = queueSetup(async (item) => {
    written.push(item);
    if (item === 0) await first.promise;
  });
  for (let item = 0; item < 1_024; item += 1) assert(value.queue.enqueue(item), "The first 1,024 items are accepted.");
  for (let item = 1_024; item < 1_034; item += 1) assert(!value.queue.enqueue(item), "Every overflow item is rejected.");
  assert(JSON.stringify(value.recoveries) === JSON.stringify(["QUEUE_OVERFLOW:0"]), "Overflow recovery is synchronous and proves only the incoming item was discarded.");
  assert(JSON.stringify(value.failures) === JSON.stringify(["PERSISTENCE"]), "Overflow reports the safe persistence error code.");
  first.resolve();
  await flushTurns(1_024);
  assert(JSON.stringify(written) === JSON.stringify(Array.from({ length: 1_024 }, (_, item) => item)), "Accepted items write in FIFO order and the rejected item is never written.");
  for (let item = 2_000; item < 3_024; item += 1) assert(value.queue.enqueue(item), "Queue accepts a new full episode after draining.");
  assert(!value.queue.enqueue(3_024), "A new episode rejects its 1,025th item.");
  assert(JSON.stringify(value.recoveries) === JSON.stringify(["QUEUE_OVERFLOW:0", "QUEUE_OVERFLOW:0"]), "A drained queue starts a second overflow episode.");
  assert(JSON.stringify(value.failures) === JSON.stringify(["PERSISTENCE", "PERSISTENCE"]), "Each overflow episode reports one failed attempt.");
  const underCapacity = queueSetup(async () => undefined);
  for (let item = 0; item < 1_023; item += 1) assert(underCapacity.queue.enqueue(item), "One item inside capacity is accepted.");
  assert(underCapacity.recoveries.length === 0, "1,023 enqueues do not overflow.");
  passed("queueOverflowRecordsRecovery");
}

async function persistenceTimeoutRecordsRecovery(): Promise<void> {
  const completes = deferred<void>();
  const timely = queueSetup(async () => completes.promise);
  assert(timely.queue.enqueue(1), "Timed write is accepted.");
  timely.scheduler.advanceTo(999);
  completes.resolve();
  await flush();
  assert(timely.recoveries.length === 0, "Completion at 999 ms does not time out.");
  timely.scheduler.advanceTo(2_000);
  assert(timely.recoveries.length === 0, "Completed write cancels its deadline timer.");
  const late = deferred<void>();
  const timeoutWrites: number[] = [];
  const timeout = queueSetup(async (item) => {
    timeoutWrites.push(item);
    if (item === 1) await late.promise;
  });
  assert(timeout.queue.enqueue(1) && timeout.queue.enqueue(2) && timeout.queue.enqueue(3), "Timeout scenario queues three items.");
  timeout.scheduler.advanceTo(1_000);
  assert(JSON.stringify(timeout.recoveries) === JSON.stringify(["PERSISTENCE_TIMEOUT:2"]), "Timeout records exactly the two waiting items once.");
  assert(JSON.stringify(timeout.failures) === JSON.stringify(["PERSISTENCE"]), "Rejected persistence uses the safe error code.");
  assert(!timeout.queue.enqueue(4) && timeout.recoveries.length === 1, "Stopped queue rejects without further recovery events.");
  timeout.queue.reset();
  assert(timeout.queue.enqueue(3), "Reset accepts a new item while the abandoned write remains pending.");
  await flush();
  assert(JSON.stringify(timeoutWrites) === JSON.stringify([1, 3]) && timeout.queue.size() === 0, "Reset starts a fresh drain while the abandoned write remains pending.");
  late.reject(new Error("late rejection"));
  await flush();
  assert(timeout.recoveries.length === 1, "Late rejection records nothing further.");
  let rejectWrites = true;
  const writtenAfterReset: number[] = [];
  const rejected = queueSetup(async (item) => {
    if (rejectWrites) throw new Error("write rejected");
    writtenAfterReset.push(item);
  });
  assert(rejected.queue.enqueue(1) && rejected.queue.enqueue(2), "Rejecting write accepts work before failure.");
  await flush();
  assert(JSON.stringify(rejected.recoveries) === JSON.stringify(["PERSISTENCE_TIMEOUT:1"]), "Rejecting write is handled as a timeout with exact discarded count.");
  assert(JSON.stringify(rejected.failures) === JSON.stringify(["PERSISTENCE"]), "Rejecting write reports safe persistence code.");
  rejectWrites = false;
  rejected.queue.reset();
  assert(rejected.queue.enqueue(3), "Reset clears stopped state after a rejected write.");
  await flush();
  assert(JSON.stringify(writtenAfterReset) === JSON.stringify([3]), "Reset queue accepts and writes again.");
  passed("persistenceTimeoutRecordsRecovery");
}

async function queueAbandonedWriteCannotRunAlongsideNewGeneration(): Promise<void> {
  const oldWrite = deferred<void>();
  const three = deferred<void>();
  const four = deferred<void>();
  const five = deferred<void>();
  const started: number[] = [];
  const completed: number[] = [];
  let newGenerationInFlight = 0;
  let maxNewGenerationInFlight = 0;
  const value = queueSetup(async (item) => {
    if (item === 1) { await oldWrite.promise; return; }
    started.push(item);
    newGenerationInFlight += 1;
    maxNewGenerationInFlight = Math.max(maxNewGenerationInFlight, newGenerationInFlight);
    const completion = item === 3 ? three : item === 4 ? four : five;
    await completion.promise;
    newGenerationInFlight -= 1;
    completed.push(item);
  });
  assert(value.queue.enqueue(1), "The abandoned write is accepted.");
  value.scheduler.advanceTo(1_000);
  assert(JSON.stringify(value.recoveries) === JSON.stringify(["PERSISTENCE_TIMEOUT:0"]), "The timeout records one recovery.");
  value.queue.reset();
  assert(value.queue.enqueue(3) && value.queue.enqueue(4), "The new generation accepts items three and four.");
  await flushTurns(2);
  assert(JSON.stringify(started) === JSON.stringify([3]) && maxNewGenerationInFlight === 1, "Item three starts immediately and item four waits.");
  oldWrite.resolve();
  await flushTurns(2);
  assert(JSON.stringify(started) === JSON.stringify([3]) && newGenerationInFlight === 1, "Late completion of the abandoned write cannot start item four.");
  assert(value.queue.size() === 2, "Late completion cannot clear the new generation writing marker.");
  assert(value.recoveries.length === 1, "Late completion records no additional recovery.");
  three.resolve();
  await flushTurns(2);
  assert(JSON.stringify(started) === JSON.stringify([3, 4]) && maxNewGenerationInFlight === 1, "Item four starts only after item three completes.");
  four.resolve();
  await flushTurns(2);
  assert(value.queue.enqueue(5), "Item five is accepted after item four completes.");
  await flushTurns(2);
  assert(JSON.stringify(started) === JSON.stringify([3, 4, 5]) && maxNewGenerationInFlight === 1, "Item five is serialized behind item four.");
  five.resolve();
  await flushTurns(2);
  assert(JSON.stringify(completed) === JSON.stringify([3, 4, 5]), "New-generation writes complete strictly in order.");
  passed("queueAbandonedWriteCannotRunAlongsideNewGeneration");
}

async function queueDiscardStopsAndClearsWaitingItems(): Promise<void> {
  const oldWrite = deferred<void>();
  const written: number[] = [];
  const value = queueSetup(async (item) => {
    if (item === 1) {
      await oldWrite.promise;
      return;
    }
    written.push(item);
  });
  assert(value.queue.enqueue(1), "Blocked old-generation item is accepted.");
  assert(value.queue.enqueue(2), "Waiting old-generation item is accepted.");
  value.queue.discard();
  assert(value.queue.size() === 0, "Discard clears waiting and writing size.");
  assert(!value.queue.enqueue(3), "Discard rejects work until reset.");
  oldWrite.resolve();
  await flushTurns(3);
  assert(
    value.recoveries.length === 0 && value.failures.length === 0,
    "Late old write completion records no recovery or failure.",
  );
  value.queue.reset();
  assert(value.queue.enqueue(4), "Reset accepts new-generation work.");
  await flushTurns(3);
  assert(
    JSON.stringify(written) === JSON.stringify([4]),
    "Only the post-reset item writes after discard.",
  );
  passed("queueDiscardStopsAndClearsWaitingItems");
}

async function rejectFloodAggregates(): Promise<void> {
  const clock = new FakeClock();
  const aggregator = new QualityAggregator(clock);
  const persistence = new InMemoryPersistencePort();
  for (let index = 0; index < 10_000; index += 1) aggregator.reject("provider", "instrument", "MALFORMED");
  await aggregator.flushClosed(persistence);
  assert(aggregator.pending().length === 1 && aggregator.pending()[0]?.count === 10_000, "Reject flood aggregates in memory.");
  assert(persistence.qualityAppendCalls.length === 0, "No persistence call occurs before a bucket closes.");
  clock.now = 60_000;
  await aggregator.flushClosed(persistence);
  assert(Array.from(persistence.qualityAppendCalls).length === 1, "Closed bucket flushes once.");
  passed("rejectFloodAggregates");
}

async function delayedBurstAggregates(): Promise<void> {
  const clock = new FakeClock();
  const aggregator = new QualityAggregator(clock);
  const persistence = new InMemoryPersistencePort();
  aggregator.reject("provider", "instrument", "MALFORMED");
  aggregator.reject("provider", "instrument", "MALFORMED");
  clock.now = 60_000;
  aggregator.reject("provider", "instrument", "MALFORMED");
  aggregator.reject("provider", "instrument", "MALFORMED");
  aggregator.reject("provider", "instrument", "MALFORMED");
  await aggregator.flushClosed(persistence);
  clock.now = 120_000;
  await aggregator.flushClosed(persistence);
  assert(persistence.qualityAppendCalls.length === 2, "Exactly two closed buckets flush once each.");
  assert(JSON.stringify(persistence.qualityAppendCalls.map((request) => Number(request.count))) === JSON.stringify([2, 3]), "Each closed bucket preserves its exact count.");
  assert(persistence.qualityAppendCalls[0]!.flushId !== persistence.qualityAppendCalls[1]!.flushId, "Each bucket has its own flush id.");
  assert(persistence.qualityAppendCalls.every((request) => request.count > 0n), "Every flush count is positive.");
  passed("delayedBurstAggregates");
}

async function qualityBucketFlushRetryDoesNotDoubleCount(): Promise<void> {
  const clock = new FakeClock();
  const aggregator = new QualityAggregator(clock);
  const persistence = new InMemoryPersistencePort();
  for (let index = 0; index < 7; index += 1) aggregator.reject("provider", "instrument", "MALFORMED");
  clock.now = 60_000;
  persistence.failQualityAppend = true;
  let failed = false;
  try { await aggregator.flushClosed(persistence); } catch { failed = true; }
  assert(failed && aggregator.pending().length === 1, "Failed flush keeps its bucket for retry.");
  const flushId = aggregator.pending()[0]!.flushId;
  persistence.failQualityAppend = false;
  await aggregator.flushClosed(persistence);
  assert(persistence.qualityAppendCalls.at(-1)?.flushId === flushId && persistence.buckets.get(flushId) === 7n, "Retry uses the same flush id and stores the exact count.");
  const lostAck = new QualityAggregator(clock);
  const lostPersistence = new InMemoryPersistencePort();
  for (let index = 0; index < 5; index += 1) lostAck.reject("provider", "other", "MALFORMED");
  clock.now = 120_000;
  lostPersistence.loseNextQualityAcknowledgement = true;
  let acknowledgementLost = false;
  try { await lostAck.flushClosed(lostPersistence); } catch { acknowledgementLost = true; }
  const lostId = lostAck.pending()[0]!.flushId;
  await lostAck.flushClosed(lostPersistence);
  assert(acknowledgementLost && lostPersistence.buckets.get(lostId) === 5n, "Lost acknowledgement retry is a duplicate receipt no-op.");
  passed("qualityBucketFlushRetryDoesNotDoubleCount");
}

async function qualityBucketFlushLossBound(): Promise<void> {
  const clock = new FakeClock();
  const persistence = new InMemoryPersistencePort();
  const aggregator = new QualityAggregator(clock);
  for (let index = 0; index < 4; index += 1) aggregator.reject("provider", "kept", "MALFORMED");
  clock.now = 60_000;
  for (let index = 0; index < 3; index += 1) aggregator.reject("provider", "lost", "MALFORMED");
  persistence.failQualityAppend = true;
  let failed = false;
  try { await aggregator.flushClosed(persistence); } catch { failed = true; }
  assert(failed && aggregator.pending().length === 2, "Failed flush retains counts for retry.");
  persistence.failQualityAppend = false;
  await aggregator.flushClosed(persistence);
  assert([...persistence.buckets.values()].reduce((sum, count) => sum + count, 0n) === 4n, "Only the closed bucket flushes; the current bucket remains pending.");
  const lost = aggregator.pending().reduce((sum, bucket) => sum + BigInt(bucket.count), 0n);
  assert(lost === 3n, "Simulated crash loses exactly the unacknowledged current-window count.");
  assert(lost <= 3n && persistence.buckets.size === 1, "Loss is bounded to one 60-second key and does not affect flushed keys.");
  passed("qualityBucketFlushLossBound");
}

void (async () => {
  await queueOverflowRecordsRecovery();
  await persistenceTimeoutRecordsRecovery();
  await queueAbandonedWriteCannotRunAlongsideNewGeneration();
  await queueDiscardStopsAndClearsWaitingItems();
  await rejectFloodAggregates();
  await delayedBurstAggregates();
  await qualityBucketFlushRetryDoesNotDoubleCount();
  await qualityBucketFlushLossBound();
})();
