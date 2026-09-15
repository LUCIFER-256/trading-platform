export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type UserId = Brand<string, "UserId">;
export type AccountId = Brand<string, "AccountId">;
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

export type Result<Value, Failure extends string = string> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
