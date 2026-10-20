import type { AppendMarketDataObservationResult } from "../../../packages/market-data/src";

export interface Clock {
  nowMs(): number;
}

export type TimerToken = number;

export interface TimerScheduler {
  schedule(afterMs: number, callback: () => void): TimerToken;
  cancel(token: TimerToken): void;
}

export interface Prng {
  nextIntInclusive(min: number, max: number): number;
}

export interface AppendObservationRequest {
  readonly providerId: string;
  readonly instrumentId: string;
  readonly providerSymbol: string;
  readonly providerSequence: string;
  readonly tradeId: string;
  readonly eventAtUs: string;
  readonly receivedAt: Date;
  readonly bid: string;
  readonly bidSize: string;
  readonly ask: string;
  readonly askSize: string;
  readonly lastPrice: string;
  readonly lastSize: string;
  readonly volume24h: string | null;
}

export interface OpenHaltRequest {
  readonly providerId: string;
  readonly instrumentId: string;
  readonly reasonCode: string;
  readonly eventAtUs: string | null;
  readonly tradeId: string | null;
  readonly providerSequence: string | null;
  readonly candidatePrice: string | null;
  readonly candidateSize: string | null;
  readonly referencePrice: string | null;
}

export interface TransitionStateRequest {
  readonly providerId: string;
  readonly newBaseAvailability: "UNAVAILABLE_REBASELINING" | "UNAVAILABLE_PROVIDER_CIRCUIT" | "UNAVAILABLE_PERSISTENCE" | "UNAVAILABLE_DISABLED_SCOPE";
  readonly reasonCode: string;
  readonly instrumentId: string | null;
}

export interface AppendQualityBucketRequest {
  readonly flushId: string;
  readonly providerId: string;
  readonly instrumentId: string | null;
  readonly reasonCode: string;
  readonly bucketStartedAt: Date;
  readonly count: bigint;
}

export interface PersistencePort {
  appendObservation(request: AppendObservationRequest): Promise<AppendMarketDataObservationResult>;
  openHalt(request: OpenHaltRequest): Promise<string>;
  transitionState(request: TransitionStateRequest): Promise<void>;
  appendQualityBucket(request: AppendQualityBucketRequest): Promise<void>;
}
