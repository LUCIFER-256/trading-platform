import { canonicalDecimal, canonicalUnsignedInteger, eventAtUsFromRfc3339, type NormalizedHeartbeat, type NormalizedMatch, type NormalizedTicker } from "../../../../packages/market-data/src/normalization";

export const MAX_FRAME_PAYLOAD_BYTES = 65_536;
export type ParsedProviderMessage = NormalizedTicker | NormalizedMatch | NormalizedHeartbeat;
export type ParseResult = { readonly ok: true; readonly value: ParsedProviderMessage } | { readonly ok: false; readonly reason: "MALFORMED" | "NONFINITE" | "PAYLOAD_TOO_LARGE"; readonly source?: string };

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function identifier(value: unknown, source: string | undefined): string | undefined {
  if (typeof value === "string") return canonicalUnsignedInteger(value);
  return typeof value === "number" && Number.isSafeInteger(value) && source !== undefined && /^(0|[1-9][0-9]*)$/.test(source) ? source : undefined;
}

export function parseCoinbaseFrame(frame: string): ParseResult {
  if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_PAYLOAD_BYTES) return { ok: false, reason: "PAYLOAD_TOO_LARGE" };
  const decimalNumberSources: string[] = [];
  const identifierNumberSources = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame, function (key: string, value: unknown, ...contexts: readonly { readonly source: string }[]) {
      if (["price", "size", "last_size", "best_bid", "best_bid_size", "best_ask", "best_ask_size", "volume_24h"].includes(key) && typeof value === "number" && contexts[0] !== undefined) decimalNumberSources.push(contexts[0].source);
      if (["sequence", "trade_id", "last_trade_id"].includes(key) && typeof value === "number" && contexts[0] !== undefined) identifierNumberSources.set(key, contexts[0].source);
      return value;
    });
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (decimalNumberSources.length > 0) return { ok: false, reason: "MALFORMED", source: decimalNumberSources[0]! };
  const message = object(parsed);
  if (message === undefined || typeof message.type !== "string") return { ok: false, reason: "MALFORMED" };
  const symbol = string(message.product_id);
  const sequence = identifier(message.sequence, identifierNumberSources.get("sequence"));
  const eventAtUs = eventAtUsFromRfc3339(message.time);
  if (symbol === undefined || sequence === undefined || eventAtUs === undefined) return { ok: false, reason: "MALFORMED" };
  if (message.type === "ticker") {
    const tradeId = identifier(message.trade_id, identifierNumberSources.get("trade_id"));
    const bid = canonicalDecimal(message.best_bid); const bidSize = canonicalDecimal(message.best_bid_size); const ask = canonicalDecimal(message.best_ask); const askSize = canonicalDecimal(message.best_ask_size); const lastPrice = canonicalDecimal(message.price); const lastSize = canonicalDecimal(message.last_size);
    const volume24h = message.volume_24h === null ? null : canonicalDecimal(message.volume_24h);
    if (tradeId === undefined) return { ok: false, reason: "MALFORMED" };
    if ([message.best_bid, message.best_bid_size, message.best_ask, message.best_ask_size, message.price, message.last_size].some((value) => typeof value !== "string") || (message.volume_24h !== null && typeof message.volume_24h !== "string")) return { ok: false, reason: "MALFORMED" };
    if (bid === undefined || bidSize === undefined || ask === undefined || askSize === undefined || lastPrice === undefined || lastSize === undefined || volume24h === undefined) {
      return { ok: false, reason: "NONFINITE" };
    }
    return { ok: true, value: { kind: "ticker", symbol, sequence, tradeId, eventAtUs, bid, bidSize, ask, askSize, lastPrice, lastSize, volume24h } };
  }
  if (message.type === "match") {
    const tradeId = identifier(message.trade_id, identifierNumberSources.get("trade_id")); const price = canonicalDecimal(message.price); const size = canonicalDecimal(message.size);
    return tradeId === undefined || price === undefined || size === undefined ? { ok: false, reason: "MALFORMED" } : { ok: true, value: { kind: "match", symbol, sequence, tradeId, eventAtUs, price, size } };
  }
  if (message.type === "heartbeat") {
    const lastTradeId = identifier(message.last_trade_id, identifierNumberSources.get("last_trade_id"));
    return lastTradeId === undefined ? { ok: false, reason: "MALFORMED" } : { ok: true, value: { kind: "heartbeat", symbol, sequence, lastTradeId, eventAtUs } };
  }
  return { ok: false, reason: "MALFORMED" };
}
