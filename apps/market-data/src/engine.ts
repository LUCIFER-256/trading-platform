import { randomUUID } from "node:crypto";
import type { KyselyDatabase } from "../../../packages/database/src";
import { canonicalDecimal } from "../../../packages/market-data/src";
import type { DecimalString } from "../../../packages/shared/src";
import {
  AdvisoryLock,
  type AdvisoryLockConnectionFactory,
} from "./advisory-lock";
import { ProviderCircuit } from "./circuit";
import {
  CircuitEventRelay,
  CoinbaseSession,
  type HeartbeatSummaryRecord,
  type SessionInstrument,
} from "./coinbase/session";
import { CoinbaseProductAssertions, type ProductFetcher } from "./coinbase/rest-products";
import type { WireTransport } from "./coinbase/ws-client";
import { EngineStoppedError, GuardedPersistence, StoppableTransport, TrackingScheduler } from "./engine-guards";
import { loadEnginePolicies } from "./persistence/policies";
import {
  PostgresPersistencePort,
  type CatalogConfiguration,
} from "./persistence/postgres-persistence-port";
import {
  loadStartupCatalog,
  recoverMarketDataStartup,
  type StartupResult,
} from "./persistence/startup";
import type { Clock, Prng, TimerScheduler, TimerToken } from "./ports";
import { QualityAggregator } from "./quality-aggregator";
import { requireTermsAcknowledgement } from "./terms-gate";

export const QUALITY_FLUSH_INTERVAL_MS = 5_000;
export const STOP_DRAIN_MS = 1_500;

export type EngineLogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface EngineLogRecord {
  readonly event: string;
  readonly fields: EngineLogFields;
}

export interface EngineOptions {
  readonly database: KyselyDatabase;
  readonly lockConnection: AdvisoryLockConnectionFactory;
  readonly catalog: CatalogConfiguration;
  readonly termsAcknowledgement: unknown;
  readonly endpoint: string;
  readonly transport: WireTransport;
  readonly products: ProductFetcher;
  readonly clock: Clock;
  readonly scheduler: TimerScheduler;
  readonly prng: Prng;
  readonly abort: () => void;
  readonly log: (record: EngineLogRecord) => void;
  readonly qualityFlushIntervalMs?: number;
}

export function heartbeatLogEntry(record: HeartbeatSummaryRecord): EngineLogRecord {
  return {
    event: "heartbeat",
    fields: {
      instrumentId: record.instrumentId,
      intervals: record.intervals,
      maxIntervalMs: record.maxIntervalMs,
      windowMs: record.windowMs,
      correlationId: record.correlationId,
    },
  };
}

export class EngineStartError extends Error {
  public readonly name = "EngineStartError";

  public constructor(readonly code: "NO_INSTRUMENTS" | "SEED") {
    super(`Market-data engine could not start: ${code}.`);
  }
}

export function sessionJumpResets(
  resets: ReadonlyMap<string, { readonly confirmedPrice: string; readonly expiresAt: Date }>,
): ReadonlyMap<string, { readonly confirmedPrice: DecimalString; readonly expiresAtMs: number }> {
  const result = new Map<string, { readonly confirmedPrice: DecimalString; readonly expiresAtMs: number }>();
  for (const [label, reset] of resets) {
    const confirmedPrice = canonicalDecimal(reset.confirmedPrice);
    if (confirmedPrice === undefined) throw new EngineStartError("SEED");
    result.set(label, { confirmedPrice, expiresAtMs: reset.expiresAt.getTime() });
  }
  return result;
}

export interface EngineStartupSummary {
  readonly started: readonly string[];
  readonly skipped: Readonly<Record<string, string>>;
  readonly humanHalted: readonly string[];
}

export class MarketDataEngine {
  private stopping: Promise<void> | undefined;
  private flushToken: TimerToken | undefined;
  private flushing = false;

  private constructor(
    private readonly options: EngineOptions,
    private readonly lock: AdvisoryLock,
    private readonly tracking: TrackingScheduler,
    private readonly transport: StoppableTransport,
    private readonly persistence: GuardedPersistence,
    private readonly quality: QualityAggregator,
    private readonly summaryValue: EngineStartupSummary,
  ) {}

  public static async start(options: EngineOptions): Promise<MarketDataEngine> {
    const terms = requireTermsAcknowledgement(options.termsAcknowledgement);
    options.log({ event: "terms", fields: { acknowledgement: terms.acknowledgement } });
    const lock = await AdvisoryLock.acquire(options.lockConnection, options.scheduler, options.abort);
    options.log({ event: "lock", fields: { acquired: true } });
    try {
      return await MarketDataEngine.assemble(options, lock);
    } catch (error) {
      await lock.release().catch(() => undefined);
      throw error;
    }
  }

  private static async assemble(options: EngineOptions, lock: AdvisoryLock): Promise<MarketDataEngine> {
    const catalog = await loadStartupCatalog(options.database, options.catalog);
    const startup = await recoverMarketDataStartup(options.database, catalog.mapping, options.catalog);
    const summary = summarize(startup);
    options.log({
      event: "startup",
      fields: {
        started: summary.started.length,
        skipped: Object.keys(summary.skipped).length,
        humanHalted: summary.humanHalted.length,
      },
    });
    if (catalog.mapping === undefined || startup.started.length === 0) throw new EngineStartError("NO_INSTRUMENTS");
    const labels = startup.started.map((item) => item.label);
    const policies = await loadEnginePolicies(options.database, catalog.mapping, labels);
    const recovery = new Map<string, { readonly price: DecimalString; readonly eventTime: string }>();
    for (const [label, seed] of startup.recovery) {
      const price = canonicalDecimal(seed.price);
      if (price === undefined) throw new EngineStartError("SEED");
      recovery.set(label, { price, eventTime: seed.eventTime });
    }
    const jumpResets = sessionJumpResets(startup.jumpResets);
    const tracking = new TrackingScheduler(options.scheduler);
    const transport = new StoppableTransport(options.transport);
    const persistence = new GuardedPersistence(new PostgresPersistencePort(options.database, catalog.mapping));
    const relay = new CircuitEventRelay();
    const providerId = options.catalog.providerLabel;
    const circuit = new ProviderCircuit(providerId, policies.provider, options.clock, tracking, persistence, relay);
    const quality = new QualityAggregator(options.clock);
    const products = new CoinbaseProductAssertions(providerId, options.products, tracking, persistence, circuit);
    const correlation = randomUUID();
    const instruments: SessionInstrument[] = startup.started.map((item) => {
      const policy = policies.instruments.get(item.label)!;
      return {
        instrumentId: item.label,
        symbol: item.symbol,
        priceIncrement: policy.priceIncrement,
        sizeIncrement: policy.sizeIncrement,
        ticker: {
          priceIncrement: policy.priceIncrement,
          sizeIncrement: policy.sizeIncrement,
          maxInitialEventDelayMs: policy.maxInitialEventDelayMs,
          maxFutureSkewMs: policy.maxFutureSkewMs,
          maxPriceJumpBps: policy.maxPriceJumpBps,
        },
      };
    });
    const session = new CoinbaseSession({
      providerId,
      endpoint: options.endpoint,
      instruments,
      humanHalted: [],
      recovery,
      jumpResets,
      transport,
      products,
      circuit,
      relay,
      persistence,
      quality,
      clock: options.clock,
      scheduler: tracking,
      prng: options.prng,
      correlationId: () => correlation,
      log: (record) => options.log({
        event: "session",
        fields: {
          reason: record.reason,
          instrumentId: record.instrumentId,
          attempt: record.attempt,
          queueDepth: record.queueDepth,
          correlationId: record.correlationId,
        },
      }),
      heartbeatLog: (record) => options.log(heartbeatLogEntry(record)),
    });
    const engine = new MarketDataEngine(options, lock, tracking, transport, persistence, quality, summary);
    engine.scheduleFlush();
    try {
      await session.connect();
    } catch (error) {
      transport.stop();
      persistence.stop();
      tracking.stop();
      throw error;
    }
    return engine;
  }

  public summary(): EngineStartupSummary {
    return this.summaryValue;
  }

  public stop(): Promise<void> {
    if (this.stopping === undefined) this.stopping = this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.transport.stop();
    this.persistence.stop();
    const drained = await this.persistence.drain(STOP_DRAIN_MS, this.options.scheduler);
    this.tracking.stop();
    await this.lock.release().catch(() => undefined);
    this.options.log({ event: "stopped", fields: { drained } });
  }

  private scheduleFlush(): void {
    this.flushToken = this.tracking.schedule(this.options.qualityFlushIntervalMs ?? QUALITY_FLUSH_INTERVAL_MS, () => {
      void this.flushQuality().finally(() => this.scheduleFlush());
    });
  }

  private async flushQuality(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.quality.flushClosed(this.persistence);
    } catch (error) {
      if (!(error instanceof EngineStoppedError)) {
        this.options.log({ event: "quality-flush-failed", fields: { pendingBuckets: this.quality.pending().length } });
      }
    } finally {
      this.flushing = false;
    }
  }
}

function summarize(startup: StartupResult): EngineStartupSummary {
  const skipped: Record<string, string> = {};
  for (const [label, reason] of startup.skipped) skipped[label] = reason;
  return {
    started: startup.started.map((item) => item.label),
    skipped,
    humanHalted: [...startup.humanHalted],
  };
}
