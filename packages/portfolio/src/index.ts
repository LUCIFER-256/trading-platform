import type { AccountId, DecimalString, InstrumentId } from "../../shared/src";

export interface PositionSnapshot {
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly quantity: DecimalString;
  readonly observedAt: Date;
}

export interface PortfolioReader {
  getPosition(accountId: AccountId, instrumentId: InstrumentId): Promise<PositionSnapshot | undefined>;
}
