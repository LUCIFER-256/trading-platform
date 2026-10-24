import type { TimerScheduler, TimerToken } from "./ports";

export type QueueRecoveryReason = "QUEUE_OVERFLOW" | "PERSISTENCE_TIMEOUT";
export interface QueueRecoveryPort {
  recover(reason: QueueRecoveryReason, discardedCount: number): void;
  failedAttempt(errorCode: "PERSISTENCE"): void;
}

export class PersistenceQueue<T> {
  private readonly waiting: T[] = [];
  private writing = false;
  private stopped = false;
  private generation = 0;
  private overflowEpisode = false;
  public constructor(
    private readonly write: (item: T) => Promise<void>,
    private readonly scheduler: TimerScheduler,
    private readonly recovery: QueueRecoveryPort,
    private readonly capacity = 1_024,
  ) {}

  public enqueue(item: T): boolean {
    if (this.stopped) return false;
    if (this.size() >= this.capacity) {
      if (!this.overflowEpisode) {
        this.overflowEpisode = true;
        this.recovery.recover("QUEUE_OVERFLOW", 0);
        this.recovery.failedAttempt("PERSISTENCE");
      }
      return false;
    }
    this.waiting.push(item);
    void this.drain();
    return true;
  }

  public reset(): void {
    this.stopped = false;
  }

  public discard(): void {
    this.stopped = true;
    this.generation += 1;
    this.writing = false;
    this.waiting.length = 0;
    this.overflowEpisode = false;
  }

  public size(): number { return this.waiting.length + (this.writing ? 1 : 0); }

  private stop(reason: QueueRecoveryReason): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.writing = false;
    const discardedCount = this.waiting.length;
    this.waiting.length = 0;
    this.overflowEpisode = false;
    this.recovery.recover(reason, discardedCount);
    this.recovery.failedAttempt("PERSISTENCE");
  }

  private async drain(): Promise<void> {
    if (this.writing || this.stopped) return;
    const generation = this.generation;
    this.writing = true;
    while (this.waiting.length > 0 && !this.stopped && generation === this.generation) {
      await this.writeOne(this.waiting.shift()!, generation);
    }
    if (generation !== this.generation) return;
    this.writing = false;
    if (this.waiting.length === 0) this.overflowEpisode = false;
  }

  private async writeOne(item: T, generation: number): Promise<void> {
    let token: TimerToken | undefined;
    token = this.scheduler.schedule(1_000, () => {
      if (generation === this.generation) this.stop("PERSISTENCE_TIMEOUT");
    });
    try {
      await this.write(item);
    } catch {
      if (generation === this.generation) this.stop("PERSISTENCE_TIMEOUT");
    } finally {
      if (token !== undefined) this.scheduler.cancel(token);
    }
  }
}
