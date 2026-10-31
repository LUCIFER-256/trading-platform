import {
  AdvisoryLock,
  AdvisoryLockError,
  type AdvisoryLockConnection,
} from "../../apps/market-data/src/advisory-lock";
import { FakeClock, FakeScheduler } from "./support/market-data-fakes";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

class FakeConnection implements AdvisoryLockConnection {
  public closed = 0;
  public probes = 0;
  public locked = true;
  public failProbe = false;
  public hangProbe = false;
  private listener: (() => void) | undefined;
  private resolveProbe: (() => void) | undefined;

  public async query(statement: string): Promise<readonly { readonly locked?: boolean }[]> {
    if (statement.includes("pg_try")) return [{ locked: this.locked }];
    this.probes += 1;
    if (this.failProbe) throw new Error("probe failure");
    if (this.hangProbe) {
      await new Promise<void>((resolve) => {
        this.resolveProbe = resolve;
      });
    }
    return [{}];
  }

  public onLost(listener: () => void): void {
    this.listener = listener;
  }

  public lose(): void {
    this.listener?.();
  }

  public resolveLateProbe(): void {
    this.resolveProbe?.();
  }

  public async close(): Promise<void> {
    this.closed += 1;
  }
}

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function unitAdvisoryLockAllowsSingleWriter(): Promise<void> {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const first = new FakeConnection();
  const second = new FakeConnection();
  const lock = await AdvisoryLock.acquire({ connect: async () => first }, scheduler, () => undefined);
  second.locked = false;
  let refusal: unknown;
  try {
    await AdvisoryLock.acquire({ connect: async () => second }, scheduler, () => undefined);
  } catch (error) {
    refusal = error;
  }
  assert(refusal instanceof AdvisoryLockError && refusal.code === "UNAVAILABLE", "Second writer must refuse.");
  assert(second.closed === 1, "Refused writer must close its dedicated connection.");
  await lock.release();
  await lock.release();
  assert(first.closed === 1, "Release must close exactly once.");
  console.log("unitAdvisoryLockAllowsSingleWriter");
}

async function unitAdvisoryLockLossAbortsOnce(): Promise<void> {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const connection = new FakeConnection();
  let aborts = 0;
  const lock = await AdvisoryLock.acquire({ connect: async () => connection }, scheduler, () => {
    aborts += 1;
  });
  assert(aborts === 0, "A healthy lock must not abort.");
  connection.lose();
  assert(Number(aborts) === 1, "Loss must abort immediately, before any probe.");
  connection.lose();
  connection.failProbe = true;
  scheduler.advanceTo(1000);
  await turn();
  scheduler.advanceTo(2000);
  await turn();
  assert(Number(aborts) === 1, "Loss, repeated loss and a failing probe must abort exactly once.");
  assert(connection.probes === 0, "An aborted lock must not probe again.");
  await lock.release();

  const probeClock = new FakeClock();
  const probeScheduler = new FakeScheduler(probeClock);
  const failing = new FakeConnection();
  let probeAborts = 0;
  const probed = await AdvisoryLock.acquire({ connect: async () => failing }, probeScheduler, () => {
    probeAborts += 1;
  });
  failing.failProbe = true;
  probeScheduler.advanceTo(1000);
  await turn();
  probeScheduler.advanceTo(2000);
  await turn();
  assert(probeAborts === 1, "A failing probe alone must abort exactly once.");
  await probed.release();
  console.log("unitAdvisoryLockLossAbortsOnce");
}

async function unitAdvisoryLockReleaseIgnoresLoss(): Promise<void> {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const connection = new FakeConnection();
  let aborts = 0;
  const lock = await AdvisoryLock.acquire({ connect: async () => connection }, scheduler, () => {
    aborts += 1;
  });
  await lock.release();
  connection.lose();
  assert(aborts === 0, "Loss after release must not abort.");
  console.log("unitAdvisoryLockReleaseIgnoresLoss");
}

async function unitAdvisoryLockProbeDeadlineAndCadence(): Promise<void> {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const connection = new FakeConnection();
  let aborts = 0;
  const lock = await AdvisoryLock.acquire({ connect: async () => connection }, scheduler, () => {
    aborts += 1;
  });
  scheduler.advanceTo(1000);
  await turn();
  scheduler.advanceTo(2000);
  await turn();
  scheduler.advanceTo(3000);
  await turn();
  assert(connection.probes === 3, "Three successful one-second probes must run.");
  connection.hangProbe = true;
  scheduler.advanceTo(4000);
  await turn();
  scheduler.advanceTo(5999);
  assert(Number(aborts) === 0, "A pending probe must not abort before two seconds.");
  scheduler.advanceTo(6000);
  assert(Number(aborts) === 1, "A pending probe must abort at two seconds.");
  connection.resolveLateProbe();
  await turn();
  scheduler.advanceTo(8000);
  assert(Number(connection.probes) === 4, "Late probe completion must not schedule another probe.");
  await lock.release();
  console.log("unitAdvisoryLockProbeDeadlineAndCadence");
}

void unitAdvisoryLockAllowsSingleWriter()
  .then(unitAdvisoryLockLossAbortsOnce)
  .then(unitAdvisoryLockReleaseIgnoresLoss)
  .then(unitAdvisoryLockProbeDeadlineAndCadence)
  .catch((error: unknown) => {
    throw error;
  });
