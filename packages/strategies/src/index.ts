import type { MarketDataPoint } from "../../market-data/src";
import type { TradingSignal } from "../../trading/src";
import type { InstrumentId, StrategyId } from "../../shared/src";

export interface StrategyEvaluationContext {
  readonly instrumentId: InstrumentId;
  readonly evaluatedAt: Date;
  readonly marketData: readonly MarketDataPoint[];
}

/** Strategies can only create signals; they have no order/execution dependency. */
export interface Strategy {
  readonly strategyId: StrategyId;
  evaluate(context: StrategyEvaluationContext): Promise<readonly TradingSignal[]>;
}
