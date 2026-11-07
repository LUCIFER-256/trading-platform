import { sql, type KyselyDatabase } from "../../../../packages/database/src";
import { canonicalDecimal } from "../../../../packages/market-data/src";
import type { DecimalString } from "../../../../packages/shared/src";
import { agreedProviderPolicy, type ProviderPolicy } from "../circuit";
import type { CatalogMapping } from "./postgres-persistence-port";
import { sqlState } from "./sql-state";

export interface InstrumentPolicy {
  readonly priceIncrement: DecimalString;
  readonly sizeIncrement: DecimalString;
  readonly maxInitialEventDelayMs: number;
  readonly maxFutureSkewMs: number;
  readonly maxPriceJumpBps: number;
}

export interface EnginePolicies {
  readonly provider: ProviderPolicy;
  readonly instruments: ReadonlyMap<string, InstrumentPolicy>;
}

export class EnginePolicyError extends Error {
  public readonly name = "EnginePolicyError";

  public constructor(readonly code: "MISSING" | "DISAGREEMENT" | "INVALID" | "DATABASE", sqlState?: string) {
    super(`Market-data engine policy failed: ${code}.${sqlState === undefined ? "" : ` SQLSTATE ${sqlState}.`}`);
  }
}

interface PolicyRow {
  readonly instrument_id: string;
  readonly enabled: boolean;
  readonly price_increment: string;
  readonly size_increment: string;
  readonly max_initial_event_delay_ms: number;
  readonly max_future_skew_ms: number;
  readonly max_price_jump_bps: number;
  readonly heartbeat_timeout_ms: number;
  readonly circuit_failure_threshold: number;
  readonly circuit_failure_window_ms: number;
  readonly circuit_cooldown_ms: number;
  readonly circuit_half_open_ready_ms: number;
  readonly heartbeat_ahead_count: number;
  readonly heartbeat_ahead_span_ms: number;
  readonly heartbeat_settle_count: number;
  readonly heartbeat_settle_span_ms: number;
}

export interface PolicyRepository {
  policyRows(database: KyselyDatabase, instrumentIds: readonly string[]): Promise<readonly PolicyRow[]>;
}

const repository: PolicyRepository = {
  async policyRows(database, instrumentIds): Promise<readonly PolicyRow[]> {
    const result = await sql<PolicyRow>`select pol.instrument_id, pol.enabled, i.price_increment, i.size_increment,
      pol.max_initial_event_delay_ms, pol.max_future_skew_ms, pol.max_price_jump_bps,
      pol.heartbeat_timeout_ms, pol.circuit_failure_threshold, pol.circuit_failure_window_ms,
      pol.circuit_cooldown_ms, pol.circuit_half_open_ready_ms, pol.heartbeat_ahead_count,
      pol.heartbeat_ahead_span_ms, pol.heartbeat_settle_count, pol.heartbeat_settle_span_ms
      from platform.market_data_policies pol
      join platform.instruments i on i.id = pol.instrument_id
      where pol.instrument_id in (${sql.join(instrumentIds)})`.execute(database);
    return result.rows;
  },
};

export async function loadEnginePolicies(
  database: KyselyDatabase,
  mapping: CatalogMapping,
  labels: readonly string[],
  calls: PolicyRepository = repository,
): Promise<EnginePolicies> {
  const allIds = [...mapping.instrumentsByLabel.values()];
  if (labels.length === 0 || labels.some((label) => !mapping.instrumentsByLabel.has(label))) {
    throw new EnginePolicyError("MISSING");
  }
  let rows: readonly PolicyRow[];
  try {
    rows = await calls.policyRows(database, allIds);
  } catch (error) {
    throw new EnginePolicyError("DATABASE", sqlState(error));
  }
  const providerRows = rows.filter((row) => row.enabled).map(providerPolicy);
  const instruments = new Map<string, InstrumentPolicy>();
  for (const label of labels) {
    const row = rows.find((candidate) => candidate.instrument_id === mapping.instrumentsByLabel.get(label));
    if (row === undefined || !row.enabled) throw new EnginePolicyError("MISSING");
    const priceIncrement = canonicalDecimal(row.price_increment);
    const sizeIncrement = canonicalDecimal(row.size_increment);
    if (priceIncrement === undefined || sizeIncrement === undefined) throw new EnginePolicyError("INVALID");
    instruments.set(label, {
      priceIncrement,
      sizeIncrement,
      maxInitialEventDelayMs: row.max_initial_event_delay_ms,
      maxFutureSkewMs: row.max_future_skew_ms,
      maxPriceJumpBps: row.max_price_jump_bps,
    });
  }
  try {
    return { provider: agreedProviderPolicy(providerRows), instruments };
  } catch {
    throw new EnginePolicyError("DISAGREEMENT");
  }
}

function providerPolicy(row: PolicyRow): ProviderPolicy {
  return {
    heartbeatTimeoutMs: row.heartbeat_timeout_ms,
    circuitFailureThreshold: row.circuit_failure_threshold,
    circuitFailureWindowMs: row.circuit_failure_window_ms,
    circuitCooldownMs: row.circuit_cooldown_ms,
    circuitHalfOpenReadyMs: row.circuit_half_open_ready_ms,
    heartbeatAheadCount: row.heartbeat_ahead_count,
    heartbeatAheadSpanMs: row.heartbeat_ahead_span_ms,
    heartbeatSettleCount: row.heartbeat_settle_count,
    heartbeatSettleSpanMs: row.heartbeat_settle_span_ms,
  };
}
