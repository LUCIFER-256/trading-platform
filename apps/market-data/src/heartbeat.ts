import type { Clock, TimerScheduler, TimerToken } from "./ports";

export type HeartbeatResult = "ACCEPTED" | "PENDING" | "OUT_OF_SEQUENCE" | "INVALID" | "AHEAD_CONFIRMED";

export class HeartbeatTracker {
  private readonly aheadAt = new Map<string, number[]>();
  private readonly sequence = new Map<string, bigint>();
  private timeout: TimerToken | undefined;

  public constructor(
    private readonly clock: Clock,
    private readonly scheduler: TimerScheduler,
    private readonly timeoutMs: number,
    private readonly aheadCount: number,
    private readonly aheadSpanMs: number,
    private readonly onTimeout: () => void,
  ) {}

  public observe(instrumentId: string, sequence: string, lastTradeId: string, lastMatchedTradeId: string | undefined, valid: boolean): HeartbeatResult {
    this.armTimeout();
    const current = BigInt(sequence);
    const previous = this.sequence.get(instrumentId);
    this.sequence.set(instrumentId, current);
    if (!valid) return "INVALID";
    if (previous !== undefined && current < previous) return "OUT_OF_SEQUENCE";
    if (lastMatchedTradeId === undefined || BigInt(lastTradeId) <= BigInt(lastMatchedTradeId)) {
      this.aheadAt.delete(instrumentId);
      return "ACCEPTED";
    }
    const times = this.aheadAt.get(instrumentId) ?? [];
    times.push(this.clock.nowMs());
    this.aheadAt.set(instrumentId, times);
    return times.length >= this.aheadCount && times[times.length - 1]! - times[0]! >= this.aheadSpanMs ? "AHEAD_CONFIRMED" : "PENDING";
  }

  public cancel(): void {
    if (this.timeout !== undefined) this.scheduler.cancel(this.timeout);
    this.timeout = undefined;
  }

  public arm(): void {
    this.armTimeout();
  }

  private armTimeout(): void {
    this.cancel();
    this.timeout = this.scheduler.schedule(this.timeoutMs, () => this.onTimeout());
  }
}
