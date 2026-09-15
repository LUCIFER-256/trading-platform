import type { OrderIntent, TradingSignal } from "../../trading/src";

export type RiskDecision =
  | { readonly outcome: "approved"; readonly reason: string }
  | { readonly outcome: "rejected"; readonly reason: string; readonly ruleId: string };

/** Rules, sizing, and account evaluation are deliberately deferred to Phase 8. */
export interface RiskEvaluator {
  evaluate(signal: TradingSignal): Promise<RiskDecision>;
  authorize(intent: OrderIntent): Promise<RiskDecision>;
}
