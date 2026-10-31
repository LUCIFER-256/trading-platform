export type TermsAcknowledgement =
  | "RA1_RISK_ACCEPTED"
  | "WRITTEN_CLEARANCE";

export class TermsGateError extends Error {
  public readonly name = "TermsGateError";

  public constructor() {
    super("Market-data persistence requires a configured terms acknowledgement.");
  }
}

export interface TermsGateResult {
  readonly acknowledgement: TermsAcknowledgement;
  readonly logLine: string;
}

export function requireTermsAcknowledgement(value: unknown): TermsGateResult {
  if (value !== "RA1_RISK_ACCEPTED" && value !== "WRITTEN_CLEARANCE") {
    throw new TermsGateError();
  }
  return {
    acknowledgement: value,
    logLine: `Market-data persistence acknowledgement: ${value}.`,
  };
}
