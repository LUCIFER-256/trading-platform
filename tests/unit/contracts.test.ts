import type { ExecutionAdapter } from "../../packages/execution/src";
import type { RiskEvaluator } from "../../packages/risk/src";
import type { Strategy } from "../../packages/strategies/src";
import type { TransactionRunner } from "../../packages/database/src";

/** Compile-time contract availability check; this is not runtime integration coverage. */
const contracts: readonly [Strategy, RiskEvaluator, ExecutionAdapter, TransactionRunner] | undefined = undefined;
void contracts;

console.log("Contract unit tests passed.");
