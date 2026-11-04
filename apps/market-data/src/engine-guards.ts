import type {
  AppendObservationRequest,
  AppendQualityBucketRequest,
  OpenHaltRequest,
  PersistencePort,
  TimerScheduler,
  TimerToken,
  TransitionStateRequest,
} from "./ports";
import type { WireCallbacks, WireTransport } from "./coinbase/ws-client";
import type { AppendMarketDataObservationResult } from "../../../packages/market-data/src";

export class EngineStoppedError extends Error {
  public readonly name = "EngineStoppedError";

  public constructor() {
    super("Market-data engine is stopped.");
  }
}

export class TrackingScheduler implements TimerScheduler {
  private readonly tokens = new Set<TimerToken>();
  private stopped = false;

  public constructor(private readonly inner: TimerScheduler) {}

  public schedule(afterMs: number, callback: () => void): TimerToken {
    if (this.stopped) return -1;
    let token: TimerToken | undefined;
    token = this.inner.schedule(afterMs, () => {
      if (token !== undefined) this.tokens.delete(token);
      if (!this.stopped) callback();
    });
    this.tokens.add(token);
    return token;
  }

  public cancel(token: TimerToken): void {
    if (token === -1) return;
    this.tokens.delete(token);
    this.inner.cancel(token);
  }

  public pending(): number {
    return this.tokens.size;
  }

  public stop(): void {
    this.stopped = true;
    for (const token of this.tokens) this.inner.cancel(token);
    this.tokens.clear();
  }
}

export class StoppableTransport implements WireTransport {
  private stopped = false;

  public constructor(private readonly inner: WireTransport) {}

  public open(endpoint: string, callbacks: WireCallbacks): void {
    if (this.stopped) return;
    this.inner.open(endpoint, callbacks);
  }

  public subscribe(productIds: readonly string[]): void {
    if (this.stopped) return;
    this.inner.subscribe(productIds);
  }

  public close(): void {
    this.inner.close();
  }

  public stop(): void {
    this.stopped = true;
    this.inner.close();
  }
}

export class GuardedPersistence implements PersistencePort {
  private stopped = false;
  private readonly pendingCalls = new Set<Promise<unknown>>();

  public constructor(private readonly inner: PersistencePort) {}

  public appendObservation(request: AppendObservationRequest): Promise<AppendMarketDataObservationResult> {
    return this.track(() => this.inner.appendObservation(request));
  }

  public openHalt(request: OpenHaltRequest): Promise<string> {
    return this.track(() => this.inner.openHalt(request));
  }

  public transitionState(request: TransitionStateRequest): Promise<void> {
    return this.track(() => this.inner.transitionState(request));
  }

  public appendQualityBucket(request: AppendQualityBucketRequest): Promise<void> {
    return this.track(() => this.inner.appendQualityBucket(request));
  }

  public inFlight(): number {
    return this.pendingCalls.size;
  }

  public stop(): void {
    this.stopped = true;
  }

  public async drain(timeoutMs: number, scheduler: TimerScheduler): Promise<boolean> {
    if (this.pendingCalls.size === 0) return true;
    let token: TimerToken | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      token = scheduler.schedule(timeoutMs, () => resolve(false));
    });
    const settled = Promise.allSettled([...this.pendingCalls]).then(() => true);
    try {
      return await Promise.race([settled, timeout]);
    } finally {
      if (token !== undefined) scheduler.cancel(token);
    }
  }

  private track<T>(call: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new EngineStoppedError());
    const promise = call();
    this.pendingCalls.add(promise);
    const forget = (): void => {
      this.pendingCalls.delete(promise);
    };
    promise.then(forget, forget);
    return promise;
  }
}
