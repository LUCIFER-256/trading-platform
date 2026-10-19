import { canonicalizeDecimalString, type DecimalString } from "../../shared/src";

export const MAX_EVENT_AT_US = 253402300799999999n;

export type NormalizedTicker = {
  readonly kind: "ticker";
  readonly symbol: string;
  readonly sequence: string;
  readonly tradeId: string;
  readonly eventAtUs: string;
  readonly bid: DecimalString;
  readonly bidSize: DecimalString;
  readonly ask: DecimalString;
  readonly askSize: DecimalString;
  readonly lastPrice: DecimalString;
  readonly lastSize: DecimalString;
  readonly volume24h: DecimalString | null;
};

export type NormalizedMatch = { readonly kind: "match"; readonly symbol: string; readonly sequence: string; readonly tradeId: string; readonly eventAtUs: string; readonly price: DecimalString; readonly size: DecimalString };
export type NormalizedHeartbeat = { readonly kind: "heartbeat"; readonly symbol: string; readonly sequence: string; readonly lastTradeId: string; readonly eventAtUs: string };

export function canonicalUnsignedInteger(value: unknown): string | undefined {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20 ? value : undefined;
}

export function canonicalDecimal(value: unknown): DecimalString | undefined {
  if (typeof value !== "string") return undefined;
  const result = canonicalizeDecimalString(value);
  return result.ok ? result.value : undefined;
}

export function eventAtUsFromRfc3339(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(value);
  if (match === null) return undefined;
  const milliseconds = Date.parse(`${match[1]}.000Z`);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== match[1]) return undefined;
  const eventAtUs = BigInt(milliseconds) * 1000n + BigInt(match[2]!);
  return eventAtUs >= 0n && eventAtUs <= MAX_EVENT_AT_US ? eventAtUs.toString() : undefined;
}

export function scaledDecimal(value: DecimalString): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(18, "0")}`);
}
