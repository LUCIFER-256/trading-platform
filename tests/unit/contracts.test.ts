import type { ExecutionAdapter } from "../../packages/execution/src";
import type { RiskEvaluator } from "../../packages/risk/src";
import type { Strategy } from "../../packages/strategies/src";
import type { TransactionRunner } from "../../packages/database/src";
import { canonicalizeDecimalString } from "../../packages/shared/src";

/** Compile-time contract availability check; this is not runtime integration coverage. */
const contracts: readonly [Strategy, RiskEvaluator, ExecutionAdapter, TransactionRunner] | undefined = undefined;
void contracts;

const canonicalWhole = canonicalizeDecimalString("1");
const canonicalFraction = canonicalizeDecimalString("1.0");
if (!canonicalWhole.ok || !canonicalFraction.ok || canonicalWhole.value !== "1.000000000000000000" || canonicalWhole.value !== canonicalFraction.value) {
  throw new Error("Decimal canonicalization must make equivalent values idempotency-equivalent.");
}
if (canonicalizeDecimalString("1.0000000000000000001").ok) {
  throw new Error("Decimal canonicalization must reject excess fractional precision instead of rounding.");
}

console.log("Contract unit tests passed.");
