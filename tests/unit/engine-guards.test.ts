import {
  EngineStoppedError,
  GuardedPersistence,
  StoppableTransport,
  TrackingScheduler,
} from "../../apps/market-data/src/engine-guards";
import type { PersistencePort, TimerScheduler, TimerToken } from "../../apps/market-data/src/ports";
import type { WireCallbacks, WireTransport } from "../../apps/market-data/src/coinbase/ws-client";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

class ManualScheduler implements TimerScheduler {
  public readonly timers = new Map<TimerToken, () => void>();
  private next = 1;

  public schedule(_afterMs: number, callback: () => void): TimerToken {
    const token = this.next++;
    this.timers.set(token, callback);
    return token;
  }

  public cancel(token: TimerToken): void {
    this.timers.delete(token);
  }

  public fire(token: TimerToken): void {
    const callback = this.timers.get(token);
    this.timers.delete(token);
    callback?.();
  }
}

class RecordingTransport implements WireTransport {
  public readonly calls: string[] = [];

  public open(_endpoint: string, _callbacks: WireCallbacks): void {
    this.calls.push("open");
  }

  public subscribe(_productIds: readonly string[]): void {
    this.calls.push("subscribe");
  }

  public close(): void {
    this.calls.push("close");
  }
}

function unitTrackingSchedulerCancelsEverythingOnStop(): void {
  const inner = new ManualScheduler();
  const scheduler = new TrackingScheduler(inner);
  let fired = 0;
  const first = scheduler.schedule(10, () => { fired += 1; });
  scheduler.schedule(20, () => { fired += 1; });
  assert(scheduler.pending() === 2, "Two timers must be tracked.");
  inner.fire(first);
  assert(fired === 1 && scheduler.pending() === 1, "A fired timer must leave the tracked set.");
  scheduler.stop();
  assert(inner.timers.size === 0, "Stop must cancel every inner timer.");
  assert(scheduler.pending() === 0, "Stop must clear tracking.");
  assert(scheduler.schedule(5, () => { fired += 1; }) === -1, "Scheduling after stop must be refused.");
  assert(inner.timers.size === 0, "A refused schedule must not reach the inner scheduler.");
  scheduler.cancel(-1);
  console.log("unitTrackingSchedulerCancelsEverythingOnStop");
}

function unitTrackingSchedulerSuppressesCallbackAfterStop(): void {
  const inner = new ManualScheduler();
  const scheduler = new TrackingScheduler(inner);
  let fired = 0;
  const token = scheduler.schedule(10, () => { fired += 1; });
  const callback = inner.timers.get(token);
  scheduler.stop();
  callback?.();
  assert(fired === 0, "A callback raced with stop must not run.");
  console.log("unitTrackingSchedulerSuppressesCallbackAfterStop");
}

function unitStoppableTransportIgnoresUseAfterStop(): void {
  const inner = new RecordingTransport();
  const transport = new StoppableTransport(inner);
  transport.open("wss://example.invalid", {} as WireCallbacks);
  transport.subscribe(["BTC-USD"]);
  transport.stop();
  transport.open("wss://example.invalid", {} as WireCallbacks);
  transport.subscribe(["BTC-USD"]);
  assert(
    inner.calls.join(",") === "open,subscribe,close",
    `Transport must close and ignore later calls, got ${inner.calls.join(",")}.`,
  );
  console.log("unitStoppableTransportIgnoresUseAfterStop");
}

function fakePersistence(gate: Promise<void>): PersistencePort {
  return {
    appendObservation: async () => { await gate; return {} as never; },
    openHalt: async () => { await gate; return "halt"; },
    transitionState: async () => { await gate; },
    appendQualityBucket: async () => { await gate; },
  };
}

async function unitGuardedPersistenceRefusesAfterStopAndDrains(): Promise<void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const guarded = new GuardedPersistence(fakePersistence(gate));
  const scheduler = new ManualScheduler();
  const pending = guarded.openHalt({} as never);
  assert(guarded.inFlight() === 1, "An in-flight call must be tracked.");
  guarded.stop();
  let refused = false;
  try {
    await guarded.transitionState({} as never);
  } catch (error) {
    refused = error instanceof EngineStoppedError;
  }
  assert(refused, "A call after stop must be refused with EngineStoppedError.");
  const drained = guarded.drain(1000, scheduler);
  release();
  assert((await drained) === true, "Drain must report completion when calls settle.");
  assert((await pending) === "halt", "The in-flight call must still resolve.");
  assert(guarded.inFlight() === 0, "Settled calls must be forgotten.");
  assert(scheduler.timers.size === 0, "Drain must cancel its timeout.");
  console.log("unitGuardedPersistenceRefusesAfterStopAndDrains");
}

async function unitGuardedPersistenceDrainTimesOut(): Promise<void> {
  const gate = new Promise<void>(() => undefined);
  const guarded = new GuardedPersistence(fakePersistence(gate));
  const scheduler = new ManualScheduler();
  void guarded.appendQualityBucket({} as never);
  const drained = guarded.drain(1000, scheduler);
  const [token] = [...scheduler.timers.keys()];
  assert(token !== undefined, "Drain must arm a timeout.");
  scheduler.fire(token);
  assert((await drained) === false, "Drain must report false on timeout.");
  const idle = new GuardedPersistence(fakePersistence(Promise.resolve()));
  assert((await idle.drain(1, scheduler)) === true, "An idle drain must return at once.");
  console.log("unitGuardedPersistenceDrainTimesOut");
}

async function unitGuardedPersistenceForgetsFailedCalls(): Promise<void> {
  const failing: PersistencePort = {
    appendObservation: () => Promise.reject(new Error("boom")),
    openHalt: () => Promise.reject(new Error("boom")),
    transitionState: () => Promise.reject(new Error("boom")),
    appendQualityBucket: () => Promise.reject(new Error("boom")),
  };
  const guarded = new GuardedPersistence(failing);
  let caught = false;
  try {
    await guarded.appendObservation({} as never);
  } catch {
    caught = true;
  }
  await Promise.resolve();
  assert(caught, "The failure must propagate.");
  assert(guarded.inFlight() === 0, "A failed call must not stay tracked.");
  console.log("unitGuardedPersistenceForgetsFailedCalls");
}

let completed = 0;

process.on("exit", () => {
  if (completed !== 6) {
    console.error(`engine-guards test incomplete: ${completed} of 6 steps finished.`);
    process.exitCode = 1;
  }
});

async function main(): Promise<void> {
  unitTrackingSchedulerCancelsEverythingOnStop();
  completed += 1;
  unitTrackingSchedulerSuppressesCallbackAfterStop();
  completed += 1;
  unitStoppableTransportIgnoresUseAfterStop();
  completed += 1;
  await unitGuardedPersistenceRefusesAfterStopAndDrains();
  completed += 1;
  await unitGuardedPersistenceDrainTimesOut();
  completed += 1;
  await unitGuardedPersistenceForgetsFailedCalls();
  completed += 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
