import type { DecimalString, InstrumentId } from "../../shared/src";
export { canonicalizeDecimalString } from "../../shared/src";
export type { DecimalString } from "../../shared/src";
export { canonicalDecimal, canonicalUnsignedInteger, eventAtUsFromRfc3339, scaledDecimal, MAX_EVENT_AT_US } from "./normalization";
export { isEnabledExactSymbol, productAssertionFailure, validateMatch, validateProductAssertion, validateTicker } from "./validation";
export type { HaltReason, MatchValidationContext, ProductAssertion, TickerValidationContext, ValidationReason, ValidationResult } from "./validation";
export type MarketDataAvailability = "AVAILABLE" | "UNAVAILABLE_NO_POLICY" | "UNAVAILABLE_DISABLED_SCOPE" | "UNAVAILABLE_REBASELINING" | "UNAVAILABLE_PROVIDER_CIRCUIT" | "UNAVAILABLE_PERSISTENCE" | "UNAVAILABLE_HUMAN_HALT" | "UNAVAILABLE_STALE" | "UNAVAILABLE_CLOCK_ANOMALY";
export type MarketDataQualityState = "ACCEPTED" | "REJECTED_MALFORMED" | "REJECTED_NONFINITE" | "REJECTED_NONPOSITIVE" | "REJECTED_OFF_GRID" | "REJECTED_FUTURE_TIME" | "REJECTED_EXCESSIVE_EVENT_DELAY" | "REJECTED_EVENT_TIME_REGRESSION" | "REJECTED_DUPLICATE" | "REJECTED_OUT_OF_ORDER" | "QUARANTINED_PRICE_JUMP" | "HALTED_LOCKED_OR_CROSSED" | "HALTED_TRADE_ID_GAP" | "HALTED_HEARTBEAT_GAP" | "REBASELINING_AFTER_RECONNECT" | "UNAVAILABLE";
export type MarketDataErrorCode = "CONFIGURATION" | "NETWORK" | "TLS" | "AUTH" | "RATE_LIMIT" | "PROTOCOL" | "PAYLOAD_TOO_LARGE" | "VALIDATION" | "PERSISTENCE" | "LOCK_LOST" | "CIRCUIT_OPEN" | "IDEMPOTENCY_CONFLICT";

export interface MarketDataObservation { readonly instrumentId: InstrumentId; readonly providerId: string; readonly providerSymbol: string; readonly providerSequence: string; readonly tradeId: string; readonly bidAsOfLastTrade: DecimalString; readonly bidSizeAsOfLastTrade: DecimalString; readonly askAsOfLastTrade: DecimalString; readonly askSizeAsOfLastTrade: DecimalString; readonly lastTradePrice: DecimalString; readonly lastTradeSize: DecimalString; readonly volume24h: DecimalString | null; readonly eventAt: Date; readonly ingestedAt: Date; }
export type LatestMarketDataResult = { readonly availability: "AVAILABLE"; readonly observation: MarketDataObservation } | { readonly availability: Exclude<MarketDataAvailability, "AVAILABLE">; readonly observation: null };
export type AppendMarketDataObservationResult = { readonly outcome: "ACCEPTED" | "DUPLICATE_IDENTICAL"; readonly observationId: string; readonly haltId: null } | { readonly outcome: "IDEMPOTENCY_CONFLICT" | "PRICE_JUMP_HALT"; readonly observationId: null; readonly haltId: string };

export interface MarketDataPoint { readonly instrumentId: InstrumentId; readonly occurredAt: Date; readonly receivedAt: Date; readonly bid?: DecimalString; readonly ask?: DecimalString; readonly last?: DecimalString; readonly sourceSequence?: string; }
export interface MarketDataProvider { getLatest(instrumentId: InstrumentId): Promise<MarketDataPoint | undefined>; subscribe(instrumentIds: readonly InstrumentId[], onData: (point: MarketDataPoint) => Promise<void>): Promise<() => Promise<void>>; }
export interface MarketDataValidityPolicy { isValid(point: MarketDataPoint, evaluatedAt: Date): boolean; }

