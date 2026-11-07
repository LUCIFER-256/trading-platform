import {
  validateMatch,
  validateTicker,
  type TickerValidationContext,
} from "../../../../packages/market-data/src";
import type { DecimalString } from "../../../../packages/shared/src";
import { parseCoinbaseFrame } from "./adapter";
import type { WireTransport } from "./ws-client";
import {
  CoinbaseProductAssertions,
  RestTransientFailure,
  type ProductTarget,
} from "./rest-products";
import {
  backoffDelayMs,
  retryAfterMs,
  type CircuitEvents,
  type ProviderCircuit,
  type RecoveryReason,
} from "../circuit";
import type {
  Clock,
  PersistencePort,
  Prng,
  TimerScheduler,
  TimerToken,
} from "../ports";
import { PersistenceQueue } from "../queue";
import { QualityAggregator } from "../quality-aggregator";
export interface SessionInstrument extends ProductTarget {
  readonly ticker: Omit<
    TickerValidationContext,
    | "enabled"
    | "receivedAtUs"
    | "lastAcceptedEventAtUs"
    | "lastAcceptedTradeId"
    | "referencePrice"
  >;
}
export interface SafeSessionRecord {
  readonly providerId: string;
  readonly instrumentId: string | null;
  readonly reason: string;
  readonly timestampMs: number;
  readonly attempt: number;
  readonly queueDepth: number;
  readonly correlationId: string;
}
export interface CircuitRelayHandlers {
  reconnect(): void;
  recovery(reason: RecoveryReason, discardedCount?: number): void;
  failedAttempt(reason: string): void;
  remediationRequired(): void;
}

export interface CircuitRelayEvent {
  readonly type: "reconnect" | "recovery" | "failedAttempt" | "remediationRequired";
  readonly reason?: string;
  readonly discardedCount?: number;
}

export class CircuitEventRelay implements CircuitEvents {
  private handlers: CircuitRelayHandlers | undefined;

  public constructor(
    private readonly recordEvent?: (event: CircuitRelayEvent) => void,
  ) {}
  public bind(handlers: CircuitRelayHandlers): void {
    this.handlers = handlers;
  }
  public reconnect(): void {
    this.recordEvent?.({ type: "reconnect" });
    this.handlers?.reconnect();
  }
  public recovery(reason: RecoveryReason, discardedCount?: number): void {
    this.recordEvent?.(
      discardedCount === undefined
        ? { type: "recovery", reason }
        : { type: "recovery", reason, discardedCount },
    );
    this.handlers?.recovery(reason, discardedCount);
  }
  public failedAttempt(reason: string): void {
    this.recordEvent?.({ type: "failedAttempt", reason });
    this.handlers?.failedAttempt(reason);
  }
  public remediationRequired(): void {
    this.recordEvent?.({ type: "remediationRequired" });
    this.handlers?.remediationRequired();
  }
}
export interface SessionOptions {
  readonly providerId: string;
  readonly endpoint: string;
  readonly instruments: readonly SessionInstrument[];
  readonly humanHalted: readonly string[];
  readonly recovery?: ReadonlyMap<
    string,
    {
      readonly price: DecimalString;
      readonly eventTime: string;
    }
  >;
  readonly jumpResets?: ReadonlyMap<
    string,
    {
      readonly confirmedPrice: DecimalString;
      readonly expiresAtMs: number;
    }
  >;
  readonly transport: WireTransport;
  readonly products: CoinbaseProductAssertions;
  readonly circuit: ProviderCircuit;
  readonly relay: CircuitEventRelay;
  readonly persistence: PersistencePort;
  readonly quality: QualityAggregator;
  readonly clock: Clock;
  readonly scheduler: TimerScheduler;
  readonly prng: Prng;
  readonly correlationId: () => string;
  readonly log?: (record: SafeSessionRecord) => void;
}
export class CoinbaseSession {
  private active: SessionInstrument[] = [];
  private readonly halted = new Set<string>();
  private readonly matches = new Map<string, string>();
  private readonly tickerState = new Map<
    string,
    {
      eventAtUs: string;
      tradeId: string;
      price: DecimalString;
    }
  >();
  private readonly pendingResets = new Map<
    string,
    { readonly confirmedPrice: DecimalString; readonly expiresAtMs: number }
  >();
  private attempt = 0;
  private reconnectTimer: TimerToken | undefined;
  private blockedTimer: TimerToken | undefined;
  private connection = 0;
  private terminal = true;
  private persistenceEpisode = false;
  private readonly queue: PersistenceQueue<
    Parameters<PersistencePort["appendObservation"]>[0]
  >;
  public constructor(private readonly value: SessionOptions) {
    for (const id of value.humanHalted) this.halted.add(id);
    for (const [instrumentId, recovery] of value.recovery ?? []) {
      this.tickerState.set(instrumentId, {
        eventAtUs: recovery.eventTime,
        tradeId: "",
        price: recovery.price,
      });
    }
    for (const [instrumentId, reset] of value.jumpResets ?? []) {
      this.pendingResets.set(instrumentId, reset);
    }
    value.relay.bind({
      reconnect: () => this.circuitReconnect(),
      recovery: (reason) => this.record(null, reason),
      failedAttempt: (reason) => this.record(null, reason),
      remediationRequired: () => this.record(null, "REMEDIATION_REQUIRED"),
    });
    this.queue = new PersistenceQueue(
      async (request) =>
        value.circuit.validTicker(request.instrumentId, request),
      value.scheduler,
      {
        recover: (reason) => this.persistenceRecovery(reason),
        failedAttempt: () => this.persistenceFailed(),
      },
    );
  }
  public async connect(): Promise<void> {
    try {
      await this.connectInner();
    } catch {
      this.record(null, "NETWORK");
      this.value.circuit.connectionFailed("NETWORK");
      this.scheduleBackoff();
    }
  }
  private async connectInner(): Promise<void> {
    if (!this.wssEndpoint()) {
      this.record(null, "CONFIGURATION");
      return;
    }
    if (
      !this.value.circuit.mayAttemptConnection() ||
      !this.value.circuit.consumeConnectionAttempt()
    ) {
      this.scheduleBlocked();
      return;
    }
    let assertion;
    try {
      assertion = await this.value.products.assertAll(
        this.value.instruments.filter(
          (item) => !this.halted.has(item.instrumentId),
        ),
      );
    } catch (error) {
      this.failBeforeOpen(
        error instanceof RestTransientFailure ? "REST" : "NETWORK",
      );
      return;
    }
    if (assertion.retryAfter !== undefined) {
      this.schedule(retryAfterMs(assertion.retryAfter));
      return;
    }
    this.active = assertion.accepted
      .map(
        (target) =>
          this.value.instruments.find(
            (item) => item.instrumentId === target.instrumentId,
          )!,
      )
      .filter((item) => !this.halted.has(item.instrumentId));
    if (this.active.length === 0) return;
    this.matches.clear();
    this.value.circuit.beginReady(
      this.active.map((item) => item.instrumentId),
      [...this.halted],
    );
    this.value.circuit.productAssertionsPassed();
    const connection = ++this.connection;
    this.terminal = false;
    try {
      this.value.transport.open(this.value.endpoint, {
        opened: () => {
          if (!this.live(connection)) return;
          this.queue.reset();
          this.value.transport.subscribe(
            this.active.map((item) => item.symbol),
          );
        },
        message: (frame) => {
          if (this.live(connection))
            void this.frame(frame).catch(() =>
              this.fail("PERSISTENCE", connection),
            );
        },
        closed: () => this.fail("NETWORK", connection),
        failed: (code, retryAfter) =>
          this.transportFailed(code, retryAfter, connection),
      });
    } catch {
      this.fail("NETWORK", connection);
    }
  }
  private wssEndpoint(): boolean {
    try {
      return new URL(this.value.endpoint).protocol === "wss:";
    } catch {
      return false;
    }
  }
  private live(connection: number): boolean {
    return connection === this.connection && !this.terminal;
  }
  private transportFailed(
    code: string,
    retryAfter: string | undefined,
    connection: number,
  ): void {
    if (!this.live(connection)) return;
    if (code === "RATE_LIMIT") {
      this.terminal = true;
      this.value.circuit.http429(retryAfter);
      this.value.transport.close();
      this.schedule(retryAfterMs(retryAfter));
      return;
    }
    if (code === "TLS" || code === "AUTH") {
      this.terminal = true;
      this.value.circuit.authOrTlsFailed();
      this.value.transport.close();
      this.scheduleBlocked();
      return;
    }
    this.fail(code, connection);
  }
  private fail(reason: string, connection = this.connection): void {
    if (!this.live(connection)) return;
    this.terminal = true;
    this.value.circuit.connectionFailed(reason);
    this.record(null, reason);
    this.scheduleBackoff();
  }
  private failBeforeOpen(reason: string): void {
    this.value.circuit.connectionFailed(reason);
    this.record(null, reason);
    this.scheduleBackoff();
  }
  private async frame(frame: string): Promise<void> {
    try {
      if (
        (
          JSON.parse(frame) as {
            type?: unknown;
          }
        ).type === "subscriptions"
      ) {
        this.value.circuit.subscriptionsAcknowledged();
        return;
      }
    } catch {}
    const parsed = parseCoinbaseFrame(frame);
    if (!parsed.ok) {
      this.value.quality.reject(this.value.providerId, null, parsed.reason);
      if (this.value.circuit.malformedPayload()) this.closeForCircuit();
      return;
    }
    const known = this.value.instruments.find(
      (candidate) => candidate.symbol === parsed.value.symbol,
    );
    if (known !== undefined && this.halted.has(known.instrumentId)) return;
    const item = this.active.find(
      (candidate) => candidate.symbol === parsed.value.symbol,
    );
    if (item === undefined) {
      this.value.quality.reject(
        this.value.providerId,
        null,
        "DISABLED_OR_UNMAPPED",
      );
      return;
    }
    if (parsed.value.kind === "heartbeat") {
      const prior = this.matches.get(item.instrumentId);
      const result = this.value.circuit.heartbeat(
        item.instrumentId,
        parsed.value.sequence,
        parsed.value.lastTradeId,
        prior,
      );
      if (result === "ACCEPTED") this.attempt = 0;
      if (result === "AHEAD_CONFIRMED") this.closeForCircuit();
      return;
    }
    if (parsed.value.kind === "match") {
      const prior = this.matches.get(item.instrumentId);
      const result = validateMatch(
        parsed.value,
        prior === undefined
          ? { connected: true }
          : { connected: true, lastMatchedTradeId: prior },
      );
      if (result.outcome === "ACCEPTED")
        this.matches.set(item.instrumentId, parsed.value.tradeId);
      else if (result.outcome === "REJECTED")
        this.value.quality.reject(
          this.value.providerId,
          item.instrumentId,
          result.reason,
        );
      else
        await this.halt(
          item.instrumentId,
          result.reason,
          parsed.value.eventAtUs,
          parsed.value.tradeId,
          parsed.value.sequence,
          parsed.value.price,
          parsed.value.size,
        );
      return;
    }
    const state = this.tickerState.get(item.instrumentId);
    const reset = this.pendingResets.get(item.instrumentId);
    const resetReference =
      reset !== undefined && reset.expiresAtMs > this.value.clock.nowMs()
        ? reset.confirmedPrice
        : undefined;
    const result = validateTicker(parsed.value, {
      ...item.ticker,
      enabled: true,
      receivedAtUs: String(this.value.clock.nowMs() * 1000),
      ...(state === undefined
        ? {}
        : {
            lastAcceptedEventAtUs: state.eventAtUs,
            lastAcceptedTradeId: state.tradeId,
            referencePrice: resetReference ?? state.price,
          }),
    });
    if (result.outcome === "REJECTED") {
      this.value.quality.reject(
        this.value.providerId,
        item.instrumentId,
        result.reason,
      );
      return;
    }
    if (result.outcome === "HALT") {
      await this.halt(
        item.instrumentId,
        result.reason,
        parsed.value.eventAtUs,
        parsed.value.tradeId,
        parsed.value.sequence,
        result.candidatePrice ?? null,
        result.candidateSize ?? null,
        result.referencePrice ?? null,
      );
      return;
    }
    this.pendingResets.delete(item.instrumentId);
    this.tickerState.set(item.instrumentId, {
      eventAtUs: parsed.value.eventAtUs,
      tradeId: parsed.value.tradeId,
      price: parsed.value.lastPrice,
    });
    this.queue.enqueue({
      providerId: this.value.providerId,
      instrumentId: item.instrumentId,
      providerSymbol: parsed.value.symbol,
      providerSequence: parsed.value.sequence,
      tradeId: parsed.value.tradeId,
      eventAtUs: parsed.value.eventAtUs,
      receivedAt: new Date(this.value.clock.nowMs()),
      bid: parsed.value.bid,
      bidSize: parsed.value.bidSize,
      ask: parsed.value.ask,
      askSize: parsed.value.askSize,
      lastPrice: parsed.value.lastPrice,
      lastSize: parsed.value.lastSize,
      volume24h: parsed.value.volume24h,
    });
  }
  private async halt(
    instrumentId: string,
    reasonCode: string,
    eventAtUs: string,
    tradeId: string,
    providerSequence: string,
    candidatePrice: string | null,
    candidateSize: string | null,
    referencePrice: string | null = null,
  ): Promise<void> {
    this.halted.add(instrumentId);
    this.value.circuit.markHumanHalted(instrumentId);
    await this.value.persistence.openHalt({
      providerId: this.value.providerId,
      instrumentId,
      reasonCode,
      eventAtUs,
      tradeId,
      providerSequence,
      candidatePrice,
      candidateSize,
      referencePrice,
    });
  }
  private persistenceRecovery(
    reason: "QUEUE_OVERFLOW" | "PERSISTENCE_TIMEOUT",
  ): void {
    this.persistenceEpisode = true;
    this.record(null, reason);
    this.queue.discard();
    for (const item of this.active) {
      if (this.halted.has(item.instrumentId)) continue;
      void this.value.persistence
        .transitionState({
          providerId: this.value.providerId,
          instrumentId: item.instrumentId,
          newBaseAvailability: "UNAVAILABLE_PERSISTENCE",
          reasonCode: reason,
        })
        .catch(() => this.record(null, "PERSISTENCE"));
    }
    // This is the sole reconnect schedule for a persistence-recovery episode.
    this.closeForCircuit();
  }
  private persistenceFailed(): void {
    if (!this.persistenceEpisode) return;
    this.persistenceEpisode = false;
    this.value.circuit.connectionFailed("PERSISTENCE");
  }
  private circuitReconnect(): void {
    this.closeForCircuit();
  }
  private closeForCircuit(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.value.transport.close();
    this.scheduleBackoff();
  }
  private scheduleBackoff(): void {
    this.schedule(backoffDelayMs(++this.attempt, this.value.prng));
  }
  private schedule(afterMs: number): void {
    if (this.reconnectTimer !== undefined)
      this.value.scheduler.cancel(this.reconnectTimer);
    this.reconnectTimer = this.value.scheduler.schedule(afterMs, () => {
      this.reconnectTimer = undefined;
      void this.connect();
    });
  }
  private scheduleBlocked(): void {
    if (this.blockedTimer !== undefined) return;
    this.blockedTimer = this.value.scheduler.schedule(1000, () => {
      this.blockedTimer = undefined;
      void this.connect();
    });
  }
  private record(instrumentId: string | null, reason: string): void {
    this.value.log?.({
      providerId: this.value.providerId,
      instrumentId,
      reason,
      timestampMs: this.value.clock.nowMs(),
      attempt: this.attempt,
      queueDepth: this.queue.size(),
      correlationId: this.value.correlationId(),
    });
  }
}
