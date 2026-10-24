import type { AppendObservationRequest, AppendQualityBucketRequest, Clock, OpenHaltRequest, PersistencePort, TimerScheduler, TimerToken, TransitionStateRequest } from "../../../apps/market-data/src/ports";
import type { AppendMarketDataObservationResult } from "../../../packages/market-data/src";

export class FakeClock implements Clock {
  public now = 0;
  public nowMs(): number { return this.now; }
}

interface Scheduled { readonly at: number; readonly callback: () => void; }
export class FakeScheduler implements TimerScheduler {
  private next = 1;
  private readonly timers = new Map<TimerToken, Scheduled>();
  public constructor(private readonly clock: FakeClock) {}
  public schedule(afterMs: number, callback: () => void): TimerToken { const token = this.next++; this.timers.set(token, { at: this.clock.now + afterMs, callback }); return token; }
  public cancel(token: TimerToken): void { this.timers.delete(token); }
  public advanceTo(target: number): void {
    for (;;) {
      const entry = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (entry === undefined) break;
      this.timers.delete(entry[0]);
      this.clock.now = entry[1].at;
      entry[1].callback();
    }
    this.clock.now = target;
  }
}

export class SeededPrng {
  public constructor(private state: number) {}
  public nextIntInclusive(min: number, max: number): number { this.state = (this.state * 1664525 + 1013904223) >>> 0; return min + this.state % (max - min + 1); }
}

export class InMemoryPersistencePort implements PersistencePort {
  public readonly calls: string[] = [];
  public readonly availability = new Map<string, string>();
  public readonly buckets = new Map<string, bigint>();
  public readonly qualityAppendCalls: AppendQualityBucketRequest[] = [];
  public readonly haltRequests: OpenHaltRequest[] = [];
  public readonly transitionRequests: TransitionStateRequest[] = [];
  public appendGate: Promise<void> | undefined;
  public appendOutcome: AppendMarketDataObservationResult["outcome"] = "ACCEPTED";
  public throwTransition = false;
  public failQualityAppend = false;
  public loseNextQualityAcknowledgement = false;
  public async appendObservation(request: AppendObservationRequest): Promise<AppendMarketDataObservationResult> {
    await this.appendGate;
    this.calls.push(`append:${request.instrumentId}`);
    if (this.appendOutcome === "IDEMPOTENCY_CONFLICT" || this.appendOutcome === "PRICE_JUMP_HALT") return { outcome: this.appendOutcome, observationId: null, haltId: "halt" };
    if (this.availability.get(request.instrumentId) !== "UNAVAILABLE_HUMAN_HALT") this.availability.set(request.instrumentId, "AVAILABLE");
    return { outcome: "ACCEPTED", observationId: "observation", haltId: null };
  }
  public async openHalt(request: OpenHaltRequest): Promise<string> { this.haltRequests.push(request); this.calls.push(`halt:${request.instrumentId}`); this.availability.set(request.instrumentId, "UNAVAILABLE_HUMAN_HALT"); return "halt"; }
  public async transitionState(request: TransitionStateRequest): Promise<void> {
    this.transitionRequests.push(request);
    if (this.throwTransition) throw new Error("transition failure");
    if (this.availability.get(request.instrumentId ?? "") === "UNAVAILABLE_HUMAN_HALT") throw new Error("Human halt cannot be cleared.");
    this.calls.push(`transition:${request.instrumentId ?? "provider"}:${request.newBaseAvailability}`);
    if (request.instrumentId !== null) this.availability.set(request.instrumentId, request.newBaseAvailability);
  }
  public async appendQualityBucket(request: AppendQualityBucketRequest): Promise<void> {
    this.qualityAppendCalls.push(request);
    if (this.failQualityAppend) throw new Error("quality append failure");
    const prior = this.buckets.get(request.flushId);
    if (prior === undefined) this.buckets.set(request.flushId, request.count);
    if (this.loseNextQualityAcknowledgement) {
      this.loseNextQualityAcknowledgement = false;
      throw new Error("quality acknowledgement lost");
    }
  }
}
