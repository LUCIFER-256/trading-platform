import type { DecimalString, InstrumentId, OrderId, SignalId, StrategyId } from "../../shared/src";

export type TradeDirection = "buy" | "sell";
export type SignalLifecycle = "generated" | "evaluated" | "approved" | "rejected" | "expired" | "consumed";

export interface TradingSignal {
  readonly signalId: SignalId;
  readonly strategyId: StrategyId;
  readonly instrumentId: InstrumentId;
  readonly timeframe: string;
  readonly direction: TradeDirection;
  readonly timestamp: Date;
  readonly entryReference?: DecimalString;
  readonly stopReference?: DecimalString;
  readonly takeProfitReference?: DecimalString;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly lifecycle: SignalLifecycle;
}

export type OrderIntentStatus = "created" | "risk_approved" | "risk_rejected";

/** An intent is internal authorization data, not an execution request. */
export interface OrderIntent {
  readonly orderId: OrderId;
  readonly signalId: SignalId;
  readonly instrumentId: InstrumentId;
  readonly direction: TradeDirection;
  readonly quantity: DecimalString;
  readonly idempotencyKey: string;
  readonly status: OrderIntentStatus;
}

export interface InstrumentActivationPolicy {
  permitsNewActivity(instrumentId: InstrumentId): Promise<boolean>;
}
