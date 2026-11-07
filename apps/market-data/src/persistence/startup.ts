import {
  marketDataStartupRecovery,
  sql,
  type KyselyDatabase,
  type MarketDataStartupRecovery,
} from "../../../../packages/database/src";
import {
  buildCatalogMapping,
  type CatalogConfiguration,
  type CatalogMapping,
  type CatalogRow,
} from "./postgres-persistence-port";
import { sqlState } from "./sql-state";

export type StartupSkipReason = "NO_POLICY" | "DISABLED_SCOPE" | "HUMAN_HALT" | "RECOVERY_ERROR";

export interface StartupSeed {
  readonly price: string;
  readonly eventTime: string;
}

export interface StartupInstrument {
  readonly label: string;
  readonly symbol: string;
}

export interface StartupResult {
  readonly started: readonly StartupInstrument[];
  readonly skipped: ReadonlyMap<string, StartupSkipReason>;
  readonly humanHalted: ReadonlySet<string>;
  readonly recovery: ReadonlyMap<string, StartupSeed>;
  readonly failures: ReadonlyMap<string, StartupRecoveryError>;
  readonly jumpResets: ReadonlyMap<string, {
    readonly id: string;
    readonly confirmedPrice: string;
    readonly toleranceBps: number;
    readonly expiresAt: Date;
  }>;
}

export interface StartupRepository {
  catalogRows(database: KyselyDatabase): Promise<readonly CatalogRow[]>;
  inspectScope(
    database: KyselyDatabase,
    providerId: string | undefined,
    symbol: string,
  ): Promise<"NO_POLICY" | "DISABLED_SCOPE" | "ACTIVE">;
  marketDataStartupRecovery(
    database: KyselyDatabase,
    instrumentId: string,
  ): Promise<MarketDataStartupRecovery | undefined>;
}

const repository: StartupRepository = {
  async catalogRows(database): Promise<readonly CatalogRow[]> {
    const result = await sql<{
      readonly provider_id: string;
      readonly instrument_id: string;
      readonly provider_symbol: string;
    }>`select s.provider_id, s.instrument_id, s.provider_symbol
      from platform.provider_instrument_symbols s
      join platform.providers p on p.id = s.provider_id and p.enabled
      join platform.instruments i on i.id = s.instrument_id and i.enabled
      join platform.markets m on m.id = i.market_id and m.enabled
      join platform.market_data_policies pol on pol.instrument_id = i.id and pol.enabled
      where s.enabled`.execute(database);
    return result.rows.map((row) => ({
      providerId: row.provider_id,
      instrumentId: row.instrument_id,
      providerSymbol: row.provider_symbol,
    }));
  },
  async inspectScope(database, providerId, symbol): Promise<"NO_POLICY" | "DISABLED_SCOPE" | "ACTIVE"> {
    const result = await sql<{
      readonly provider_enabled: boolean;
      readonly market_enabled: boolean;
      readonly instrument_enabled: boolean;
      readonly mapping_enabled: boolean;
      readonly policy_enabled: boolean | null;
    }>`select p.enabled as provider_enabled, m.enabled as market_enabled,
      i.enabled as instrument_enabled, s.enabled as mapping_enabled, pol.enabled as policy_enabled
      from platform.provider_instrument_symbols s
      join platform.providers p on p.id = s.provider_id
      join platform.instruments i on i.id = s.instrument_id
      join platform.markets m on m.id = i.market_id
      left join platform.market_data_policies pol on pol.instrument_id = i.id
      where s.provider_symbol = ${symbol}
        and (cast(${providerId ?? null} as uuid) is null or s.provider_id = cast(${providerId ?? null} as uuid))`
      .execute(database);
    if (result.rows.length > 1) throw new Error("Startup scope is ambiguous.");
    const row = result.rows[0];
    if (row === undefined) return "DISABLED_SCOPE";
    if (row.policy_enabled === null) return "NO_POLICY";
    if (!row.provider_enabled || !row.market_enabled || !row.instrument_enabled || !row.mapping_enabled || !row.policy_enabled) {
      return "DISABLED_SCOPE";
    }
    return "ACTIVE";
  },
  marketDataStartupRecovery,
};

export class StartupRecoveryError extends Error {
  public readonly name = "StartupRecoveryError";

  public constructor(sqlState?: string) {
    super(`Market-data startup recovery failed.${sqlState === undefined ? "" : ` SQLSTATE ${sqlState}.`}`);
  }
}

export interface StartupCatalog {
  readonly mapping: CatalogMapping | undefined;
  readonly unresolved: readonly string[];
}

export function resolveStartupCatalog(
  rows: readonly CatalogRow[],
  configuration: CatalogConfiguration,
): StartupCatalog {
  const resolvable = configuration.instruments.filter(
    (configured) => rows.some((row) => row.providerSymbol === configured.symbol),
  );
  const unresolved = configuration.instruments
    .filter((configured) => !resolvable.includes(configured))
    .map((configured) => configured.label);
  if (resolvable.length === 0) return { mapping: undefined, unresolved };
  return {
    mapping: buildCatalogMapping(rows, { ...configuration, instruments: resolvable }),
    unresolved,
  };
}

export async function loadStartupCatalog(
  database: KyselyDatabase,
  configuration: CatalogConfiguration,
  calls: StartupRepository = repository,
): Promise<StartupCatalog> {
  let rows: readonly CatalogRow[];
  try {
    rows = await calls.catalogRows(database);
  } catch (error) {
    throw safeRecoveryError(error);
  }
  return resolveStartupCatalog(rows, configuration);
}

export async function recoverMarketDataStartup(
  database: KyselyDatabase,
  mapping: CatalogMapping | undefined,
  configuration: CatalogConfiguration,
  calls: StartupRepository = repository,
): Promise<StartupResult> {
  const started: StartupInstrument[] = [];
  const skipped = new Map<string, StartupSkipReason>();
  const humanHalted = new Set<string>();
  const recovery = new Map<string, StartupSeed>();
  const failures = new Map<string, StartupRecoveryError>();
  const jumpResets = new Map<string, {
    readonly id: string;
    readonly confirmedPrice: string;
    readonly toleranceBps: number;
    readonly expiresAt: Date;
  }>();
  for (const configured of configuration.instruments) {
    const instrumentId = mapping?.instrumentsByLabel.get(configured.label);
    if (instrumentId === undefined) {
      const scope = await inspectScope(calls, database, mapping?.providerUuid, configured.symbol);
      skipped.set(configured.label, scope.reason);
      if (scope.failure !== undefined) failures.set(configured.label, scope.failure);
      continue;
    }
    try {
      const state = await calls.marketDataStartupRecovery(database, instrumentId);
      if (state?.haltId !== null && state?.haltId !== undefined) {
        humanHalted.add(configured.label);
        skipped.set(configured.label, "HUMAN_HALT");
        continue;
      }
      if (state?.lastAcceptedPrice !== null && state?.lastAcceptedPrice !== undefined && state.eventAt !== null) {
        recovery.set(configured.label, {
          price: state.lastAcceptedPrice,
          eventTime: (BigInt(state.eventAt.getTime()) * 1000n).toString(),
        });
      }
      if (state?.resetId !== null && state?.resetId !== undefined
        && state.confirmedCandidatePrice !== null && state.toleranceBps !== null && state.expiresAt !== null) {
        jumpResets.set(configured.label, {
          id: state.resetId,
          confirmedPrice: state.confirmedCandidatePrice,
          toleranceBps: state.toleranceBps,
          expiresAt: state.expiresAt,
        });
      }
      started.push({ label: configured.label, symbol: configured.symbol });
    } catch (error) {
      skipped.set(configured.label, "RECOVERY_ERROR");
      failures.set(configured.label, safeRecoveryError(error));
    }
  }
  return { started, skipped, humanHalted, recovery, failures, jumpResets };
}

async function inspectScope(
  calls: StartupRepository,
  database: KyselyDatabase,
  providerId: string | undefined,
  symbol: string,
): Promise<{ readonly reason: StartupSkipReason; readonly failure?: StartupRecoveryError }> {
  try {
    const result = await calls.inspectScope(database, providerId, symbol);
    return { reason: result === "ACTIVE" ? "RECOVERY_ERROR" : result };
  } catch (error) {
    return { reason: "RECOVERY_ERROR", failure: safeRecoveryError(error) };
  }
}

function safeRecoveryError(error: unknown): StartupRecoveryError {
  return new StartupRecoveryError(sqlState(error));
}
