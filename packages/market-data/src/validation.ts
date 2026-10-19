import type { DecimalString } from "../../shared/src";
import { canonicalDecimal, scaledDecimal, type NormalizedMatch, type NormalizedTicker } from "./normalization";

export type ValidationReason = "MALFORMED" | "NONFINITE" | "NONPOSITIVE" | "OFF_GRID" | "FUTURE_TIME" | "EXCESSIVE_EVENT_DELAY" | "EVENT_TIME_REGRESSION" | "DUPLICATE" | "DISABLED_OR_UNMAPPED";
export type HaltReason = "OUT_OF_ORDER_MATCH_ID" | "IN_SESSION_MATCH_GAP" | "LOCKED_OR_CROSSED" | "PRICE_JUMP" | "PRODUCT_ASSERTION_FAILURE";
export type ValidationResult = { readonly outcome: "ACCEPTED" } | { readonly outcome: "REJECTED"; readonly reason: ValidationReason } | { readonly outcome: "HALT"; readonly reason: HaltReason; readonly candidatePrice?: DecimalString; readonly candidateSize?: DecimalString; readonly referencePrice?: DecimalString };

export interface TickerValidationContext {
  readonly enabled: boolean;
  readonly priceIncrement: DecimalString;
  readonly sizeIncrement: DecimalString;
  readonly receivedAtUs: string;
  readonly maxInitialEventDelayMs: number;
  readonly maxFutureSkewMs: number;
  readonly maxPriceJumpBps: number;
  readonly lastAcceptedEventAtUs?: string;
  readonly lastAcceptedTradeId?: string;
  readonly referencePrice?: DecimalString;
}

export interface MatchValidationContext { readonly lastMatchedTradeId?: string; readonly connected: boolean; }

export function isEnabledExactSymbol(symbol: string, mapping: { readonly symbol: string; readonly enabled: boolean }): boolean {
  return mapping.enabled && mapping.symbol === symbol;
}

function isPositive(value: DecimalString): boolean { return scaledDecimal(value) > 0n; }
function isOnGrid(value: DecimalString, increment: DecimalString): boolean { const grid = scaledDecimal(increment); return grid > 0n && scaledDecimal(value) % grid === 0n; }

export function validateTicker(ticker: NormalizedTicker, context: TickerValidationContext): ValidationResult {
  if (!context.enabled) return { outcome: "REJECTED", reason: "DISABLED_OR_UNMAPPED" };
  for (const value of [ticker.bid, ticker.bidSize, ticker.ask, ticker.askSize, ticker.lastPrice, ticker.lastSize]) if (!isPositive(value)) return { outcome: "REJECTED", reason: "NONPOSITIVE" };
  if (ticker.volume24h !== null && scaledDecimal(ticker.volume24h) < 0n) return { outcome: "REJECTED", reason: "NONPOSITIVE" };
  for (const value of [ticker.bid, ticker.ask, ticker.lastPrice]) if (!isOnGrid(value, context.priceIncrement)) return { outcome: "REJECTED", reason: "OFF_GRID" };
  for (const value of [ticker.bidSize, ticker.askSize, ticker.lastSize]) if (!isOnGrid(value, context.sizeIncrement)) return { outcome: "REJECTED", reason: "OFF_GRID" };
  const eventAt = BigInt(ticker.eventAtUs);
  const receivedAt = BigInt(context.receivedAtUs);
  if (eventAt > receivedAt + BigInt(context.maxFutureSkewMs) * 1000n) return { outcome: "REJECTED", reason: "FUTURE_TIME" };
  if (eventAt < receivedAt - BigInt(context.maxInitialEventDelayMs) * 1000n) return { outcome: "REJECTED", reason: "EXCESSIVE_EVENT_DELAY" };
  if (context.lastAcceptedEventAtUs !== undefined && eventAt < BigInt(context.lastAcceptedEventAtUs)) return { outcome: "REJECTED", reason: "EVENT_TIME_REGRESSION" };
  if (context.lastAcceptedTradeId === ticker.tradeId) return { outcome: "REJECTED", reason: "DUPLICATE" };
  if (scaledDecimal(ticker.bid) >= scaledDecimal(ticker.ask)) return { outcome: "HALT", reason: "LOCKED_OR_CROSSED" };
  if (context.referencePrice !== undefined) {
    const candidate = scaledDecimal(ticker.lastPrice);
    const reference = scaledDecimal(context.referencePrice);
    if (reference === 0n || (candidate >= reference ? candidate - reference : reference - candidate) * 10000n > reference * BigInt(context.maxPriceJumpBps)) {
      return { outcome: "HALT", reason: "PRICE_JUMP", candidatePrice: ticker.lastPrice, candidateSize: ticker.lastSize, referencePrice: context.referencePrice };
    }
  }
  return { outcome: "ACCEPTED" };
}

export function validateMatch(match: NormalizedMatch, context: MatchValidationContext): ValidationResult {
  if (!context.connected || context.lastMatchedTradeId === undefined) return { outcome: "ACCEPTED" };
  const candidate = BigInt(match.tradeId);
  const previous = BigInt(context.lastMatchedTradeId);
  if (candidate < previous) return { outcome: "HALT", reason: "OUT_OF_ORDER_MATCH_ID" };
  if (candidate > previous + 1n) return { outcome: "HALT", reason: "IN_SESSION_MATCH_GAP" };
  if (candidate === previous) return { outcome: "REJECTED", reason: "DUPLICATE" };
  return { outcome: "ACCEPTED" };
}

export interface ProductAssertion { readonly id: unknown; readonly status: unknown; readonly trading_disabled: unknown; readonly cancel_only: unknown; readonly limit_only: unknown; readonly post_only: unknown; readonly auction_mode: unknown; readonly status_message?: unknown; readonly quote_increment: unknown; readonly base_increment: unknown; }
export function productAssertionFailure(product: ProductAssertion, expected: { readonly symbol: string; readonly priceIncrement: DecimalString; readonly sizeIncrement: DecimalString }): boolean {
  if (product.id !== expected.symbol || product.status !== "online" || product.trading_disabled !== false || product.cancel_only !== false || product.limit_only !== false || product.post_only !== false || product.auction_mode !== false) return true;
  if (!(product.status_message === undefined || product.status_message === null || product.status_message === "")) return true;
  const quote = canonicalDecimal(product.quote_increment);
  const base = canonicalDecimal(product.base_increment);
  return quote !== expected.priceIncrement || base !== expected.sizeIncrement;
}

export function validateProductAssertion(product: ProductAssertion, expected: { readonly symbol: string; readonly priceIncrement: DecimalString; readonly sizeIncrement: DecimalString }): ValidationResult {
  return productAssertionFailure(product, expected) ? { outcome: "HALT", reason: "PRODUCT_ASSERTION_FAILURE" } : { outcome: "ACCEPTED" };
}
