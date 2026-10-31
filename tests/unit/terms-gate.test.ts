import {
  requireTermsAcknowledgement,
  TermsGateError,
} from "../../apps/market-data/src/terms-gate";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function rejects(value: unknown): void {
  try {
    requireTermsAcknowledgement(value);
  } catch (error) {
    assert(error instanceof TermsGateError, "Terms gate must use its safe error.");
    return;
  }
  throw new Error("Terms gate must reject this acknowledgement.");
}

function unitTermsGateRefusesBeforeAcknowledgement(): void {
  for (const value of [undefined, "", "ra1_risk_accepted", "unknown"]) {
    rejects(value);
  }
  const accepted = requireTermsAcknowledgement("RA1_RISK_ACCEPTED");
  const written = requireTermsAcknowledgement("WRITTEN_CLEARANCE");
  assert(accepted.acknowledgement === "RA1_RISK_ACCEPTED", "RA1 acknowledgement must pass.");
  assert(written.acknowledgement === "WRITTEN_CLEARANCE", "Written acknowledgement must pass.");
  assert(
    !accepted.logLine.toLowerCase().includes("cleared"),
    "RA1 log line must not use prohibited terms language.",
  );
  console.log("unitTermsGateRefusesBeforeAcknowledgement");
}

unitTermsGateRefusesBeforeAcknowledgement();
