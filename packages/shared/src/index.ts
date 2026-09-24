export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type UserId = Brand<string, "UserId">;
export type AccountId = Brand<string, "AccountId">;
export type AssetId = Brand<string, "AssetId">;
export type WalletId = Brand<string, "WalletId">;
export type LedgerAccountId = Brand<string, "LedgerAccountId">;
export type LedgerTransactionId = Brand<string, "LedgerTransactionId">;
export type InstrumentId = Brand<string, "InstrumentId">;
export type StrategyId = Brand<string, "StrategyId">;
export type SignalId = Brand<string, "SignalId">;
export type OrderId = Brand<string, "OrderId">;
export type RequestId = Brand<string, "RequestId">;

/**
 * Decimal values are strings at domain boundaries. JavaScript number is
 * intentionally prohibited for money, prices, quantities, fees, and P&L.
 * Scale and rounding policy are deferred to the instrument/ledger phase.
 */
export type DecimalString = Brand<string, "DecimalString">;

/**
 * Converts a non-negative decimal input to the Phase 3 fixed-scale form.
 * It rejects imprecise input rather than rounding it.
 */
export function canonicalizeDecimalString(value: string): Result<DecimalString, "INVALID_DECIMAL_STRING"> {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) return { ok: false, error: "INVALID_DECIMAL_STRING" };
  const integer = match[1]!.replace(/^0+(?=\d)/, "");
  const fractional = match[2] ?? "";
  if (integer.length > 20 || fractional.length > 18) return { ok: false, error: "INVALID_DECIMAL_STRING" };
  return { ok: true, value: `${integer}.${fractional.padEnd(18, "0")}` as DecimalString };
}

export type Result<Value, Failure extends string = string> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
