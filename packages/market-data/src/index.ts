import type { DecimalString, InstrumentId } from "../../shared/src";

export interface MarketDataPoint {
  readonly instrumentId: InstrumentId;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly bid?: DecimalString;
  readonly ask?: DecimalString;
  readonly last?: DecimalString;
  readonly sourceSequence?: string;
}

export interface MarketDataProvider {
  getLatest(instrumentId: InstrumentId): Promise<MarketDataPoint | undefined>;
  subscribe(instrumentIds: readonly InstrumentId[], onData: (point: MarketDataPoint) => Promise<void>): Promise<() => Promise<void>>;
}

export interface MarketDataValidityPolicy {
  isValid(point: MarketDataPoint, evaluatedAt: Date): boolean;
}
