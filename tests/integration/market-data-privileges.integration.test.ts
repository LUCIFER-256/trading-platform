import * as path from "node:path";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createDatabaseClient, runPendingMigrations, sql, type DatabaseClient, type DatabaseEnvironment } from "../../packages/database/src";
import { createTestPasswordHasher } from "../../apps/api/src/auth";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejected(action: () => Promise<unknown>, state: string, message: string): Promise<void> {
  try { await action(); } catch (error) { const value = error as { code?: string; message?: string }; assert(value.code === state, `${message}: expected ${state}; received ${String(value.code)} ${String(value.message)}.`); return; }
  throw new Error(`${message}: no error was raised; expected ${state}.`);
}
function environment(): DatabaseEnvironment { if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required."); return { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE }; }
interface Fixture { providerId: string; instrumentId: string; userId: string; sessionId: string; secret: string; }

async function fixture(client: DatabaseClient, suffix: string): Promise<Fixture> {
  const market = await sql<{ id: string }>`insert into platform.markets(market_code,enabled) values (${`priv-market-${suffix}`},true) returning id`.execute(client.database);
  const provider = await sql<{ id: string }>`insert into platform.providers(provider_code,enabled) values (${`priv-provider-${suffix}`},true) returning id`.execute(client.database);
  const instrument = await sql<{ id: string }>`insert into platform.instruments(market_id,instrument_code,enabled,price_increment,size_increment) values (${market.rows[0]!.id},${`priv-instrument-${suffix}`},true,0.01,0.00000001) returning id`.execute(client.database);
  await sql`insert into platform.provider_instrument_symbols(provider_id,instrument_id,provider_symbol,enabled) values (${provider.rows[0]!.id},${instrument.rows[0]!.id},'PRIV-USD',true)`.execute(client.database);
  await sql`insert into platform.market_data_policies(instrument_id,enabled) values (${instrument.rows[0]!.id},true)`.execute(client.database);
  const user = await sql<{ id: string }>`insert into platform.users(user_code,enabled) values (${`priv-user-${suffix}`},true) returning id`.execute(client.database);
  const hash = await createTestPasswordHasher().hash("integration-password");
  await sql`insert into platform.password_credentials(user_id,password_hash,credential_version) values (${user.rows[0]!.id},${hash},1)`.execute(client.database);
  await sql`insert into platform.account_role_assignments(user_id,account_id,role,enabled) values (${user.rows[0]!.id},null,'SUPER_ADMIN',true)`.execute(client.database);
  const secret = `privilege-${suffix}-session-secret-sufficiently-long`;
  const session = await sql<{ id: string }>`select platform.create_auth_session(${user.rows[0]!.id},${secret},1,clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '8 hours') id`.execute(client.database);
  return { providerId: provider.rows[0]!.id, instrumentId: instrument.rows[0]!.id, userId: user.rows[0]!.id, sessionId: session.rows[0]!.id, secret };
}

async function asRole(client: DatabaseClient, role: string, action: (database: DatabaseClient["database"]) => Promise<void>): Promise<void> {
  await client.database.transaction().execute(async (database) => { await sql.raw(`set local role ${role}`).execute(database); await action(database); });
}
async function asRoleRejected(client: DatabaseClient, role: string, action: (database: DatabaseClient["database"]) => Promise<unknown>, state: string, message: string): Promise<void> {
  await client.database.transaction().execute(async (database) => {
    await sql.raw(`set local role ${role}`).execute(database);
    await sql.raw("savepoint rejected_attempt").execute(database);
    try { await action(database); throw new Error(`${message}: no error was raised; expected ${state}.`); }
    catch (error) {
      if (error instanceof Error && error.message === `${message}: no error was raised; expected ${state}.`) throw error;
      const value = error as { code?: string; message?: string };
      assert(value.code === state, `${message}: expected ${state}; received ${String(value.code)} ${String(value.message)}.`);
      await sql.raw("rollback to savepoint rejected_attempt").execute(database);
    }
  });
}
async function append(database: DatabaseClient["database"], data: Fixture, trade = "1"): Promise<void> {
  await sql`select * from platform.append_market_data_observation(${data.providerId},${data.instrumentId},'PRIV-USD',${trade},${trade},1760698800123456,timestamptz '2025-10-17 11:00:00.123456+00',timestamptz '2025-10-17 11:00:01+00',99,1,101,1,100,1,0)`.execute(database);
}

async function privilegeSnapshot(client: DatabaseClient): Promise<void> {
  const roles = ["platform_owner", "platform_market_data", "platform_market_data_operator", "platform_catalog_provisioner", "platform_market_data_consumer", "platform_runtime"] as const;
  const catalog: Record<string, readonly string[]> = { markets: ["id", "market_code", "enabled"], providers: ["id", "provider_code", "enabled"], instruments: ["id", "market_id", "instrument_code", "enabled", "price_increment", "size_increment"], provider_instrument_symbols: ["provider_id", "instrument_id", "provider_symbol", "enabled"] };
  const expected: Record<string, Readonly<Record<string, readonly string[]>>> = {
    platform_owner: { markets: ["id", "market_code", "enabled"], providers: ["id", "enabled", "provider_code"], instruments: ["id", "market_id", "instrument_code", "enabled", "price_increment", "size_increment"], provider_instrument_symbols: ["provider_id", "instrument_id", "provider_symbol", "enabled"] },
    platform_market_data: { markets: ["id", "enabled"], providers: ["id", "enabled"], instruments: ["id", "market_id", "enabled", "price_increment", "size_increment"], provider_instrument_symbols: ["provider_id", "instrument_id", "provider_symbol", "enabled"] },
    platform_market_data_operator: {}, platform_catalog_provisioner: {}, platform_market_data_consumer: {}, platform_runtime: {}
  };
  for (const role of roles) for (const [table, columns] of Object.entries(catalog)) for (const column of columns) {
    const actual = await sql<{ allowed: boolean }>`select has_column_privilege(${role},${`platform.${table}`},${column},'select') allowed`.execute(client.database);
    assert(actual.rows[0]?.allowed === (expected[role]?.[table]?.includes(column) ?? false), `${role} SELECT ${table}.${column} must match the literal grant snapshot.`);
  }
}
async function writerCanAppendOnlyThroughFunctions(client: DatabaseClient, data: Fixture): Promise<void> { await asRole(client, "platform_market_data", (database) => append(database, data)); await asRoleRejected(client, "platform_market_data", (database) => sql`insert into platform.market_data_observations(provider_id,instrument_id,provider_symbol,provider_sequence,trade_id,event_at_us,event_at,received_at,bid_as_of_last_trade,bid_size_as_of_last_trade,ask_as_of_last_trade,ask_size_as_of_last_trade,last_trade_price,last_trade_size) values (${data.providerId},${data.instrumentId},'PRIV-USD',2,2,0,timestamptz '1970-01-01',clock_timestamp(),1,1,1,1,1,1)`.execute(database), "42501", "writer direct observation insert"); }
async function writerCannotClear(client: DatabaseClient, data: Fixture): Promise<void> { await asRole(client, "platform_market_data", (database) => append(database, data, "20")); await asRoleRejected(client, "platform_market_data", (database) => sql`select * from platform.clear_market_data_halt(${data.sessionId},${data.secret},'00000000-0000-7000-8000-000000000001',${data.instrumentId},'x',null)`.execute(database), "42501", "writer clear"); }
async function operatorCannotAppendObservation(client: DatabaseClient, data: Fixture): Promise<void> { await asRole(client, "platform_market_data_operator", (database) => sql`select * from platform.list_open_market_data_halts()`.execute(database).then(() => undefined)); await asRoleRejected(client, "platform_market_data_operator", (database) => append(database, data, "3"), "42501", "operator append"); }
async function operatorCannotCallAppendAuditOrRequireSession(client: DatabaseClient, data: Fixture): Promise<void> { await asRole(client, "platform_market_data_operator", (database) => sql`select * from platform.list_open_market_data_halts()`.execute(database).then(() => undefined)); await asRoleRejected(client, "platform_market_data_operator", (database) => sql`select platform.append_audit_event('x','success',null,null,null,null,null,'{}')`.execute(database), "42501", "operator audit"); await asRoleRejected(client, "platform_market_data_operator", (database) => sql`select * from platform.require_authenticated_session(${data.sessionId},${data.secret},'market_data.halt.clear',null)`.execute(database), "42501", "operator require session"); }
async function runtimeHasNoMarketDataAccess(client: DatabaseClient, data: Fixture): Promise<void> { await asRole(client, "platform_runtime", (database) => sql`select 1`.execute(database).then(() => undefined)); await asRoleRejected(client, "platform_runtime", (database) => append(database, data, "4"), "42501", "runtime append"); await asRoleRejected(client, "platform_runtime", (database) => sql`select * from platform.market_data_effective_state`.execute(database), "42501", "runtime read view"); }
async function consumerCanReadOnlyEffectiveView(client: DatabaseClient, data: Fixture): Promise<void> { await asRole(client, "platform_market_data_consumer", (database) => sql`select * from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(database).then(() => undefined)); await asRoleRejected(client, "platform_market_data_consumer", (database) => append(database, data, "5"), "42501", "consumer append"); }
async function ownerCatalogSelectPrivileges(client: DatabaseClient): Promise<void> { const expected: Record<string, readonly string[]> = { markets: ["id", "market_code", "enabled"], providers: ["id", "enabled", "provider_code"], instruments: ["id", "market_id", "instrument_code", "enabled", "price_increment", "size_increment"], provider_instrument_symbols: ["provider_id", "instrument_id", "provider_symbol", "enabled"] }; for (const [table, columns] of Object.entries(expected)) { for (const column of columns) { const select = await sql<{ allowed: boolean }>`select has_column_privilege('platform_owner',${`platform.${table}`},${column},'select') allowed`.execute(client.database); assert(select.rows[0]?.allowed === true, `owner SELECT ${table}.${column}`); } const write = await sql<{ allowed: boolean }>`select has_table_privilege('platform_owner',${`platform.${table}`},'delete') allowed`.execute(client.database); assert(write.rows[0]?.allowed === false, `owner must not DELETE ${table}`); } }
async function provisionerCannotWriteObservations(client: DatabaseClient, data: Fixture): Promise<void> { await asRole(client, "platform_catalog_provisioner", (database) => sql`select 1`.execute(database).then(() => undefined)); await asRoleRejected(client, "platform_catalog_provisioner", (database) => append(database, data, "6"), "42501", "provisioner observation write"); }
async function catalogProvisioningRoleOnly(client: DatabaseClient, data: Fixture): Promise<void> { const manifest = { manifest_version: 1, provider: { provider_code: "priv-manifest-provider" }, market: { market_code: "priv-manifest-market", enabled: false }, instruments: [] }; await asRole(client, "platform_catalog_provisioner", (database) => sql`select platform.apply_market_data_catalog_manifest(cast(${JSON.stringify(manifest)} as jsonb))`.execute(database).then(() => undefined)); await asRole(client, "platform_market_data", (database) => append(database, data, "7")); await asRoleRejected(client, "platform_market_data", (database) => sql`select platform.apply_market_data_catalog_manifest(cast(${JSON.stringify(manifest)} as jsonb))`.execute(database), "42501", "writer manifest"); }

async function immutableTable(client: DatabaseClient, table: string): Promise<void> { await asRoleRejected(client, "platform_owner", (database) => sql.raw(`truncate platform.${table} cascade`).execute(database), "55000", `${table} truncate cascade guard`); }
async function immutableMarketDataObservations(client: DatabaseClient): Promise<void> { await immutableTable(client, "market_data_observations"); }
async function immutableMarketDataQualityEvents(client: DatabaseClient): Promise<void> { await immutableTable(client, "market_data_quality_events"); }
async function immutableMarketDataHalts(client: DatabaseClient): Promise<void> { await immutableTable(client, "market_data_halts"); }
async function immutableMarketDataHaltResolutions(client: DatabaseClient): Promise<void> { await immutableTable(client, "market_data_halt_resolutions"); }
async function immutableMarketDataJumpResets(client: DatabaseClient): Promise<void> { await immutableTable(client, "market_data_jump_resets"); }
async function immutableMarketDataJumpResetConsumptions(client: DatabaseClient): Promise<void> { await immutableTable(client, "market_data_jump_reset_consumptions"); }
async function immutableMarketDataQualityBucketFlushes(client: DatabaseClient): Promise<void> { await immutableTable(client, "market_data_quality_bucket_flushes"); }
async function createHistoryRows(client: DatabaseClient, data: Fixture): Promise<void> {
  await sql`select * from platform.append_market_data_observation(${data.providerId},${data.instrumentId},'PRIV-USD',700,700,1760698800123456,timestamptz '2025-10-17 11:00:00.123456+00',timestamptz '2025-10-17 11:00:01+00',99,1,101,1,100,1,0)`.execute(client.database);
  const halt = await sql<{ id: string }>`select platform.open_market_data_halt(${data.providerId},${data.instrumentId},'PRICE_JUMP',timestamptz '2025-10-17 11:00:00.123456+00',701,701,125,1,100) id`.execute(client.database);
  await sql`select * from platform.clear_market_data_halt(${data.sessionId},${data.secret},${halt.rows[0]!.id},${data.instrumentId},'history setup',125)`.execute(client.database);
  await sql`select * from platform.append_market_data_observation(${data.providerId},${data.instrumentId},'PRIV-USD',702,702,1760698800123456,timestamptz '2025-10-17 11:00:00.123456+00',timestamptz '2025-10-17 11:00:01+00',124,1,126,1,125,1,0)`.execute(client.database);
  await sql`select platform.append_market_data_quality_bucket('00000000-0000-7000-8000-000000000099',${data.providerId},null,'MALFORMED',timestamptz '2025-10-17 00:00:00+00',1)`.execute(client.database);
}
async function directUpdateDeleteTruncateRejectedForEveryMarketDataTable(client: DatabaseClient, data: Fixture): Promise<void> {
  await createHistoryRows(client, data);
  const tables = [{ table: "market_data_observations", primaryKey: "id" }, { table: "market_data_quality_events", primaryKey: "id" }, { table: "market_data_halts", primaryKey: "id" }, { table: "market_data_halt_resolutions", primaryKey: "id" }, { table: "market_data_jump_resets", primaryKey: "id" }, { table: "market_data_jump_reset_consumptions", primaryKey: "id" }, { table: "market_data_quality_bucket_flushes", primaryKey: "flush_id" }];
  for (const { table, primaryKey } of tables) {
    const count = await sql<{ count: string }>`select count(*)::text count from ${sql.raw(`platform.${table}`)}`.execute(client.database);
    assert(Number(count.rows[0]?.count) > 0, `${table} must have a real history row before mutation checks.`);
    await asRoleRejected(client, "platform_owner", (database) => sql.raw(`update platform.${table} set ${primaryKey}=${primaryKey}`).execute(database), "55000", `${table} owner update`);
    await asRoleRejected(client, "platform_owner", (database) => sql.raw(`delete from platform.${table}`).execute(database), "55000", `${table} owner delete`);
    await asRoleRejected(client, "platform_owner", (database) => sql.raw(`truncate platform.${table} cascade`).execute(database), "55000", `${table} owner truncate cascade`);
    await rejected(() => sql.raw(`update platform.${table} set ${primaryKey}=${primaryKey}`).execute(client.database), "55000", `${table} superuser update`);
    await rejected(() => sql.raw(`delete from platform.${table}`).execute(client.database), "55000", `${table} superuser delete`);
    await rejected(() => sql.raw(`truncate platform.${table} cascade`).execute(client.database), "55000", `${table} superuser truncate cascade`);
  }
}
async function bucketDirectDmlRejectedAsNonOwner(client: DatabaseClient, data: Fixture): Promise<void> { await asRole(client, "platform_market_data", (database) => append(database, data, "800")); await asRoleRejected(client, "platform_market_data", (database) => sql`insert into platform.market_data_quality_buckets(provider_id,instrument_id,reason_code,bucket_started_at,rejected_count) values (${data.providerId},null,'MALFORMED',clock_timestamp(),1)`.execute(database), "42501", "bucket direct non-owner insert"); }
async function bucketDirectDmlRejectedAsSuperuser(client: DatabaseClient, data: Fixture): Promise<void> { const role = await sql<{ rolsuper: boolean }>`select rolsuper from pg_roles where rolname=current_user`.execute(client.database); assert(role.rows[0]?.rolsuper === true, "connection user must be a superuser for bucket guard coverage."); await rejected(() => sql`insert into platform.market_data_quality_buckets(provider_id,instrument_id,reason_code,bucket_started_at,rejected_count) values (${data.providerId},null,'MALFORMED',clock_timestamp(),1)`.execute(client.database), "42501", "bucket superuser trigger"); }
async function securityDefinerSearchPathAndOwnerAreExact(client: DatabaseClient): Promise<void> { const rows = await sql<{ identity: string; owner: string; prosecdef: boolean; proconfig: string[] | null }>`select p.oid::regprocedure::text identity,r.rolname owner,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='platform' and p.oid::regprocedure::text in ('platform.open_market_data_halt(uuid,uuid,text,timestamp with time zone,numeric,numeric,numeric,numeric,numeric)','platform.append_market_data_observation(uuid,uuid,text,numeric,numeric,numeric,timestamp with time zone,timestamp with time zone,numeric,numeric,numeric,numeric,numeric,numeric,numeric)','platform.append_market_data_quality_bucket(uuid,uuid,uuid,text,timestamp with time zone,bigint)','platform.transition_market_data_state(uuid,text,text,uuid)','platform.market_data_startup_recovery(uuid)','platform.clear_market_data_halt(uuid,text,uuid,uuid,text,numeric)','platform.list_open_market_data_halts()','platform.apply_market_data_catalog_manifest(jsonb)')`.execute(client.database); assert(rows.rows.length === 8 && rows.rows.every((row) => row.owner === 'platform_owner' && row.prosecdef && row.proconfig?.includes('search_path=pg_catalog, platform')), "all eight Phase 5 functions must have exact definer owner and search_path."); }
async function requireAuthenticatedSessionDefinitionSnapshot(client: DatabaseClient): Promise<void> { const phase4 = await readFile(path.join(process.cwd(), "packages/database/src/migrations/20260925090000_create_authentication_authorization.ts"), "utf8"); const expected = phase4.match(/create function platform\.require_authenticated_session[^$]*\$\$([\s\S]*?)\$\$;/)?.[1]; const actual = await sql<{ definition: string }>`select pg_get_functiondef('platform.require_authenticated_session(uuid,text,text,uuid)'::regprocedure) definition`.execute(client.database); const actualBody = actual.rows[0]?.definition.match(/\$function\$([\s\S]*?)\$function\$/)?.[1]; assert(expected !== undefined && actualBody !== undefined, "Phase 4 and stored N1 function bodies must exist."); const normalize = (value: string) => value.replace(/\s+/g, " ").trim(); const expectedChanged = normalize(expected).replace("p_required_permission = 'password.reset.issue'", "p_required_permission in ('password.reset.issue', 'market_data.halt.clear')"); assert(expectedChanged === normalize(actualBody), "N1 body differs from Phase 4 only by the added permission condition."); }
async function runtimeAndPublicExecuteOnRequireSessionUnchanged(client: DatabaseClient): Promise<void> { const row = await sql<{ runtime: boolean; public_execute: boolean }>`select has_function_privilege('platform_runtime','platform.require_authenticated_session(uuid,text,text,uuid)','execute') runtime,has_function_privilege('public','platform.require_authenticated_session(uuid,text,text,uuid)','execute') public_execute`.execute(client.database); assert(row.rows[0]?.runtime === true && row.rows[0]?.public_execute === false, "runtime and PUBLIC execute rights on require_authenticated_session must remain unchanged."); }
async function allPhase5IdsUseUuidV7(client: DatabaseClient): Promise<void> { const rows = await sql<{ table_name: string; column_default: string | null }>`select table_name,column_default from information_schema.columns where table_schema='platform' and table_name like 'market_data_%' and column_name='id'`.execute(client.database); assert(rows.rows.every((row) => row.column_default?.includes('uuidv7')), "all Phase 5 identifiers must default to UUIDv7."); }
async function observationIdempotencyExcludesIngestedAt(client: DatabaseClient, data: Fixture): Promise<void> { let outcomes: readonly string[] = []; await asRole(client, "platform_market_data", async (database) => { const first = await sql<{ outcome: string }>`select outcome from platform.append_market_data_observation(${data.providerId},${data.instrumentId},'PRIV-USD',901,901,1760698800123456,timestamptz '2025-10-17 11:00:00.123456+00',timestamptz '2025-10-17 11:00:01+00',99,1,101,1,100,1,0)`.execute(database); const second = await sql<{ outcome: string }>`select outcome from platform.append_market_data_observation(${data.providerId},${data.instrumentId},'PRIV-USD',901,901,1760698800123456,timestamptz '2025-10-17 11:00:00.123456+00',timestamptz '2025-10-17 11:00:01+00',99,1,101,1,100,1,0)`.execute(database); outcomes = [first.rows[0]?.outcome ?? "", second.rows[0]?.outcome ?? ""]; }); await asRoleRejected(client, "platform_market_data", (database) => sql`select * from platform.market_data_observations`.execute(database), "42501", "writer direct observation select"); const rows = await sql<{ observations: string; halts: string }>`select (select count(*)::text from platform.market_data_observations where instrument_id=${data.instrumentId} and trade_id=901) observations,(select count(*)::text from platform.market_data_halts where instrument_id=${data.instrumentId}) halts`.execute(client.database); assert(outcomes[0] === 'ACCEPTED' && outcomes[1] === 'DUPLICATE_IDENTICAL' && rows.rows[0]?.observations === "1" && rows.rows[0]?.halts === "0", "ingested_at must be excluded from identical observation retries."); }
async function symbolColumnsAreCaseSensitiveCollationC(client: DatabaseClient, data: Fixture): Promise<void> { const collations = await sql<{ table_name: string; collname: string }>`select c.relname table_name,co.collname from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace join pg_collation co on co.oid=a.attcollation where n.nspname='platform' and a.attname='provider_symbol' and c.relname in ('market_data_observations','provider_instrument_symbols')`.execute(client.database); assert(collations.rows.length === 2 && collations.rows.every((row) => row.collname === 'C'), "provider-symbol columns must use C collation."); const lookup = await sql<{ upper_count: string; lower_count: string }>`select (select count(*)::text from platform.provider_instrument_symbols where provider_id=${data.providerId} and provider_symbol='PRIV-USD') upper_count,(select count(*)::text from platform.provider_instrument_symbols where provider_id=${data.providerId} and provider_symbol='priv-usd') lower_count`.execute(client.database); assert(lookup.rows[0]?.upper_count === '1' && lookup.rows[0]?.lower_count === '0', "catalog symbol lookup must be case-sensitive."); await asRole(client, "platform_market_data", (database) => sql`select * from platform.append_market_data_observation(${data.providerId},${data.instrumentId},'priv-usd',903,903,1760698800123456,timestamptz '2025-10-17 11:00:00.123456+00',timestamptz '2025-10-17 11:00:01+00',99,1,101,1,100,1,0)`.execute(database).then(() => undefined)); const stored = await sql<{ provider_symbol: string }>`select provider_symbol from platform.market_data_observations where instrument_id=${data.instrumentId} and trade_id=903`.execute(client.database); assert(stored.rows[0]?.provider_symbol === 'priv-usd', "lower-case observation symbol must be stored unchanged."); }
async function runtimeKeepsPhase4GrantsUnchanged(client: DatabaseClient): Promise<void> {
  const source = path.join(__dirname, "../../packages/database/src/migrations"); const temporary = await mkdtemp(path.join(process.cwd(), "dist", "phase4-acl-")); const nonce = `${process.pid}_${Date.now()}`;
  const snapshot = async () => (await sql<{ object: string; acl: string | null }>`select c.oid::regclass::text object,array_to_string(coalesce(c.relacl,acldefault('r',c.relowner)),',') acl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform' and c.relkind in ('r','v') and c.relname not like 'market_data_%' order by c.oid::regclass::text`.execute(client.database)).rows;
  try {
    const files = (await readdir(source)).sort(); for (const file of files.slice(0, 6)) await copyFile(path.join(source, file), path.join(temporary, file));
    await sql`drop schema if exists platform cascade`.execute(client.database); await runPendingMigrations(client, { migrationFolder: temporary, migrationTableName: `acl_snapshot_migrations_${nonce}`, migrationLockTableName: `acl_snapshot_lock_${nonce}` });
    const before = await snapshot(); await copyFile(path.join(source, files[6]!), path.join(temporary, files[6]!)); await runPendingMigrations(client, { migrationFolder: temporary, migrationTableName: `acl_snapshot_migrations_${nonce}`, migrationLockTableName: `acl_snapshot_lock_${nonce}` });
    const after = await snapshot(); assert(JSON.stringify(before) === JSON.stringify(after), "Phase 5 must not alter any Phase 1-4 ACL.");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function run(name: string, action: () => Promise<void>): Promise<void> { await action(); console.log(`${name} passed.`); }
async function main(): Promise<void> {
  const client = createDatabaseClient({ runtimeMode: "test", environment: environment() });
  const nonce = `${process.pid}${Date.now()}`;
  try {
    await run("runtimeKeepsPhase4GrantsUnchanged", () => runtimeKeepsPhase4GrantsUnchanged(client));
    await run("privilegeSnapshot", () => privilegeSnapshot(client));
    await run("writerCanAppendOnlyThroughFunctions", () => fixture(client, `${nonce}a`).then((data) => writerCanAppendOnlyThroughFunctions(client, data)));
    await run("writerCannotClear", () => fixture(client, `${nonce}b`).then((data) => writerCannotClear(client, data)));
    await run("operatorCannotAppendObservation", () => fixture(client, `${nonce}c`).then((data) => operatorCannotAppendObservation(client, data)));
    await run("operatorCannotCallAppendAuditOrRequireSession", () => fixture(client, `${nonce}d`).then((data) => operatorCannotCallAppendAuditOrRequireSession(client, data)));
    await run("runtimeHasNoMarketDataAccess", () => fixture(client, `${nonce}e`).then((data) => runtimeHasNoMarketDataAccess(client, data)));
    await run("consumerCanReadOnlyEffectiveView", () => fixture(client, `${nonce}f`).then((data) => consumerCanReadOnlyEffectiveView(client, data)));
    await run("ownerCatalogSelectPrivileges", () => ownerCatalogSelectPrivileges(client));
    await run("provisionerCannotWriteObservations", () => fixture(client, `${nonce}g`).then((data) => provisionerCannotWriteObservations(client, data)));
    await run("catalogProvisioningRoleOnly", () => fixture(client, `${nonce}h`).then((data) => catalogProvisioningRoleOnly(client, data)));
    await run("immutableMarketDataObservations", () => immutableMarketDataObservations(client));
    await run("immutableMarketDataQualityEvents", () => immutableMarketDataQualityEvents(client));
    await run("immutableMarketDataHalts", () => immutableMarketDataHalts(client));
    await run("immutableMarketDataHaltResolutions", () => immutableMarketDataHaltResolutions(client));
    await run("immutableMarketDataJumpResets", () => immutableMarketDataJumpResets(client));
    await run("immutableMarketDataJumpResetConsumptions", () => immutableMarketDataJumpResetConsumptions(client));
    await run("immutableMarketDataQualityBucketFlushes", () => immutableMarketDataQualityBucketFlushes(client));
    await run("directUpdateDeleteTruncateRejectedForEveryMarketDataTable", () => fixture(client, `${nonce}i`).then((data) => directUpdateDeleteTruncateRejectedForEveryMarketDataTable(client, data)));
    await run("bucketDirectDmlRejectedAsNonOwner", () => fixture(client, `${nonce}j`).then((data) => bucketDirectDmlRejectedAsNonOwner(client, data)));
    await run("bucketDirectDmlRejectedAsSuperuser", () => fixture(client, `${nonce}k`).then((data) => bucketDirectDmlRejectedAsSuperuser(client, data)));
    await run("securityDefinerSearchPathAndOwnerAreExact", () => securityDefinerSearchPathAndOwnerAreExact(client));
    await run("requireAuthenticatedSessionDefinitionSnapshot", () => requireAuthenticatedSessionDefinitionSnapshot(client));
    await run("runtimeAndPublicExecuteOnRequireSessionUnchanged", () => runtimeAndPublicExecuteOnRequireSessionUnchanged(client));
    await run("allPhase5IdsUseUuidV7", () => allPhase5IdsUseUuidV7(client));
    await run("observationIdempotencyExcludesIngestedAt", () => fixture(client, `${nonce}l`).then((data) => observationIdempotencyExcludesIngestedAt(client, data)));
    await run("symbolColumnsAreCaseSensitiveCollationC", () => fixture(client, `${nonce}m`).then((data) => symbolColumnsAreCaseSensitiveCollationC(client, data)));
  } finally { await client.close(); }
}
void main().catch((error: unknown) => { throw error; });
