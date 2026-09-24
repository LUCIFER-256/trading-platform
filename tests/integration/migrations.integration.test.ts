import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { sql } from "kysely";
import {
  createDatabaseClient,
  DatabaseMigrationError,
  runPendingMigrations,
  type DatabaseClient,
  type DatabaseEnvironment
} from "../../packages/database/src";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function log(step: string): void {
  console.error(`[CHECKPOINT] ${step}`);
}

function testEnvironment(): DatabaseEnvironment {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (testDatabaseUrl === undefined || testDatabaseUrl.trim() === "") {
    throw new Error("TEST_DATABASE_URL is required for the migration integration test.");
  }
  return {
    TEST_DATABASE_URL: testDatabaseUrl,
    DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE,
    DATABASE_SSL_CA_PATH: process.env.DATABASE_SSL_CA_PATH
  };
}

function createClient(environment: DatabaseEnvironment): DatabaseClient {
  return createDatabaseClient({ runtimeMode: "test", environment });
}

async function assertRelationExists(client: DatabaseClient, name: string, expected: boolean): Promise<void> {
  const result = await sql<{ readonly relation: string | null }>`select to_regclass(${name}) as relation`.execute(client.database);
  assert((result.rows[0]?.relation !== null) === expected, `${name} existence did not match expectation.`);
}

async function assertSchemaExists(client: DatabaseClient, name: string, expected: boolean): Promise<void> {
  const result = await sql<{ readonly exists: boolean }>`select exists(select 1 from information_schema.schemata where schema_name = ${name}) as exists`.execute(client.database);
  assert(result.rows[0]?.exists === expected, `${name} schema existence did not match expectation.`);
}

async function assertRejected(action: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

function assertUuidV7(value: string, message: string): void {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value), message);
}

async function assertCatalogSchema(client: DatabaseClient): Promise<void> {
  const tables = ["platform.markets", "platform.providers", "platform.instruments", "platform.provider_instrument_symbols"];
  for (const table of tables) await assertRelationExists(client, table, true);

  const constraintResult = await sql<{ readonly conname: string; readonly confdeltype: string | null }>`
    select constraint_data.conname, constraint_data.confdeltype
    from (
      select constraint_entry.conname, constraint_entry.confdeltype
      from pg_constraint as constraint_entry
      join pg_class as relation on relation.oid = constraint_entry.conrelid
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'platform'
    ) as constraint_data
  `.execute(client.database);
  const constraints = new Map(constraintResult.rows.map((row) => [row.conname, row.confdeltype]));
  const expectedConstraints = [
    "markets_pkey",
    "markets_market_code_key",
    "markets_market_code_format_check",
    "providers_pkey",
    "providers_provider_code_key",
    "providers_provider_code_format_check",
    "instruments_pkey",
    "instruments_market_id_instrument_code_key",
    "instruments_instrument_code_format_check",
    "instruments_market_id_fkey",
    "provider_instrument_symbols_pkey",
    "provider_instrument_symbols_provider_id_instrument_id_key",
    "provider_instrument_symbols_provider_id_provider_symbol_key",
    "provider_instrument_symbols_provider_id_fkey",
    "provider_instrument_symbols_instrument_id_fkey"
  ];
  for (const name of expectedConstraints) assert(constraints.has(name), `Missing catalog constraint: ${name}`);
  for (const name of [
    "instruments_market_id_fkey",
    "provider_instrument_symbols_provider_id_fkey",
    "provider_instrument_symbols_instrument_id_fkey"
  ]) {
    assert(constraints.get(name) === "r", `${name} must use ON DELETE RESTRICT.`);
  }

  const indexResult = await sql<{ readonly indexname: string }>`
    select indexname from pg_indexes where schemaname = 'platform'
  `.execute(client.database);
  const indexes = new Set(indexResult.rows.map((row) => row.indexname));
  for (const name of [
    "markets_enabled_lookup_idx",
    "instruments_market_enabled_lookup_idx",
    "provider_instrument_symbols_provider_enabled_lookup_idx",
    "provider_instrument_symbols_instrument_enabled_lookup_idx"
  ]) {
    assert(indexes.has(name), `Missing catalog lookup index: ${name}`);
  }

  const columnResult = await sql<{ readonly table_name: string; readonly column_name: string; readonly data_type: string; readonly is_nullable: string; readonly column_default: string | null; readonly collation_name: string | null }>`
    select table_name, column_name, data_type, is_nullable, column_default, collation_name
    from information_schema.columns
    where table_schema = 'platform'
  `.execute(client.database);
  const columns = new Map(columnResult.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  for (const name of ["markets", "providers", "instruments", "provider_instrument_symbols"]) {
    const id = columns.get(`${name}.id`);
    assert(
      id?.data_type === "uuid" && id.is_nullable === "NO" && id.column_default?.includes("uuidv7"),
      `${name}.id must be database-generated UUIDv7.`
    );
  }
  for (const name of ["markets", "instruments", "provider_instrument_symbols"]) {
    const enabled = columns.get(`${name}.enabled`);
    assert(enabled?.data_type === "boolean" && enabled.is_nullable === "NO", `${name}.enabled must be a non-null boolean.`);
  }
  for (const name of ["markets", "providers", "instruments", "provider_instrument_symbols"]) {
    for (const timestamp of ["created_at", "updated_at"]) {
      const column = columns.get(`${name}.${timestamp}`);
      assert(
        column?.data_type === "timestamp with time zone" && column.is_nullable === "NO" && column.column_default !== null,
        `${name}.${timestamp} must be a non-null UTC timestamp with a default.`
      );
    }
  }
  assert(columns.get("provider_instrument_symbols.provider_symbol")?.collation_name === "C", "Provider symbols must use C collation.");

  const triggerResult = await sql<{ readonly tgname: string }>`
    select trigger_entry.tgname
    from pg_trigger as trigger_entry
    join pg_class as relation on relation.oid = trigger_entry.tgrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'platform' and not trigger_entry.tgisinternal
  `.execute(client.database);
  const triggers = new Set(triggerResult.rows.map((row) => row.tgname));
  for (const name of [
    "markets_set_updated_at",
    "providers_set_updated_at",
    "instruments_set_updated_at",
    "provider_instrument_symbols_set_updated_at"
  ]) {
    assert(triggers.has(name), `Missing catalog updated-at trigger: ${name}`);
  }
}

async function assertCatalogConstraints(client: DatabaseClient): Promise<void> {
  const market = await sql<{ readonly id: string }>`
    insert into platform.markets (market_code, enabled) values ('test-market', true) returning id
  `.execute(client.database);
  const marketId = market.rows[0]?.id;
  assert(marketId !== undefined, "Market fixture must be created.");
  assertUuidV7(marketId, "Market fixture must receive a UUIDv7 primary key.");
  const primaryInstrument = await sql<{ readonly id: string }>`
    insert into platform.instruments (market_id, instrument_code, enabled) values (${marketId}, 'test-instrument', true) returning id
  `.execute(client.database);
  const primaryInstrumentId = primaryInstrument.rows[0]?.id;
  assert(primaryInstrumentId !== undefined, "Primary instrument fixture must be created.");
  const secondaryInstrument = await sql<{ readonly id: string }>`
    insert into platform.instruments (market_id, instrument_code, enabled) values (${marketId}, 'test-instrument-alt', true) returning id
  `.execute(client.database);
  const secondaryInstrumentId = secondaryInstrument.rows[0]?.id;
  assert(secondaryInstrumentId !== undefined, "Secondary instrument fixture must be created.");
  const thirdInstrument = await sql<{ readonly id: string }>`
    insert into platform.instruments (market_id, instrument_code, enabled) values (${marketId}, 'test-instrument-third', true) returning id
  `.execute(client.database);
  const thirdInstrumentId = thirdInstrument.rows[0]?.id;
  assert(thirdInstrumentId !== undefined, "Third instrument fixture must be created.");
  const provider = await sql<{ readonly id: string }>`
    insert into platform.providers (provider_code) values ('test-provider') returning id
  `.execute(client.database);
  const providerId = provider.rows[0]?.id;
  assert(providerId !== undefined, "Provider fixture must be created.");
  assertUuidV7(providerId, "Provider fixture must receive a UUIDv7 primary key.");

  const updatedMarket = await sql<{ readonly updated_at: Date }>`
    update platform.markets set updated_at = timestamp '2000-01-01 00:00:00+00' where id = ${marketId} returning updated_at
  `.execute(client.database);
  const updatedAt = updatedMarket.rows[0]?.updated_at;
  assert(
    updatedAt !== undefined && updatedAt.getUTCFullYear() !== 2000,
    "The market updated_at trigger must replace an application-supplied stale timestamp."
  );

  await sql`
    insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol, enabled)
    values (${providerId}, ${primaryInstrumentId}, 'TEST-SYMBOL', true)
  `.execute(client.database);
  await sql`
    insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol, enabled)
    values (${providerId}, ${secondaryInstrumentId}, 'test-symbol', true)
  `.execute(client.database);

  await assertRejected(
    () => sql`insert into platform.instruments (market_id, instrument_code) values ('00000000-0000-7000-8000-000000000001', 'missing-market')`.execute(client.database),
    "An instrument with a missing market must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol) values ('00000000-0000-7000-8000-000000000002', ${primaryInstrumentId}, 'missing-provider')`.execute(client.database),
    "A mapping with a missing provider must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol) values (${providerId}, '00000000-0000-7000-8000-000000000003', 'missing-instrument')`.execute(client.database),
    "A mapping with a missing instrument must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.instruments (market_id, instrument_code) values (${marketId}, 'test-instrument')`.execute(client.database),
    "A duplicate instrument identity must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol) values (${providerId}, ${thirdInstrumentId}, 'TEST-SYMBOL')`.execute(client.database),
    "A duplicate provider symbol must be rejected by PostgreSQL."
  );
  await assertRejected(
    () => sql`insert into platform.provider_instrument_symbols (provider_id, instrument_id, provider_symbol) values (${providerId}, ${primaryInstrumentId}, 'another-symbol')`.execute(client.database),
    "A duplicate provider/instrument mapping must be rejected by PostgreSQL."
  );
}

interface LedgerPostingInput {
  readonly eventType: "deposit" | "withdrawal" | "manual_adjustment";
  readonly walletId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly customerEntrySide: "debit" | "credit";
  readonly idempotencyKey: string;
  readonly actorReference: string;
  readonly reason: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

async function postLedgerTransaction(client: DatabaseClient, input: LedgerPostingInput): Promise<string> {
  const result = await sql<{ readonly id: string }>`
    select platform.post_ledger_transaction(
      ${input.eventType}, ${input.walletId}, ${input.assetId}, ${input.amount}, ${input.customerEntrySide},
      ${input.idempotencyKey}, ${input.actorReference}, ${input.reason}, cast(${JSON.stringify(input.metadata)} as jsonb), ${input.occurredAt}
    ) as id
  `.execute(client.database);
  const id = result.rows[0]?.id;
  assert(id !== undefined, "Ledger posting must return a transaction identifier.");
  return id;
}

async function assertPhase3Schema(client: DatabaseClient): Promise<void> {
  const tables = [
    "platform.users", "platform.accounts", "platform.strategies", "platform.strategy_configurations",
    "platform.risk_configurations", "platform.broker_connections", "platform.assets", "platform.wallets",
    "platform.ledger_accounts", "platform.ledger_transactions", "platform.ledger_entries", "platform.wallet_balances"
  ];
  for (const table of tables) await assertRelationExists(client, table, true);

  const columns = await sql<{ readonly table_name: string; readonly column_name: string; readonly data_type: string; readonly column_default: string | null }>`
    select table_name, column_name, data_type, column_default
    from information_schema.columns where table_schema = 'platform'
  `.execute(client.database);
  const byColumn = new Map(columns.rows.map((column) => [`${column.table_name}.${column.column_name}`, column]));
  for (const table of [
    "users", "accounts", "strategies", "strategy_configurations", "risk_configurations", "broker_connections",
    "assets", "wallets", "ledger_accounts", "ledger_transactions", "ledger_entries"
  ]) {
    const id = byColumn.get(`${table}.id`);
    assert(id?.data_type === "uuid" && id.column_default?.includes("uuidv7"), `${table}.id must use uuidv7().`);
  }
  for (const table of ["users", "accounts", "strategies", "strategy_configurations", "risk_configurations", "broker_connections", "assets", "wallets", "ledger_accounts"]) {
    assert(byColumn.get(`${table}.enabled`)?.data_type === "boolean", `${table}.enabled must be a boolean lifecycle flag.`);
  }
  for (const table of ["ledger_transactions", "ledger_entries"]) {
    assert(byColumn.get(`${table}.amount`)?.data_type === "numeric", `${table}.amount must use exact NUMERIC.`);
  }

  const foreignKeys = await sql<{ readonly conname: string; readonly confdeltype: string }>`
    select constraint_entry.conname, constraint_entry.confdeltype
    from pg_constraint as constraint_entry
    join pg_class as relation on relation.oid = constraint_entry.conrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'platform' and constraint_entry.contype = 'f'
  `.execute(client.database);
  const deleteActions = new Map(foreignKeys.rows.map((row) => [row.conname, row.confdeltype]));
  for (const name of [
    "accounts_user_id_fkey", "strategies_user_id_fkey", "strategy_configurations_strategy_id_fkey",
    "risk_configurations_account_id_fkey", "broker_connections_account_id_fkey", "broker_connections_provider_id_fkey",
    "wallets_account_id_fkey", "wallets_asset_id_fkey", "ledger_accounts_asset_id_fkey", "ledger_accounts_account_id_fkey",
    "ledger_accounts_wallet_id_fkey", "ledger_transactions_asset_id_fkey", "ledger_transactions_wallet_id_fkey",
    "ledger_transactions_customer_ledger_account_id_fkey", "ledger_transactions_counterparty_ledger_account_id_fkey",
    "ledger_entries_transaction_id_fkey", "ledger_entries_ledger_account_id_fkey"
  ]) {
    assert(deleteActions.get(name) === "r", `${name} must use ON DELETE RESTRICT.`);
  }
}

async function assertFinancialCore(client: DatabaseClient, environment: DatabaseEnvironment, nonce: string): Promise<void> {
  const codeNonce = nonce.replace("_", "-");
  const user = await sql<{ readonly id: string }>`insert into platform.users (user_code, enabled) values (${`ledger-user-${codeNonce}`}, true) returning id`.execute(client.database);
  const userId = user.rows[0]?.id;
  assert(userId !== undefined, "User fixture must be created.");
  const account = await sql<{ readonly id: string }>`insert into platform.accounts (user_id, account_code, enabled) values (${userId}, ${`ledger-account-${codeNonce}`}, true) returning id`.execute(client.database);
  const accountId = account.rows[0]?.id;
  assert(accountId !== undefined, "Account fixture must be created.");
  const strategy = await sql<{ readonly id: string }>`insert into platform.strategies (user_id, strategy_code, enabled) values (${userId}, ${`ledger-strategy-${codeNonce}`}, true) returning id`.execute(client.database);
  const strategyId = strategy.rows[0]?.id;
  assert(strategyId !== undefined, "Strategy fixture must be created.");
  await sql`insert into platform.strategy_configurations (strategy_id, version, configuration, enabled) values (${strategyId}, 1, '{"window": 20}'::jsonb, true)`.execute(client.database);
  await sql`insert into platform.risk_configurations (account_id, version, configuration, enabled) values (${accountId}, 1, '{"maxLoss": "1"}'::jsonb, true)`.execute(client.database);
  const provider = await sql<{ readonly id: string }>`insert into platform.providers (provider_code) values (${`ledger-provider-${codeNonce}`}) returning id`.execute(client.database);
  const providerId = provider.rows[0]?.id;
  assert(providerId !== undefined, "Provider fixture must be created.");
  await sql`insert into platform.broker_connections (account_id, provider_id, connection_code, enabled) values (${accountId}, ${providerId}, 'ledger-connection', true)`.execute(client.database);
  await assertRejected(
    () => sql`insert into platform.strategy_configurations (strategy_id, version, configuration) values (${strategyId}, 1, '{}'::jsonb)`.execute(client.database),
    "Strategy configuration versions must be unique per strategy."
  );
  await assertRejected(
    () => sql`insert into platform.risk_configurations (account_id, version, configuration) values (${accountId}, 2, '[]'::jsonb)`.execute(client.database),
    "Configuration payloads must be JSON objects."
  );
  await assertRejected(
    () => sql`update platform.strategy_configurations set configuration = '{"window": 21}'::jsonb where strategy_id = ${strategyId} and version = 1`.execute(client.database),
    "Strategy configuration revisions must reject content updates."
  );
  await assertRejected(
    () => sql`delete from platform.risk_configurations where account_id = ${accountId} and version = 1`.execute(client.database),
    "Risk configuration revisions must reject deletion."
  );
  await assertRejected(
    () => sql`insert into platform.broker_connections (account_id, provider_id, connection_code) values (${accountId}, '00000000-0000-7000-8000-000000000004', 'missing-provider')`.execute(client.database),
    "Broker connections must reject missing providers."
  );
  const asset = await sql<{ readonly id: string }>`insert into platform.assets (asset_code, asset_kind, enabled) values (${`usd-${codeNonce}`}, 'fiat', true) returning id`.execute(client.database);
  const assetId = asset.rows[0]?.id;
  assert(assetId !== undefined, "Enabled asset fixture must be created.");
  assertUuidV7(assetId, "Asset fixture must receive a UUIDv7 primary key.");
  const wallet = await sql<{ readonly id: string }>`insert into platform.wallets (account_id, asset_id, enabled) values (${accountId}, ${assetId}, true) returning id`.execute(client.database);
  const walletId = wallet.rows[0]?.id;
  assert(walletId !== undefined, "Wallet fixture must be created.");

  const clearing = await sql<{ readonly account_code: string; readonly enabled: boolean }>`
    select account_code, enabled from platform.ledger_accounts
    where asset_id = ${assetId} and account_code in ('external_deposit_clearing', 'external_withdrawal_clearing', 'manual_adjustment_clearing')
    order by account_code
  `.execute(client.database);
  assert(clearing.rows.length === 3 && clearing.rows.every((row) => row.enabled), "Enabling an asset must create all three enabled clearing accounts.");
  const customerLedgerAccount = await sql<{ readonly id: string }>`
    select id from platform.ledger_accounts where wallet_id = ${walletId} and account_code = 'customer_wallet'
  `.execute(client.database);
  const customerLedgerAccountId = customerLedgerAccount.rows[0]?.id;
  assert(customerLedgerAccountId !== undefined, "Creating a wallet must create its customer ledger account.");

  const secondAsset = await sql<{ readonly id: string }>`insert into platform.assets (asset_code, asset_kind, enabled) values (${`eur-${codeNonce}`}, 'fiat', false) returning id`.execute(client.database);
  const secondAssetId = secondAsset.rows[0]?.id;
  assert(secondAssetId !== undefined, "Second asset fixture must be created.");
  const disabledClearing = await sql<{ readonly count: string }>`
    select count(*)::text as count from platform.ledger_accounts
    where asset_id = ${secondAssetId} and account_code in ('external_deposit_clearing', 'external_withdrawal_clearing', 'manual_adjustment_clearing')
  `.execute(client.database);
  assert(disabledClearing.rows[0]?.count === "0", "A disabled asset must not receive clearing accounts before it is enabled.");
  await sql`update platform.assets set enabled = true where id = ${secondAssetId}`.execute(client.database);
  const enabledClearing = await sql<{ readonly count: string }>`
    select count(*)::text as count from platform.ledger_accounts
    where asset_id = ${secondAssetId} and account_code in ('external_deposit_clearing', 'external_withdrawal_clearing', 'manual_adjustment_clearing') and enabled
  `.execute(client.database);
  assert(enabledClearing.rows[0]?.count === "3", "Enabling an asset must create all clearing accounts.");

  await assertRejected(
    () => sql`insert into platform.users (user_code) values ('INVALID_CODE')`.execute(client.database),
    "Normalized user-code checks must reject uppercase values."
  );
  await assertRejected(
    () => sql`insert into platform.wallets (account_id, asset_id) values (${accountId}, ${assetId})`.execute(client.database),
    "An account may have only one wallet per asset."
  );
  await assertRejected(
    () => sql`delete from platform.assets where id = ${assetId}`.execute(client.database),
    "Referenced assets must reject deletion."
  );

  const occurredAt = new Date("2026-09-24T09:00:00.000Z");
  const deposit: LedgerPostingInput = {
    eventType: "deposit", walletId, assetId, amount: "10", customerEntrySide: "credit",
    idempotencyKey: `deposit-${nonce}`, actorReference: "phase3-integration", reason: null, metadata: { source: "fixture" }, occurredAt
  };
  const depositId = await postLedgerTransaction(client, deposit);
  assertUuidV7(depositId, "Ledger transaction must receive a UUIDv7 primary key.");
  const identicalRetryId = await postLedgerTransaction(client, { ...deposit, amount: "10.000000000000000000" });
  assert(identicalRetryId === depositId, "An identical canonicalized retry must return the original transaction.");
  await assertRejected(
    () => postLedgerTransaction(client, { ...deposit, amount: "11" }),
    "A same-key retry with different data must be rejected as an idempotency conflict."
  );
  const depositEntryState = await sql<{ readonly count: string; readonly total: string }>`
    select count(*)::text as count, coalesce(sum(case entry_side when 'credit' then amount else -amount end), 0)::text as total
    from platform.ledger_entries where ledger_transaction_id = ${depositId}
  `.execute(client.database);
  assert(depositEntryState.rows[0]?.count === "2" && depositEntryState.rows[0]?.total === "0.000000000000000000", "A deposit must create two balanced entries.");

  const withdrawalId = await postLedgerTransaction(client, {
    ...deposit, eventType: "withdrawal", amount: "4", customerEntrySide: "debit", idempotencyKey: `withdrawal-${nonce}`
  });
  const adjustmentId = await postLedgerTransaction(client, {
    ...deposit, eventType: "manual_adjustment", amount: "2", customerEntrySide: "credit", idempotencyKey: `adjustment-${nonce}`,
    reason: "integration correction"
  });
  for (const transactionId of [withdrawalId, adjustmentId]) {
    const state = await sql<{ readonly count: string; readonly total: string }>`
      select count(*)::text as count, coalesce(sum(case entry_side when 'credit' then amount else -amount end), 0)::text as total
      from platform.ledger_entries where ledger_transaction_id = ${transactionId}
    `.execute(client.database);
    assert(state.rows[0]?.count === "2" && state.rows[0]?.total === "0.000000000000000000", "Each valid ledger event must create balanced entries.");
  }

  const balance = await sql<{ readonly balance: string; readonly available_balance: string; readonly reserved_funds: string }>`
    select balance::text, available_balance::text, reserved_funds::text from platform.wallet_balances where wallet_id = ${walletId}
  `.execute(client.database);
  assert(
    balance.rows[0]?.balance === "8.000000000000000000" && balance.rows[0]?.available_balance === "8.000000000000000000" && balance.rows[0]?.reserved_funds === "0.000000000000000000",
    "Wallet balance must be derived exactly from committed entries."
  );

  await assertRejected(
    () => postLedgerTransaction(client, { ...deposit, idempotencyKey: `cross-asset-${nonce}`, assetId: secondAssetId }),
    "A wallet posting with a different asset must be rejected."
  );
  await assertRejected(
    () => postLedgerTransaction(client, { ...deposit, idempotencyKey: `overdraw-${nonce}`, eventType: "withdrawal", amount: "9", customerEntrySide: "debit" }),
    "An insufficient-funds withdrawal must be rejected."
  );
  const failedPostings = await sql<{ readonly count: string }>`
    select count(*)::text as count from platform.ledger_transactions where idempotency_key in (${`cross-asset-${nonce}`}, ${`overdraw-${nonce}`})
  `.execute(client.database);
  assert(failedPostings.rows[0]?.count === "0", "Rejected postings must leave no partial transaction rows.");

  await assertRejected(
    () => sql`update platform.ledger_transactions set actor_reference = 'mutated' where id = ${depositId}`.execute(client.database),
    "Ledger transaction updates must be rejected."
  );
  await assertRejected(
    () => sql`delete from platform.ledger_entries where ledger_transaction_id = ${depositId}`.execute(client.database),
    "Ledger entry deletes must be rejected."
  );
  await assertRejected(
    () => client.withinTransaction(async (database) => {
      await sql`select set_config('platform.ledger_posting', 'on', true)`.execute(database);
      const header = await sql<{ readonly id: string }>`
        insert into platform.ledger_transactions (
          event_type, asset_id, wallet_id, customer_ledger_account_id, counterparty_ledger_account_id,
          customer_entry_side, amount, idempotency_key, actor_reference, reason, metadata, occurred_at
        )
        select 'deposit', ${assetId}, ${walletId}, ${customerLedgerAccountId}, id, 'credit', 1, ${`unbalanced-${nonce}`}, 'fixture', null, '{}'::jsonb, ${occurredAt}
        from platform.ledger_accounts where asset_id = ${assetId} and account_code = 'external_deposit_clearing'
        returning id
      `.execute(database);
      const headerId = header.rows[0]?.id;
      assert(headerId !== undefined, "Unbalanced fixture header must be inserted before deferred verification.");
      await sql`insert into platform.ledger_entries (ledger_transaction_id, ledger_account_id, entry_side, amount) values (${headerId}, ${customerLedgerAccountId}, 'credit', 1)`.execute(database);
    }),
    "An unbalanced ledger transaction must be rejected at transaction commit."
  );
  const unbalancedCount = await sql<{ readonly count: string }>`select count(*)::text as count from platform.ledger_transactions where idempotency_key = ${`unbalanced-${nonce}`}`.execute(client.database);
  assert(unbalancedCount.rows[0]?.count === "0", "A failed balanced-invariant check must roll back its header and entries.");

  const firstConcurrent = createClient(environment);
  const secondConcurrent = createClient(environment);
  try {
    await Promise.all([
      postLedgerTransaction(firstConcurrent, { ...deposit, amount: "3", idempotencyKey: `concurrent-deposit-a-${nonce}` }),
      postLedgerTransaction(secondConcurrent, { ...deposit, amount: "4", idempotencyKey: `concurrent-deposit-b-${nonce}` })
    ]);
    const afterConcurrentDeposits = await sql<{ readonly balance: string }>`select balance::text as balance from platform.wallet_balances where wallet_id = ${walletId}`.execute(client.database);
    assert(afterConcurrentDeposits.rows[0]?.balance === "15.000000000000000000", "Concurrent distinct postings must not lose a balance change.");

    const withdrawalResults = await Promise.allSettled([
      postLedgerTransaction(firstConcurrent, { ...deposit, eventType: "withdrawal", amount: "10", customerEntrySide: "debit", idempotencyKey: `concurrent-withdrawal-a-${nonce}` }),
      postLedgerTransaction(secondConcurrent, { ...deposit, eventType: "withdrawal", amount: "10", customerEntrySide: "debit", idempotencyKey: `concurrent-withdrawal-b-${nonce}` })
    ]);
    assert(withdrawalResults.filter((result) => result.status === "fulfilled").length === 1, "Concurrent withdrawals must permit only one non-overdrawing debit.");
    const afterConcurrentWithdrawals = await sql<{ readonly balance: string }>`select balance::text as balance from platform.wallet_balances where wallet_id = ${walletId}`.execute(client.database);
    assert(afterConcurrentWithdrawals.rows[0]?.balance === "5.000000000000000000", "Concurrent withdrawals must leave the exact non-negative derived balance.");

    const duplicateResults = await Promise.all([
      postLedgerTransaction(firstConcurrent, { ...deposit, amount: "1", idempotencyKey: `concurrent-duplicate-${nonce}` }),
      postLedgerTransaction(secondConcurrent, { ...deposit, amount: "1.0", idempotencyKey: `concurrent-duplicate-${nonce}` })
    ]);
    assert(duplicateResults[0] === duplicateResults[1], "Concurrent identical idempotency retries must return one transaction.");
  } finally {
    await firstConcurrent.close();
    await secondConcurrent.close();
  }
}

async function main(): Promise<void> {
  log("start");
  const environment = testEnvironment();
  log("environment resolved");
  const nonce = `${process.pid}_${Date.now()}`;
  const migrationDirectory = path.join(__dirname, "../../packages/database/src/migrations");
  const mainClient = createClient(environment);
  log("mainClient created");

  try {
    await mainClient.checkHealth();
    log("checkHealth OK");
    await sql`drop schema if exists platform cascade`.execute(mainClient.database);
    log("drop schema OK");

    const firstRun = await runPendingMigrations(mainClient, {
      migrationFolder: migrationDirectory,
      migrationTableName: `migration_it_main_${nonce}`,
      migrationLockTableName: `migration_it_main_lock_${nonce}`
    });
    log(`firstRun applied=${firstRun.applied.length}`);
    assert(firstRun.applied.length === 5, "A fresh database must apply all platform migrations.");
    await assertSchemaExists(mainClient, "platform", true);
    log("schema exists OK");
    await assertCatalogSchema(mainClient);
    log("catalog schema verified");
    await assertCatalogConstraints(mainClient);
    log("catalog constraints verified");
    await assertPhase3Schema(mainClient);
    log("Phase 3 schema verified");
    await assertFinancialCore(mainClient, environment, nonce);
    log("Phase 3 financial core verified");

    const secondRun = await runPendingMigrations(mainClient, {
      migrationFolder: migrationDirectory,
      migrationTableName: `migration_it_main_${nonce}`,
      migrationLockTableName: `migration_it_main_lock_${nonce}`
    });
    log(`secondRun applied=${secondRun.applied.length}`);
    assert(secondRun.applied.length === 0, "A second migration run must have no pending migrations.");

    const atomicDirectory = await mkdtemp(path.join(__dirname, "trading-migrations-atomic-"));
    log("atomicDirectory created");
    try {
      await writeFile(
        path.join(atomicDirectory, "20260923090001_atomicity_probe.js"),
        "exports.up = async (db) => { await db.schema.createTable('platform.atomicity_probe').addColumn('id', 'integer').execute(); throw new Error('intentional migration failure'); };\n"
      );
      log("atomic probe files written");
      let atomicFailure: unknown;
      try {
        await runPendingMigrations(mainClient, {
          migrationFolder: atomicDirectory,
          migrationTableName: `migration_it_atomic_${nonce}`,
          migrationLockTableName: `migration_it_atomic_lock_${nonce}`
        });
      } catch (error) {
        atomicFailure = error;
      }
      log("atomic run resolved");
      assert(atomicFailure instanceof DatabaseMigrationError, "A failing migration must return a safe migration error.");
      await assertRelationExists(mainClient, "platform.atomicity_probe", false);
      log("atomic rollback verified");
    } finally {
      await rm(atomicDirectory, { recursive: true, force: true });
    }

    const concurrentDirectory = await mkdtemp(path.join(__dirname, "trading-migrations-lock-"));
    log("concurrentDirectory created");
    try {
      const concurrentOptions = {
        migrationFolder: concurrentDirectory,
        migrationTableName: `migration_it_lock_${nonce}`,
        migrationLockTableName: `migration_it_lock_lock_${nonce}`
      };
      await runPendingMigrations(mainClient, concurrentOptions);
      log("pre-concurrent run OK");
      await writeFile(
        path.join(concurrentDirectory, "20260923090002_lock_probe.js"),
        "exports.up = async (db) => { await new Promise((r) => setTimeout(r, 200)); await db.schema.createTable('platform.lock_probe').addColumn('id', 'integer').execute(); };\n"
      );
      const concurrentClient = createClient(environment);
      log("concurrentClient created, entering Promise.all");
      try {
        const [firstConcurrent, secondConcurrent] = await Promise.all([
          runPendingMigrations(mainClient, { ...concurrentOptions}),
          runPendingMigrations(concurrentClient, { ...concurrentOptions})
        ]);
        log(`Promise.all resolved: first=${firstConcurrent.applied.length} second=${secondConcurrent.applied.length}`);
        assert(
          firstConcurrent.applied.length + secondConcurrent.applied.length === 1,
          "The Kysely migration lock must permit exactly one concurrent application."
        );
        await assertRelationExists(mainClient, "platform.lock_probe", true);
        log("lock probe verified");
      } finally {
        await concurrentClient.close();
      }
    } finally {
      await rm(concurrentDirectory, { recursive: true, force: true });
    }
  } finally {
    log("closing mainClient");
    await mainClient.close();
  }

  console.log("Migration integration tests passed.");
}

void main().catch((error: unknown) => {
  console.error("[CHECKPOINT] main() rejected:", error);
  throw error;
});
