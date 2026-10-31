import {
  createDedicatedConnection,
  type DatabaseConfigurationInput,
  type DedicatedConnection,
} from "../../../packages/database/src";
import type { TimerScheduler, TimerToken } from "./ports";

export interface AdvisoryLockConnection {
  query(statement: string): Promise<readonly { readonly locked?: boolean }[]>;
  onLost(listener: () => void): void;
  close(): Promise<void>;
}

export interface AdvisoryLockConnectionFactory {
  connect(): Promise<AdvisoryLockConnection>;
}

export function createAdvisoryLockConnectionFactory(
  input: DatabaseConfigurationInput,
): AdvisoryLockConnectionFactory {
  return {
    async connect(): Promise<AdvisoryLockConnection> {
      try {
        return asAdvisoryConnection(await createDedicatedConnection(input));
      } catch {
        throw new AdvisoryLockError("CONNECTION");
      }
    },
  };
}

function asAdvisoryConnection(connection: DedicatedConnection): AdvisoryLockConnection {
  return {
    query: (statement) => connection.query<{ readonly locked?: boolean }>(statement),
    onLost: (listener) => connection.onLost(listener),
    close: () => connection.close(),
  };
}

export class AdvisoryLockError extends Error {
  public readonly name = "AdvisoryLockError";

  public constructor(readonly code: "UNAVAILABLE" | "CONNECTION") {
    super(
      code === "UNAVAILABLE"
        ? "Market-data engine lock is already held."
        : "Market-data engine lock connection failed.",
    );
  }
}

const ACQUIRE = "select pg_try_advisory_lock(hashtextextended('platform.market_data.engine.v1', 0)) as locked";
const PROBE = "select 1";

export class AdvisoryLock {
  private timer: TimerToken | undefined;
  private probeDeadline: TimerToken | undefined;
  private released = false;
  private aborted = false;

  private constructor(
    private readonly connection: AdvisoryLockConnection,
    private readonly scheduler: TimerScheduler,
    private readonly abort: () => void,
  ) {}

  public static async acquire(
    factory: AdvisoryLockConnectionFactory,
    scheduler: TimerScheduler,
    abort: () => void,
  ): Promise<AdvisoryLock> {
    let connection: AdvisoryLockConnection | undefined;
    try {
      connection = await factory.connect();
      const rows = await connection.query(ACQUIRE);
      if (rows[0]?.locked !== true) {
        await connection.close();
        throw new AdvisoryLockError("UNAVAILABLE");
      }
      const lock = new AdvisoryLock(connection, scheduler, abort);
      connection.onLost(() => lock.abortOnce());
      lock.scheduleProbe();
      return lock;
    } catch (error) {
      if (error instanceof AdvisoryLockError) throw error;
      if (connection !== undefined) await connection.close().catch(() => undefined);
      throw new AdvisoryLockError("CONNECTION");
    }
  }

  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.timer !== undefined) this.scheduler.cancel(this.timer);
    if (this.probeDeadline !== undefined) this.scheduler.cancel(this.probeDeadline);
    await this.connection.close();
  }

  private scheduleProbe(): void {
    this.timer = this.scheduler.schedule(1000, () => {
      void this.probe();
    });
  }

  private async probe(): Promise<void> {
    if (this.released || this.aborted) return;
    this.probeDeadline = this.scheduler.schedule(2000, () => this.abortOnce());
    try {
      await this.connection.query(PROBE);
      if (this.probeDeadline !== undefined) this.scheduler.cancel(this.probeDeadline);
      if (!this.released && !this.aborted) this.scheduleProbe();
    } catch {
      this.abortOnce();
    }
  }

  private abortOnce(): void {
    if (this.released || this.aborted) return;
    this.aborted = true;
    if (this.probeDeadline !== undefined) this.scheduler.cancel(this.probeDeadline);
    this.abort();
  }
}
