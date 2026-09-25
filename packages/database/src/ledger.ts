import { sql } from "kysely";
import {
  canonicalizeDecimalString,
  type DecimalString,
  type LedgerTransactionId,
  type Result,
  type WalletId
} from "../../shared/src";
import type { KyselyDatabase } from "./kysely";

export type LedgerEventType = "deposit" | "withdrawal" | "manual_adjustment";
export type LedgerEntrySide = "debit" | "credit";

export interface LedgerPostingRequest {
  readonly eventType: LedgerEventType;
  readonly walletId: WalletId;
  readonly assetId: string;
  readonly amount: DecimalString;
  readonly customerEntrySide: LedgerEntrySide;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly sessionSecret: string;
  readonly reason: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export type LedgerPostingFailure = "INVALID_DECIMAL_STRING";

/** Calls the database-owned, atomic ledger posting function. */
export async function postLedgerTransaction(
  database: KyselyDatabase,
  request: LedgerPostingRequest
): Promise<Result<LedgerTransactionId, LedgerPostingFailure>> {
  const canonicalAmount = canonicalizeDecimalString(request.amount);
  if (!canonicalAmount.ok) return canonicalAmount;

  const result = await sql<{ readonly id: string }>`
    select platform.post_ledger_transaction(
      ${request.sessionId},
      ${request.sessionSecret},
      ${request.eventType},
      ${request.walletId},
      ${request.assetId},
      ${canonicalAmount.value},
      ${request.customerEntrySide},
      ${request.idempotencyKey},
      ${request.reason},
      cast(${JSON.stringify(request.metadata)} as jsonb),
      ${request.occurredAt}
    ) as id
  `.execute(database);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("Ledger posting function did not return a transaction identifier.");
  return { ok: true, value: id as LedgerTransactionId };
}
