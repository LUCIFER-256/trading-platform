import type { Generated, Kysely, Transaction } from "kysely";

/**
 * Catalog table typings mirror the approved Sprint 2.4 migration. Queries use
 * `database.withSchema("platform")` rather than treating the schema name as
 * part of a table identifier.
 */
export interface DatabaseSchema {
  markets: MarketsTable;
  instruments: InstrumentsTable;
  providers: ProvidersTable;
  provider_instrument_symbols: ProviderInstrumentSymbolsTable;
}

export interface MarketsTable {
  id: Generated<string>;
  market_code: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface InstrumentsTable {
  id: Generated<string>;
  market_id: string;
  instrument_code: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProvidersTable {
  id: Generated<string>;
  provider_code: string;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderInstrumentSymbolsTable {
  id: Generated<string>;
  provider_id: string;
  instrument_id: string;
  provider_symbol: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

/** The database package's Kysely client type. */
export type KyselyDatabase = Kysely<DatabaseSchema>;

/** A Kysely context pinned to one PostgreSQL transaction connection. */
export type DatabaseTransaction = Transaction<DatabaseSchema>;
