import type { AppendMarketDataObservationResult, LatestMarketDataResult, MarketDataObservation } from "../../packages/market-data/src";
import { canonicalizeDecimalString } from "../../packages/market-data/src";
import type { InstrumentId } from "../../packages/shared/src";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function passes(name: string): void {
  console.log(name);
}

function decimalStringRejectsExponentAndNonCanonical(): void {
  const rejected = ["1e3", "+1", "01", "01.0", "1.", "", "NaN", "Infinity", "100000000000000000000", "0.0000000000000000001"];
  for (const input of rejected) {
    const result = canonicalizeDecimalString(input);
    assert(!result.ok && result.error === "INVALID_DECIMAL_STRING", `Expected ${input} to be rejected.`);
  }
  const accepted: readonly [string, string][] = [
    ["0", "0.000000000000000000"],
    ["0.10", "0.100000000000000000"],
    ["100.000", "100.000000000000000000"],
    ["99999999999999999999.999999999999999999", "99999999999999999999.999999999999999999"]
  ];
  for (const [input, expected] of accepted) {
    const result = canonicalizeDecimalString(input);
    assert(result.ok && result.value === expected, `Expected ${input} to canonicalize to ${expected}.`);
  }
  passes("decimalStringRejectsExponentAndNonCanonical");
}

function tickerContractCallsBidAskAsOfLastTrade(): void {
  const observation: MarketDataObservation = {
    instrumentId: "instrument" as InstrumentId,
    providerId: "provider",
    providerSymbol: "BTC-USD",
    providerSequence: "1",
    tradeId: "2",
    bidAsOfLastTrade: "1.000000000000000000" as MarketDataObservation["bidAsOfLastTrade"],
    bidSizeAsOfLastTrade: "2.000000000000000000" as MarketDataObservation["bidSizeAsOfLastTrade"],
    askAsOfLastTrade: "3.000000000000000000" as MarketDataObservation["askAsOfLastTrade"],
    askSizeAsOfLastTrade: "4.000000000000000000" as MarketDataObservation["askSizeAsOfLastTrade"],
    lastTradePrice: "5.000000000000000000" as MarketDataObservation["lastTradePrice"],
    lastTradeSize: "6.000000000000000000" as MarketDataObservation["lastTradeSize"],
    volume24h: null,
    eventAt: new Date(0),
    ingestedAt: new Date(0)
  };
  assert("bidAsOfLastTrade" in observation && "askAsOfLastTrade" in observation, "Observation quote names must be as-of-last-trade names.");
  passes("tickerContractCallsBidAskAsOfLastTrade");
}

function unavailableLatestResultHasNullObservation(): void {
  const result: LatestMarketDataResult = { availability: "UNAVAILABLE_NO_POLICY", observation: null };
  assert(result.availability === "UNAVAILABLE_NO_POLICY" && result.observation === null, "No row must use an unavailable result with null observation.");
  passes("unavailableLatestResultHasNullObservation");
}

function quoteAsOfLastTradeIsNotExecutionInput(): void {
  type HasExecutionPrice = "executionPrice" extends keyof MarketDataObservation ? true : false;
  const hasExecutionPrice: HasExecutionPrice = false;
  assert(hasExecutionPrice === false, "Market-data observations must not expose an execution price.");
  passes("quoteAsOfLastTradeIsNotExecutionInput");
}

function observationResultInvariants(): void {
  // @ts-expect-error ACCEPTED requires a non-null observation ID.
  const acceptedWithNullObservation: AppendMarketDataObservationResult = { outcome: "ACCEPTED", observationId: null, haltId: null };
  // @ts-expect-error ACCEPTED requires a null halt ID.
  const acceptedWithHalt: AppendMarketDataObservationResult = { outcome: "ACCEPTED", observationId: "observation", haltId: "halt" };
  // @ts-expect-error DUPLICATE_IDENTICAL requires a non-null observation ID.
  const duplicateWithNullObservation: AppendMarketDataObservationResult = { outcome: "DUPLICATE_IDENTICAL", observationId: null, haltId: null };
  // @ts-expect-error DUPLICATE_IDENTICAL requires a null halt ID.
  const duplicateWithHalt: AppendMarketDataObservationResult = { outcome: "DUPLICATE_IDENTICAL", observationId: "observation", haltId: "halt" };
  // @ts-expect-error IDEMPOTENCY_CONFLICT requires a null observation ID.
  const conflictWithObservation: AppendMarketDataObservationResult = { outcome: "IDEMPOTENCY_CONFLICT", observationId: "observation", haltId: "halt" };
  // @ts-expect-error IDEMPOTENCY_CONFLICT requires a non-null halt ID.
  const conflictWithNullHalt: AppendMarketDataObservationResult = { outcome: "IDEMPOTENCY_CONFLICT", observationId: null, haltId: null };
  // @ts-expect-error PRICE_JUMP_HALT requires a null observation ID.
  const priceJumpWithObservation: AppendMarketDataObservationResult = { outcome: "PRICE_JUMP_HALT", observationId: "observation", haltId: "halt" };
  // @ts-expect-error PRICE_JUMP_HALT requires a non-null halt ID.
  const priceJumpWithNullHalt: AppendMarketDataObservationResult = { outcome: "PRICE_JUMP_HALT", observationId: null, haltId: null };
  void [acceptedWithNullObservation, acceptedWithHalt, duplicateWithNullObservation, duplicateWithHalt, conflictWithObservation, conflictWithNullHalt, priceJumpWithObservation, priceJumpWithNullHalt];
  const results: readonly AppendMarketDataObservationResult[] = [
    { outcome: "ACCEPTED", observationId: "observation-1", haltId: null },
    { outcome: "DUPLICATE_IDENTICAL", observationId: "observation-2", haltId: null },
    { outcome: "IDEMPOTENCY_CONFLICT", observationId: null, haltId: "halt-1" },
    { outcome: "PRICE_JUMP_HALT", observationId: null, haltId: "halt-2" }
  ];
  for (const result of results) {
    if (result.outcome === "ACCEPTED" || result.outcome === "DUPLICATE_IDENTICAL") {
      assert(result.observationId !== null && result.haltId === null, `${result.outcome} invariant failed.`);
    } else {
      assert(result.observationId === null && result.haltId !== null, `${result.outcome} invariant failed.`);
    }
  }
  passes("observationResultInvariants");
}

decimalStringRejectsExponentAndNonCanonical();
tickerContractCallsBidAskAsOfLastTrade();
unavailableLatestResultHasNullObservation();
quoteAsOfLastTradeIsNotExecutionInput();
observationResultInvariants();
