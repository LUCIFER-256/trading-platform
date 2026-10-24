import { HeartbeatTracker, type HeartbeatResult } from "./heartbeat";
import type { Clock, PersistencePort, Prng, TimerScheduler, TimerToken, TransitionStateRequest } from "./ports";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN" | "SETTLING";
export type RecoveryReason = "HEARTBEAT_TIMEOUT" | "HEARTBEAT_GAP" | "QUEUE_OVERFLOW" | "PERSISTENCE_TIMEOUT";
export interface ProviderPolicy {
  readonly heartbeatTimeoutMs: number;
  readonly circuitFailureThreshold: number;
  readonly circuitFailureWindowMs: number;
  readonly circuitCooldownMs: number;
  readonly circuitHalfOpenReadyMs: number;
  readonly heartbeatAheadCount: number;
  readonly heartbeatAheadSpanMs: number;
  readonly heartbeatSettleCount: number;
  readonly heartbeatSettleSpanMs: number;
}

export interface CircuitEvents {
  recovery(reason: RecoveryReason, discardedCount?: number): void;
  reconnect(): void;
  failedAttempt(reason: string): void;
  remediationRequired(): void;
}
const policyKeys: readonly (keyof ProviderPolicy)[] = ["heartbeatTimeoutMs", "circuitFailureThreshold", "circuitFailureWindowMs", "circuitCooldownMs", "circuitHalfOpenReadyMs", "heartbeatAheadCount", "heartbeatAheadSpanMs", "heartbeatSettleCount", "heartbeatSettleSpanMs"];

export function agreedProviderPolicy(rows: readonly ProviderPolicy[]): ProviderPolicy {
  const first = rows[0];
  if (first === undefined) throw new Error("No enabled policy rows.");
  for (const row of rows.slice(1)) for (const key of policyKeys) if (row[key] !== first[key]) throw new Error(`Enabled policy disagreement: ${key}`);
  return first;
}
export function backoffDelayMs(attempt: number, prng: Prng): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("Attempt must be a positive integer.");
  const jitter = prng.nextIntInclusive(0, 250);
  if (!Number.isInteger(jitter) || jitter < 0 || jitter > 250) throw new Error("PRNG jitter is outside [0,250].");
  return Math.min(30_000, 500 * 2 ** (attempt - 1)) + jitter;
}
export function retryAfterMs(value: string | undefined): number { return value !== undefined && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) * 1_000 : 60_000; }

export class ProviderCircuit {
  private stateValue: CircuitState = "CLOSED";
  private readonly failures: number[] = [];
  private readonly malformedAt: number[] = [];
  private readonly active = new Set<string>();
  private readonly humanHalted = new Set<string>();
  private readonly readyTickers = new Set<string>();
  private readonly settlingAt: number[] = [];
  private assertionsPassed = false;
  private subscriptionsAcked = false;
  private halfOpenAttemptConsumed = false;
  private openTimer: TimerToken | undefined;
  private halfOpenTimer: TimerToken | undefined;
  private readonly heartbeats: HeartbeatTracker;

  public constructor(private readonly providerId: string, private readonly policy: ProviderPolicy, private readonly clock: Clock, private readonly scheduler: TimerScheduler, private readonly persistence: PersistencePort, private readonly events: CircuitEvents) {
    this.heartbeats = new HeartbeatTracker(clock, scheduler, policy.heartbeatTimeoutMs, policy.heartbeatAheadCount, policy.heartbeatAheadSpanMs, () => this.heartbeatTimeout());
  }
  public state(): CircuitState { return this.stateValue; }
  public beginReady(active: readonly string[], humanHalted: readonly string[]): void {
    this.active.clear();
    this.humanHalted.clear();
    for (const id of active) this.active.add(id);
    for (const id of humanHalted) this.humanHalted.add(id);
  }
  public markHumanHalted(instrumentId: string): void { this.humanHalted.add(instrumentId); this.maybeSettle(); }
  public connectionFailed(reason = "CONNECTION_FAILED"): void { this.recordFailure(reason); }
  public malformedPayload(): boolean {
    this.recordInWindow(this.malformedAt, 60_000);
    if (this.malformedAt.length !== 3) return false;
    this.malformedAt.length = 0;
    this.recordFailure("MALFORMED_PAYLOAD_THRESHOLD");
    this.events.reconnect();
    return true;
  }
  public http429(retryAfter: string | undefined): number {
    const hold = retryAfterMs(retryAfter);
    this.recordFailure("HTTP_429", hold);
    return hold;
  }
  public authOrTlsFailed(): void {
    this.events.remediationRequired();
    this.recordFailure("AUTH_OR_TLS", 1_800_000, true);
  }
  public productAssertionsPassed(): void { this.assertionsPassed = true; this.maybeSettle(); }
  public subscriptionsAcknowledged(): void { this.subscriptionsAcked = true; this.heartbeats.arm(); this.maybeSettle(); }
  public async validTicker(instrumentId: string, request: Parameters<PersistencePort["appendObservation"]>[0]): Promise<void> {
    const result = await this.persistence.appendObservation(request);
    if (result.outcome === "IDEMPOTENCY_CONFLICT" || result.outcome === "PRICE_JUMP_HALT") this.humanHalted.add(instrumentId);
    if ((result.outcome === "ACCEPTED" || result.outcome === "DUPLICATE_IDENTICAL") && this.stateValue === "HALF_OPEN") this.readyTickers.add(instrumentId);
    this.maybeSettle();
  }
  public heartbeat(instrumentId: string, sequence: string, lastTradeId: string, lastMatchedTradeId: string | undefined, valid = true): HeartbeatResult {
    const result = this.heartbeats.observe(instrumentId, sequence, lastTradeId, lastMatchedTradeId, valid);
    if (this.stateValue === "SETTLING") this.settleHeartbeat(result);
    if (result === "AHEAD_CONFIRMED") this.startRecovery("HEARTBEAT_GAP");
    return result;
  }
  public heartbeatTimeout(): void { this.startRecovery("HEARTBEAT_TIMEOUT"); }
  public mayAttemptConnection(): boolean { return this.stateValue === "CLOSED" || (this.stateValue === "HALF_OPEN" && !this.halfOpenAttemptConsumed); }
  public consumeConnectionAttempt(): boolean {
    if (this.stateValue !== "HALF_OPEN" || this.halfOpenAttemptConsumed) return this.stateValue === "CLOSED";
    this.halfOpenAttemptConsumed = true;
    return true;
  }
  private startRecovery(reason: RecoveryReason): void { void this.recover(reason).catch(() => undefined); }
  private settleHeartbeat(result: HeartbeatResult): void {
    if (result !== "ACCEPTED") { this.settlingAt.length = 0; return; }
    this.settlingAt.push(this.clock.nowMs());
    const first = this.settlingAt[0];
    if (this.settlingAt.length >= this.policy.heartbeatSettleCount && first !== undefined && this.clock.nowMs() - first >= this.policy.heartbeatSettleSpanMs) this.close();
  }
  private async recover(reason: RecoveryReason): Promise<void> {
    this.events.recovery(reason);
    const availability = "UNAVAILABLE_REBASELINING";
    for (const instrumentId of this.active) {
      if (this.humanHalted.has(instrumentId)) continue;
      try {
        await this.transition(instrumentId, availability, reason);
      } catch {}
    }
    this.events.reconnect();
    this.recordFailure(reason);
  }
  private transition(
    instrumentId: string,
    newBaseAvailability: TransitionStateRequest["newBaseAvailability"],
    reasonCode: string,
  ): Promise<void> {
    return this.persistence.transitionState({
      providerId: this.providerId,
      instrumentId,
      newBaseAvailability,
      reasonCode,
    });
  }
  private recordFailure(reason: string, holdMs?: number, forceOpen = false): void {
    if (this.stateValue === "OPEN") return;
    this.events.failedAttempt(reason);
    if (this.stateValue === "HALF_OPEN" || this.stateValue === "SETTLING") {
      this.open(holdMs);
      return;
    }
    this.recordInWindow(this.failures, this.policy.circuitFailureWindowMs);
    if (forceOpen || this.failures.length >= this.policy.circuitFailureThreshold) this.open(holdMs);
  }
  private recordInWindow(values: number[], windowMs: number): void {
    const now = this.clock.nowMs();
    values.push(now);
    while (values[0] !== undefined && now - values[0] > windowMs) values.shift();
  }
  private open(holdMs = this.policy.circuitCooldownMs): void {
    this.stateValue = "OPEN";
    this.heartbeats.cancel();
    if (this.openTimer !== undefined) this.scheduler.cancel(this.openTimer);
    if (this.halfOpenTimer !== undefined) this.scheduler.cancel(this.halfOpenTimer);
    this.openTimer = this.scheduler.schedule(holdMs, () => this.startHalfOpen());
  }
  private startHalfOpen(): void {
    this.stateValue = "HALF_OPEN";
    this.assertionsPassed = false;
    this.subscriptionsAcked = false;
    this.halfOpenAttemptConsumed = false;
    this.readyTickers.clear();
    this.halfOpenTimer = this.scheduler.schedule(this.policy.circuitHalfOpenReadyMs, () => { if (this.stateValue === "HALF_OPEN") this.recordFailure("HALF_OPEN_TIMEOUT"); });
  }
  private maybeSettle(): void {
    if (this.stateValue !== "HALF_OPEN" || !this.assertionsPassed || !this.subscriptionsAcked) return;
    for (const id of this.active) if (!this.humanHalted.has(id) && !this.readyTickers.has(id)) return;
    this.stateValue = "SETTLING";
    this.settlingAt.length = 0;
    if (this.halfOpenTimer !== undefined) this.scheduler.cancel(this.halfOpenTimer);
  }
  private close(): void {
    this.stateValue = "CLOSED";
    this.failures.length = 0;
    this.settlingAt.length = 0;
  }
}
