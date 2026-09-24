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
  users: UsersTable;
  accounts: AccountsTable;
  strategies: StrategiesTable;
  strategy_configurations: StrategyConfigurationsTable;
  risk_configurations: RiskConfigurationsTable;
  broker_connections: BrokerConnectionsTable;
  assets: AssetsTable;
  wallets: WalletsTable;
  ledger_accounts: LedgerAccountsTable;
  ledger_transactions: LedgerTransactionsTable;
  ledger_entries: LedgerEntriesTable;
  wallet_balances: WalletBalancesView;
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

export interface UsersTable {
  id: Generated<string>;
  user_code: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AccountsTable {
  id: Generated<string>;
  user_id: string;
  account_code: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface StrategiesTable {
  id: Generated<string>;
  user_id: string;
  strategy_code: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface StrategyConfigurationsTable {
  id: Generated<string>;
  strategy_id: string;
  version: number;
  configuration: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RiskConfigurationsTable {
  id: Generated<string>;
  account_id: string;
  version: number;
  configuration: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BrokerConnectionsTable {
  id: Generated<string>;
  account_id: string;
  provider_id: string;
  connection_code: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AssetsTable {
  id: Generated<string>;
  asset_code: string;
  asset_kind: "fiat" | "crypto" | "other";
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface WalletsTable {
  id: Generated<string>;
  account_id: string;
  asset_id: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface LedgerAccountsTable {
  id: Generated<string>;
  asset_id: string;
  account_id: string | null;
  wallet_id: string | null;
  account_code: "customer_wallet" | "external_deposit_clearing" | "external_withdrawal_clearing" | "manual_adjustment_clearing";
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface LedgerTransactionsTable {
  id: Generated<string>;
  event_type: "deposit" | "withdrawal" | "manual_adjustment";
  asset_id: string;
  wallet_id: string;
  customer_ledger_account_id: string;
  counterparty_ledger_account_id: string;
  customer_entry_side: "debit" | "credit";
  amount: string;
  idempotency_key: string;
  actor_reference: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
}

export interface LedgerEntriesTable {
  id: Generated<string>;
  ledger_transaction_id: string;
  ledger_account_id: string;
  entry_side: "debit" | "credit";
  amount: string;
  created_at: Date;
}

export interface WalletBalancesView {
  wallet_id: string;
  account_id: string;
  asset_id: string;
  balance: string;
  available_balance: string;
  reserved_funds: string;
}

/** The database package's Kysely client type. */
export type KyselyDatabase = Kysely<DatabaseSchema>;

/** A Kysely context pinned to one PostgreSQL transaction connection. */
export type DatabaseTransaction = Transaction<DatabaseSchema>;
