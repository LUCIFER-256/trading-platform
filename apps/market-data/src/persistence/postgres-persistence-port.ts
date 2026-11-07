import { randomBytes } from "node:crypto";
import {
  appendMarketDataObservation,
  appendMarketDataQualityBucket,
  openMarketDataHalt,
  sql,
  transitionMarketDataState,
  type AppendMarketDataObservationRequest,
  type AppendMarketDataQualityBucketRequest,
  type KyselyDatabase,
  type MarketDataHaltReason,
  type OpenMarketDataHaltRequest,
  type TransitionMarketDataStateRequest,
} from "../../../../packages/database/src";
import type { AppendMarketDataObservationResult } from "../../../../packages/market-data/src";
import type {
  AppendObservationRequest,
  AppendQualityBucketRequest,
  OpenHaltRequest,
  PersistencePort,
  TransitionStateRequest,
} from "../ports";
import { sqlState } from "./sql-state";

const HALT_REASONS = new Set<MarketDataHaltReason>([
  "LOCKED_OR_CROSSED", "OUT_OF_ORDER_MATCH_ID", "IN_SESSION_MATCH_GAP",
  "PRICE_JUMP", "PRODUCT_ASSERTION_FAILURE", "IDEMPOTENCY_CONFLICT",
]);

export class PostgresPersistenceError extends Error {
  public readonly name = "PostgresPersistenceError";
  public constructor(
    readonly operation: "catalog" | "append" | "halt" | "transition" | "quality",
    sqlState?: string,
  ) {
    super(`Market-data persistence ${operation} failed.${sqlState === undefined ? "" : ` SQLSTATE ${sqlState}.`}`);
  }
}

export interface CatalogConfiguration {
  readonly providerLabel: string;
  readonly instruments: readonly { readonly label: string; readonly symbol: string }[];
}
export interface CatalogRow {
  readonly providerId: string;
  readonly instrumentId: string;
  readonly providerSymbol: string;
}
export interface CatalogMapping {
  readonly providerId: string;
  readonly providerUuid: string;
  readonly instrumentsByLabel: ReadonlyMap<string, string>;
  readonly instrumentsBySymbol: ReadonlyMap<string, string>;
}
export interface PostgresPersistenceRepository {
  appendObservation(
    database: KyselyDatabase,
    request: AppendMarketDataObservationRequest,
  ): Promise<AppendMarketDataObservationResult>;
  openHalt(database: KyselyDatabase, request: OpenMarketDataHaltRequest): Promise<string>;
  transitionState(database: KyselyDatabase, request: TransitionMarketDataStateRequest): Promise<void>;
  appendQualityBucket(
    database: KyselyDatabase,
    request: AppendMarketDataQualityBucketRequest,
  ): Promise<void>;
}

const repository: PostgresPersistenceRepository = {
  appendObservation: appendMarketDataObservation,
  openHalt: openMarketDataHalt,
  transitionState: transitionMarketDataState,
  appendQualityBucket: appendMarketDataQualityBucket,
};

export function buildCatalogMapping(
  rows: readonly CatalogRow[],
  configuration: CatalogConfiguration,
): CatalogMapping {
  if (configuration.providerLabel.length === 0 || configuration.instruments.length === 0) {
    throw new PostgresPersistenceError("catalog");
  }
  const labels = new Map<string, string>();
  const symbols = new Map<string, string>();
  let providerUuid: string | undefined;
  for (const target of configuration.instruments) {
    if (target.label.length === 0 || target.symbol.length === 0 || labels.has(target.label)) {
      throw new PostgresPersistenceError("catalog");
    }
    const matches = rows.filter((row) => row.providerSymbol === target.symbol);
    if (matches.length !== 1) throw new PostgresPersistenceError("catalog");
    const match = matches[0]!;
    if (providerUuid !== undefined && providerUuid !== match.providerId) {
      throw new PostgresPersistenceError("catalog");
    }
    if ([...labels.values()].includes(match.instrumentId)) {
      throw new PostgresPersistenceError("catalog");
    }
    providerUuid = match.providerId;
    labels.set(target.label, match.instrumentId);
    symbols.set(target.symbol, match.instrumentId);
  }
  if (providerUuid === undefined) throw new PostgresPersistenceError("catalog");
  return {
    providerId: configuration.providerLabel,
    providerUuid,
    instrumentsByLabel: labels,
    instrumentsBySymbol: symbols,
  };
}

export class PostgresPersistencePort implements PersistencePort {
  private readonly flushIds = new Map<string, string>();
  public constructor(
    private readonly database: KyselyDatabase,
    private readonly mapping: CatalogMapping,
    private readonly calls: PostgresPersistenceRepository = repository,
  ) {}

  public static async fromCatalog(
    database: KyselyDatabase,
    configuration: CatalogConfiguration,
    calls: PostgresPersistenceRepository = repository,
  ): Promise<PostgresPersistencePort> {
    try {
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
      const rows = result.rows.map((row) => ({
        providerId: row.provider_id,
        instrumentId: row.instrument_id,
        providerSymbol: row.provider_symbol,
      }));
      return new PostgresPersistencePort(database, buildCatalogMapping(rows, configuration), calls);
    } catch (error) {
      if (error instanceof PostgresPersistenceError) throw error;
      throw safeError("catalog", error);
    }
  }
  public async appendObservation(request: AppendObservationRequest): Promise<AppendMarketDataObservationResult> {
    const instrumentId = this.observationInstrument(request.instrumentId, request.providerSymbol);
    return this.call("append", () => this.calls.appendObservation(this.database, {
      ...request,
      providerId: this.provider(request.providerId),
      instrumentId,
    }));
  }
  public async openHalt(request: OpenHaltRequest): Promise<string> {
    return this.call("halt", () => this.calls.openHalt(this.database, {
      ...request,
      providerId: this.provider(request.providerId),
      instrumentId: this.requiredInstrument(request.instrumentId),
      reasonCode: haltReason(request.reasonCode),
    }));
  }
  public async transitionState(request: TransitionStateRequest): Promise<void> {
    return this.call("transition", () => this.calls.transitionState(this.database, {
      ...request,
      providerId: this.provider(request.providerId),
      instrumentId: request.instrumentId === null ? null : this.requiredInstrument(request.instrumentId),
    }));
  }
  public async appendQualityBucket(request: AppendQualityBucketRequest): Promise<void> {
    const providerId = this.provider(request.providerId);
    const instrumentId = request.instrumentId === null
      ? null
      : this.requiredInstrument(request.instrumentId);
    const flushId = this.flushIds.get(request.flushId) ?? uuidV7();
    this.flushIds.set(request.flushId, flushId);
    await this.call("quality", () => this.calls.appendQualityBucket(this.database, {
      ...request,
      flushId,
      providerId,
      instrumentId,
    }));
    this.flushIds.delete(request.flushId);
  }
  private provider(value: string): string {
    if (value !== this.mapping.providerId) throw new PostgresPersistenceError("catalog");
    return this.mapping.providerUuid;
  }
  private requiredInstrument(value: unknown): string {
    if (typeof value !== "string") throw new PostgresPersistenceError("catalog");
    const instrument = this.mapping.instrumentsByLabel.get(value);
    if (instrument === undefined) throw new PostgresPersistenceError("catalog");
    return instrument;
  }
  private observationInstrument(label: unknown, symbol: unknown): string {
    const byLabel = this.requiredInstrument(label);
    if (typeof symbol !== "string" || this.mapping.instrumentsBySymbol.get(symbol) !== byLabel) {
      throw new PostgresPersistenceError("catalog");
    }
    return byLabel;
  }
  private async call<T>(operation: PostgresPersistenceError["operation"], action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof PostgresPersistenceError) throw error;
      throw safeError(operation, error);
    }
  }
}

function haltReason(value: string): MarketDataHaltReason {
  if (!HALT_REASONS.has(value as MarketDataHaltReason)) {
    throw new PostgresPersistenceError("halt");
  }
  return value as MarketDataHaltReason;
}
function safeError(operation: PostgresPersistenceError["operation"], error: unknown): PostgresPersistenceError {
  return new PostgresPersistenceError(operation, sqlState(error));
}
export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
