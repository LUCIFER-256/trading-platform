import * as path from "node:path";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { createDatabaseClient, runPendingMigrations, sql, type DatabaseClient } from "../../packages/database/src";
import { createTestPasswordHasher } from "../../apps/api/src/auth";

type Database = DatabaseClient["database"];

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function environment(): { TEST_DATABASE_URL: string; DATABASE_SSL_MODE: string | undefined; DATABASE_POOL_MAX: string } {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required.");
  return {
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE,
    DATABASE_POOL_MAX: "1",
  };
}

async function asRole<T>(client: DatabaseClient, role: string, action: (database: Database) => Promise<T>): Promise<T> {
  return client.database.transaction().execute(async (database) => {
    await sql.raw(`set local role ${role}`).execute(database);
    return action(database);
  });
}

async function asRoleRejected(
  client: DatabaseClient,
  role: string,
  action: (database: Database) => Promise<unknown>,
  state: string,
  message: string,
): Promise<void> {
  const marker = `${message}: no error was raised; expected ${state}.`;
  await client.database.transaction().execute(async (database) => {
    await sql.raw(`set local role ${role}`).execute(database);
    await sql.raw("savepoint rejected_attempt").execute(database);
    try {
      await action(database);
      throw new Error(marker);
    } catch (error) {
      if (error instanceof Error && error.message === marker) throw error;
      const value = error as { code?: string; message?: string };
      assert(value.code === state, `${message}: expected ${state}; received ${String(value.code)} ${String(value.message)}.`);
      await sql.raw("rollback to savepoint rejected_attempt").execute(database);
    }
  });
}

const ROLES = [
  "platform_owner",
  "platform_market_data",
  "platform_market_data_operator",
  "platform_catalog_provisioner",
  "platform_market_data_consumer",
  "platform_runtime",
  "public",
] as const;

const SHORT = (role: string): string => role.replace("platform_", "");

const RELATION_PRIVILEGES = [
  ["select", "s"],
  ["insert", "i"],
  ["update", "u"],
  ["delete", "d"],
  ["truncate", "t"],
  ["references", "r"],
  ["trigger", "g"],
] as const;

const PHASE_1_TO_4_RELATIONS = [
  "account_role_assignments",
  "accounts",
  "assets",
  "audit_events",
  "auth_bootstrap_state",
  "auth_sessions",
  "broker_connections",
  "instruments",
  "ledger_accounts",
  "ledger_entries",
  "ledger_transactions",
  "markets",
  "password_credential_history",
  "password_credentials",
  "password_reset_tokens",
  "provider_instrument_symbols",
  "providers",
  "risk_configurations",
  "strategies",
  "strategy_configurations",
  "users",
  "wallet_balances",
  "wallets",
];

const PHASE_5_RELATIONS = [
  "market_data_effective_state",
  "market_data_halt_resolutions",
  "market_data_halts",
  "market_data_instrument_state",
  "market_data_jump_reset_consumptions",
  "market_data_jump_resets",
  "market_data_observations",
  "market_data_policies",
  "market_data_quality_bucket_flushes",
  "market_data_quality_buckets",
  "market_data_quality_events",
];

const ALL_PRIVILEGES = "siudtrg";

function expectedRelationPrivileges(relation: string): Record<string, string> {
  if (!PHASE_5_RELATIONS.includes(relation)) return {};
  const expected: Record<string, string> = { owner: ALL_PRIVILEGES };
  if (relation === "market_data_effective_state") expected.market_data_consumer = "s";
  if (relation === "market_data_policies") expected.market_data = "s";
  return expected;
}

async function relationPrivilegeSnapshot(client: DatabaseClient): Promise<void> {
  const relations = await sql<{ relname: string }>`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'platform' and c.relkind in ('r', 'v') order by c.relname`.execute(client.database);
  const names = relations.rows.map((row) => row.relname);
  const listed = [...PHASE_1_TO_4_RELATIONS, ...PHASE_5_RELATIONS].sort();
  assert(
    JSON.stringify(names) === JSON.stringify(listed),
    `Relations in schema platform must match the literal list; actual ${names.join(",")}.`,
  );
  for (const relation of names) {
    const actual: Record<string, string> = {};
    for (const role of ROLES) {
      let letters = "";
      for (const [privilege, letter] of RELATION_PRIVILEGES) {
        const row = await sql<{
          allowed: boolean;
        }>`select has_table_privilege(${role}, ${`platform.${relation}`}, ${privilege}) allowed`.execute(client.database);
        if (row.rows[0]?.allowed === true) letters += letter;
      }
      if (letters.length > 0) actual[SHORT(role)] = letters;
    }
    assert(
      JSON.stringify(actual) === JSON.stringify(expectedRelationPrivileges(relation)),
      `Relation privileges of ${relation} must match the literal snapshot; actual ${JSON.stringify(actual)}.`,
    );
  }
}

const FUNCTION_EXECUTE: Record<string, readonly string[]> = {
  append_audit_event: ["owner"],
  append_market_data_observation: ["market_data", "owner"],
  append_market_data_quality_bucket: ["market_data", "owner"],
  apply_market_data_catalog_manifest: ["catalog_provisioner", "owner"],
  assert_ledger_entry_trigger: [],
  assert_ledger_transaction_balanced: [],
  assert_ledger_transaction_header_trigger: [],
  bootstrap_first_super_admin: [],
  clear_market_data_halt: ["market_data_operator", "owner"],
  create_auth_session: ["runtime"],
  ensure_asset_clearing_accounts: [],
  ensure_asset_clearing_accounts_trigger: [],
  ensure_wallet_ledger_account: [],
  issue_password_reset: ["runtime"],
  list_open_market_data_halts: ["market_data_operator", "owner"],
  market_data_startup_recovery: ["market_data", "owner"],
  open_market_data_halt: ["market_data", "owner"],
  post_ledger_transaction: ["runtime"],
  prevent_password_reset_token_mutation: [],
  prevent_risk_configuration_revision_mutation: [],
  prevent_strategy_configuration_revision_mutation: [],
  prevent_wallet_identity_change: [],
  record_failed_password_login: ["runtime"],
  record_successful_password_login: ["runtime"],
  reject_auth_history_mutation: [],
  reject_direct_ledger_insert: [],
  reject_ledger_mutation: [],
  reject_market_data_bucket_mutation: [],
  reject_market_data_history_mutation: [],
  reject_market_data_history_truncate: [],
  require_authenticated_session: ["owner", "runtime"],
  require_verified_ledger_actor: [],
  revoke_auth_session: ["runtime"],
  set_auth_updated_at: [],
  set_catalog_updated_at: [],
  transition_market_data_state: ["market_data", "owner"],
};

async function functionExecuteMatrix(client: DatabaseClient): Promise<void> {
  const functions = await sql<{ proname: string; oid: number }>`select p.proname, p.oid from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'platform' order by p.proname`.execute(client.database);
  const names = functions.rows.map((row) => row.proname);
  assert(
    JSON.stringify(names) === JSON.stringify(Object.keys(FUNCTION_EXECUTE).sort()),
    `Functions in schema platform must match the literal list; actual ${names.join(",")}.`,
  );
  for (const fn of functions.rows) {
    const granted: string[] = [];
    for (const role of ROLES) {
      const row = await sql<{ allowed: boolean }>`select has_function_privilege(${role}, ${fn.oid}, 'execute') allowed`.execute(
        client.database,
      );
      if (row.rows[0]?.allowed === true) granted.push(SHORT(role));
    }
    const expected = [...(FUNCTION_EXECUTE[fn.proname] ?? [])].sort();
    assert(
      JSON.stringify(granted.sort()) === JSON.stringify(expected),
      `EXECUTE on ${fn.proname} must match the literal matrix; actual ${granted.join(",")}.`,
    );
  }
}

const CATALOG_WRITES: Record<string, { readonly insert: readonly string[]; readonly update: readonly string[] }> = {
  markets: { insert: ["market_code", "enabled"], update: ["enabled"] },
  providers: { insert: ["provider_code"], update: [] },
  instruments: {
    insert: ["market_id", "instrument_code", "enabled", "price_increment", "size_increment"],
    update: ["enabled", "price_increment", "size_increment"],
  },
  provider_instrument_symbols: { insert: ["provider_id", "instrument_id", "provider_symbol", "enabled"], update: ["enabled"] },
};

async function catalogColumnWritePrivileges(client: DatabaseClient): Promise<void> {
  for (const [table, expected] of Object.entries(CATALOG_WRITES)) {
    const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns
      where table_schema = 'platform' and table_name = ${table} order by ordinal_position`.execute(client.database);
    assert(columns.rows.length > 0, `${table} must have columns.`);
    for (const role of ROLES) {
      for (const column of columns.rows.map((row) => row.column_name)) {
        for (const privilege of ["insert", "update"] as const) {
          const row = await sql<{
            allowed: boolean;
          }>`select has_column_privilege(${role}, ${`platform.${table}`}, ${column}, ${privilege}) allowed`.execute(
            client.database,
          );
          const allowed = role === "platform_owner" && expected[privilege].includes(column);
          assert(
            row.rows[0]?.allowed === allowed,
            `${role} ${privilege.toUpperCase()} ${table}.${column} must be ${String(allowed)}.`,
          );
        }
      }
    }
  }
}

interface Session {
  readonly id: string;
  readonly secret: string;
}

async function newUser(client: DatabaseClient, label: string): Promise<string> {
  const user = await sql<{
    id: string;
  }>`insert into platform.users(user_code, enabled) values (${label}, true) returning id`.execute(client.database);
  const hash = await createTestPasswordHasher().hash("integration-password");
  await sql`insert into platform.password_credentials(user_id, password_hash, credential_version)
    values (${user.rows[0]!.id}, ${hash}, 1)`.execute(client.database);
  return user.rows[0]!.id;
}

async function newSession(client: DatabaseClient, userId: string, label: string): Promise<Session> {
  const secret = `${label}-session-secret-sufficiently-long`;
  const row = await sql<{ id: string }>`select platform.create_auth_session(${userId}, ${secret}, 1,
    clock_timestamp() + interval '30 minutes', clock_timestamp() + interval '8 hours') id`.execute(client.database);
  return { id: row.rows[0]!.id, secret };
}

async function newSuperAdminSession(client: DatabaseClient, label: string): Promise<Session> {
  const userId = await newUser(client, `${label}-user`);
  await sql`insert into platform.account_role_assignments(user_id, account_id, role, enabled)
    values (${userId}, null, 'SUPER_ADMIN', true)`.execute(client.database);
  return newSession(client, userId, label);
}

interface MatrixActor {
  readonly label: string;
  readonly session: { readonly id: string | null; readonly secret: string | null };
}

interface Matrix {
  readonly actors: readonly MatrixActor[];
  readonly accounts: Readonly<Record<string, string | null>>;
}

async function buildMatrix(client: DatabaseClient, nonce: string): Promise<Matrix> {
  const accountOwner = await newUser(client, `matrix-owner-${nonce}`);
  const accountA = await sql<{ id: string }>`insert into platform.accounts(user_id, account_code, enabled)
    values (${accountOwner}, ${`matrix-a-${nonce}`}, true) returning id`.execute(client.database);
  const accountB = await sql<{ id: string }>`insert into platform.accounts(user_id, account_code, enabled)
    values (${accountOwner}, ${`matrix-b-${nonce}`}, true) returning id`.execute(client.database);
  const actors: MatrixActor[] = [];
  const add = (label: string, session: Session): void => {
    actors.push({ label, session: { id: session.id, secret: session.secret } });
  };

  const superAdmin = await newUser(client, `matrix-super-${nonce}`);
  await sql`insert into platform.account_role_assignments(user_id, account_id, role, enabled)
    values (${superAdmin}, null, 'SUPER_ADMIN', true)`.execute(client.database);
  add("superAdmin", await newSession(client, superAdmin, `matrix-super-${nonce}`));

  const disabledSuper = await newUser(client, `matrix-dsuper-${nonce}`);
  await sql`insert into platform.account_role_assignments(user_id, account_id, role, enabled,
    revoked_at, revoked_by_user_id, revocation_reason)
    values (${disabledSuper}, null, 'SUPER_ADMIN', false, clock_timestamp(), ${disabledSuper}, 'matrix disabled')`.execute(
    client.database,
  );
  add("disabledSuperAdmin", await newSession(client, disabledSuper, `matrix-dsuper-${nonce}`));

  const adminA = await newUser(client, `matrix-admina-${nonce}`);
  await sql`insert into platform.account_role_assignments(user_id, account_id, role, enabled)
    values (${adminA}, ${accountA.rows[0]!.id}, 'ADMIN', true)`.execute(client.database);
  add("accountAdminA", await newSession(client, adminA, `matrix-admina-${nonce}`));

  const disabledAdmin = await newUser(client, `matrix-dadmin-${nonce}`);
  await sql`insert into platform.account_role_assignments(user_id, account_id, role, enabled,
    revoked_at, revoked_by_user_id, revocation_reason)
    values (${disabledAdmin}, ${accountA.rows[0]!.id}, 'ADMIN', false, clock_timestamp(), ${disabledAdmin}, 'matrix disabled')`.execute(
    client.database,
  );
  add("disabledAccountAdminA", await newSession(client, disabledAdmin, `matrix-dadmin-${nonce}`));

  const noRole = await newUser(client, `matrix-norole-${nonce}`);
  add("noRole", await newSession(client, noRole, `matrix-norole-${nonce}`));

  const disabledUser = await newUser(client, `matrix-duser-${nonce}`);
  await sql`insert into platform.account_role_assignments(user_id, account_id, role, enabled)
    values (${disabledUser}, null, 'SUPER_ADMIN', true)`.execute(client.database);
  const disabledUserSession = await newSession(client, disabledUser, `matrix-duser-${nonce}`);
  await sql`update platform.users set enabled = false where id = ${disabledUser}`.execute(client.database);
  add("disabledUserWithSuperAdminRole", disabledUserSession);

  const revokedUser = await newUser(client, `matrix-revoked-${nonce}`);
  await sql`insert into platform.account_role_assignments(user_id, account_id, role, enabled)
    values (${revokedUser}, null, 'SUPER_ADMIN', true)`.execute(client.database);
  const revoked = await newSession(client, revokedUser, `matrix-revoked-${nonce}`);
  await sql`select platform.revoke_auth_session(${revoked.id}, ${"matrix"})`.execute(client.database);
  add("revokedSuperAdminSession", revoked);

  add("wrongSecretForSuperAdmin", {
    id: actors[0]!.session.id!,
    secret: "matrix-wrong-secret-that-is-long-enough-to-pass",
  });
  actors.push({ label: "shortSecret", session: { id: actors[0]!.session.id, secret: "short" } });
  actors.push({
    label: "unknownSession",
    session: { id: "00000000-0000-7000-8000-0000000000aa", secret: actors[0]!.session.secret },
  });
  actors.push({ label: "nullSession", session: { id: null, secret: null } });
  return { actors, accounts: { none: null, accountA: accountA.rows[0]!.id, accountB: accountB.rows[0]!.id } };
}

const PERMISSIONS = [
  "password.reset.issue",
  "ledger.post.deposit",
  "ledger.post.withdrawal",
  "ledger.post.manual_adjustment",
  "ledger.read",
  "unknown.permission",
  "market_data.halt.clear",
] as const;

async function evaluateMatrix(client: DatabaseClient, matrix: Matrix): Promise<Map<string, string>> {
  const outcomes = new Map<string, string>();
  for (const actor of matrix.actors) {
    for (const permission of PERMISSIONS) {
      for (const [accountLabel, accountId] of Object.entries(matrix.accounts)) {
        const key = `${actor.label}|${permission}|${accountLabel}`;
        try {
          await asRole(client, "platform_runtime", (database) =>
            sql`select * from platform.require_authenticated_session(
            ${actor.session.id}, ${actor.session.secret}, ${permission}, ${accountId})`.execute(database),
          );
          outcomes.set(key, "OK");
        } catch (error) {
          const code = (error as { code?: string }).code;
          assert(typeof code === "string", `${key}: the failure must carry a SQLSTATE.`);
          outcomes.set(key, code);
        }
      }
    }
  }
  return outcomes;
}

interface BeforeAfter {
  readonly matrix: Matrix;
  readonly before: Map<string, string>;
  readonly after: Map<string, string>;
}

async function runBeforeAfter(client: DatabaseClient, nonce: string): Promise<BeforeAfter> {
  const source = path.join(__dirname, "../../packages/database/src/migrations");
  const temporary = await mkdtemp(path.join(process.cwd(), "dist", "gates-matrix-"));
  const names = { migrationTableName: `gates_migrations_${nonce}`, migrationLockTableName: `gates_lock_${nonce}` };
  try {
    const files = (await readdir(source)).filter((file) => file.endsWith(".js")).sort();
    assert(files.length === 8, `Eight migrations are expected; found ${files.length}.`);
    for (const file of files.slice(0, 6)) await copyFile(path.join(source, file), path.join(temporary, file));
    await sql`drop schema if exists platform cascade`.execute(client.database);
    await runPendingMigrations(client, { migrationFolder: temporary, ...names });
    const matrix = await buildMatrix(client, nonce);
    const before = await evaluateMatrix(client, matrix);
    await copyFile(path.join(source, files[6]!), path.join(temporary, files[6]!));
    await runPendingMigrations(client, { migrationFolder: temporary, ...names });
    const after = await evaluateMatrix(client, matrix);
    for (const file of files.slice(7)) await copyFile(path.join(source, file), path.join(temporary, file));
    await runPendingMigrations(client, { migrationFolder: temporary, ...names });
    return { matrix, before, after };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function sanityCheckMatrix(result: BeforeAfter): void {
  const expected = result.matrix.actors.length * PERMISSIONS.length * Object.keys(result.matrix.accounts).length;
  assert(result.before.size === expected && result.after.size === expected, "Both matrices must cover every combination.");
  assert(
    result.before.get("superAdmin|password.reset.issue|none") === "OK",
    "A global super-admin must pass a Phase 4 permission before N1.",
  );
  assert(
    result.before.get("noRole|password.reset.issue|none") === "42501",
    "A user without a role must be refused a Phase 4 permission.",
  );
  assert(result.before.get("nullSession|ledger.read|none") === "28000", "A missing session must fail authentication.");
}

async function phase4AuthorizationMatrixBeforeAfter(result: BeforeAfter): Promise<void> {
  sanityCheckMatrix(result);
  let compared = 0;
  for (const [key, before] of result.before) {
    if (key.split("|")[1] === "market_data.halt.clear") continue;
    compared += 1;
    assert(
      result.after.get(key) === before,
      `Phase 4 outcome changed for ${key}: ${before} became ${String(result.after.get(key))}.`,
    );
  }
  assert(
    compared === result.before.size - result.matrix.actors.length * Object.keys(result.matrix.accounts).length,
    "Compared count.",
  );
  const kinds = new Set(result.before.values());
  assert(
    kinds.has("OK") && kinds.has("42501") && kinds.has("28000"),
    "The matrix must exercise success, authorization and authentication outcomes.",
  );
  console.log(`phase4AuthorizationMatrixBeforeAfter compared ${compared} combinations`);
}

async function n1OnlyChangesHaltClearOutcomeForGlobalSuperAdmin(result: BeforeAfter): Promise<void> {
  sanityCheckMatrix(result);
  const changed: string[] = [];
  for (const [key, before] of result.before) {
    if (result.after.get(key) !== before) changed.push(`${key}:${before}>${String(result.after.get(key))}`);
  }
  changed.sort();
  const expected = [
    "accountAdminA|market_data.halt.clear|accountA:OK>42501",
    "superAdmin|market_data.halt.clear|accountA:42501>OK",
    "superAdmin|market_data.halt.clear|accountB:42501>OK",
    "superAdmin|market_data.halt.clear|none:42501>OK",
  ];
  assert(
    JSON.stringify(changed) === JSON.stringify(expected),
    `N1 may change only the halt-clear outcomes listed; actual changes: ${JSON.stringify(changed)}.`,
  );
  for (const [key, outcome] of result.after) {
    const [actor, permission] = key.split("|");
    if (permission !== "market_data.halt.clear") continue;
    assert(
      (outcome === "OK") === (actor === "superAdmin"),
      `After N1 only a global super-admin may hold halt-clear; ${key} gave ${outcome}.`,
    );
  }
  console.log("n1OnlyChangesHaltClearOutcomeForGlobalSuperAdmin");
}

async function marketDataClearRequiresSuperAdminGlobalPermission(client: DatabaseClient): Promise<void> {
  const row = await sql<{ definition: string }>`select pg_get_functiondef(
    'platform.clear_market_data_halt(uuid,text,uuid,uuid,text,numeric)'::regprocedure) definition`.execute(client.database);
  const definition = row.rows[0]?.definition.replace(/\s+/g, " ") ?? "";
  assert(
    definition.includes("platform.require_authenticated_session(p_session_id,p_session_secret,'market_data.halt.clear',null)"),
    "clear_market_data_halt must authorize through require_authenticated_session with the halt-clear permission and no account.",
  );
  const guard = await sql<{ definition: string }>`select pg_get_functiondef(
    'platform.require_authenticated_session(uuid,text,text,uuid)'::regprocedure) definition`.execute(client.database);
  const body = guard.rows[0]?.definition.replace(/\s+/g, " ") ?? "";
  assert(
    body.includes("p_required_permission = 'password.reset.issue' or p_required_permission = 'market_data.halt.clear'") ||
      body.includes("p_required_permission in ('password.reset.issue', 'market_data.halt.clear')"),
    "require_authenticated_session must route the halt-clear permission to the global super-admin branch.",
  );
  console.log("marketDataClearRequiresSuperAdminGlobalPermission");
}

interface World {
  readonly providerId: string;
  readonly instrumentId: string;
  readonly secondInstrumentId: string;
  readonly otherProviderId: string;
  readonly otherInstrumentId: string;
  readonly session: Session;
}

async function newInstrument(client: DatabaseClient, marketId: string, providerId: string, label: string): Promise<string> {
  const instrument = await sql<{
    id: string;
  }>`insert into platform.instruments(market_id, instrument_code, enabled, price_increment, size_increment)
    values (${marketId}, ${`gates-${label}`}, true, 0.01, 0.00000001) returning id`.execute(client.database);
  const id = instrument.rows[0]!.id;
  await sql`insert into platform.provider_instrument_symbols(provider_id, instrument_id, provider_symbol, enabled)
    values (${providerId}, ${id}, ${`G${label.toUpperCase()}-USD`}, true)`.execute(client.database);
  await sql`insert into platform.market_data_policies(instrument_id, enabled) values (${id}, true)`.execute(client.database);
  return id;
}

async function newWorld(client: DatabaseClient, suffix: string): Promise<World> {
  const market = await sql<{ id: string }>`insert into platform.markets(market_code, enabled)
    values (${`gates-market-${suffix}`}, true) returning id`.execute(client.database);
  const provider = await sql<{ id: string }>`insert into platform.providers(provider_code, enabled)
    values (${`gates-provider-${suffix}`}, true) returning id`.execute(client.database);
  const other = await sql<{ id: string }>`insert into platform.providers(provider_code, enabled)
    values (${`gates-other-${suffix}`}, true) returning id`.execute(client.database);
  const marketId = market.rows[0]!.id;
  return {
    providerId: provider.rows[0]!.id,
    instrumentId: await newInstrument(client, marketId, provider.rows[0]!.id, `${suffix}a`),
    secondInstrumentId: await newInstrument(client, marketId, provider.rows[0]!.id, `${suffix}b`),
    otherProviderId: other.rows[0]!.id,
    otherInstrumentId: await newInstrument(client, marketId, other.rows[0]!.id, `${suffix}c`),
    session: await newSuperAdminSession(client, `gates-${suffix}`),
  };
}

async function openHalt(
  client: DatabaseClient,
  world: World,
  instrumentId: string,
  reason: string,
  fields: {
    eventAt?: string | null;
    trade?: string | null;
    sequence?: string | null;
    price?: string | null;
    size?: string | null;
    reference?: string | null;
  } = {},
): Promise<string> {
  return asRole(client, "platform_market_data", async (database) => {
    const row = await sql<{ id: string }>`select platform.open_market_data_halt(${world.providerId}, ${instrumentId}, ${reason},
      cast(${fields.eventAt ?? null} as timestamptz), cast(${fields.trade ?? null} as numeric), cast(${fields.sequence ?? null} as numeric),
      cast(${fields.price ?? null} as numeric), cast(${fields.size ?? null} as numeric),
      cast(${fields.reference ?? null} as numeric)) id`.execute(database);
    return row.rows[0]!.id;
  });
}

async function openHaltRecordsMicrosecondEvidenceExactly(client: DatabaseClient, world: World): Promise<void> {
  const haltId = await openHalt(client, world, world.instrumentId, "PRICE_JUMP", {
    eventAt: "2025-10-17 11:00:00.123456+00",
    trade: "12345678901234567890",
    sequence: "98765432109876543210",
    price: "100.123456789012345678",
    size: "0.000000000000000001",
    reference: "99.500000000000000000",
  });
  const stored = await sql<
    Record<string, string | boolean | null>
  >`select (q.event_at at time zone 'UTC')::text event_at, q.trade_id::text trade_id,
    q.provider_sequence::text provider_sequence, q.candidate_price::text q_price, q.candidate_size::text q_size,
    q.decision, q.requires_human_clear,
    q.reason_code, h.candidate_price::text h_price, h.candidate_size::text h_size, h.candidate_trade_id::text h_trade,
    h.candidate_provider_sequence::text h_sequence, h.reference_price::text h_reference, s.base_availability
    from platform.market_data_halts h join platform.market_data_quality_events q on q.id = h.quality_event_id
    join platform.market_data_instrument_state s on s.instrument_id = h.instrument_id where h.id = ${haltId}`.execute(
    client.database,
  );
  const row = stored.rows[0];
  assert(row !== undefined, "The halt must be stored.");
  assert(row.event_at === "2025-10-17 11:00:00.123456", `Microseconds must be preserved, saw ${String(row.event_at)}.`);
  assert(row.trade_id === "12345678901234567890" && row.h_trade === "12345678901234567890", "A 20-digit trade id must be exact.");
  assert(
    row.provider_sequence === "98765432109876543210" && row.h_sequence === "98765432109876543210",
    "A 20-digit sequence must be exact.",
  );
  assert(
    row.q_price === "100.123456789012345678" && row.h_price === "100.123456789012345678",
    "An 18-digit price must be exact.",
  );
  assert(row.q_size === "0.000000000000000001" && row.h_size === "0.000000000000000001", "An 18-digit size must be exact.");
  assert(row.h_reference === "99.500000000000000000", "The reference price must be exact.");
  assert(
    row.decision === "QUARANTINE" && row.requires_human_clear === true && row.reason_code === "PRICE_JUMP",
    "A price jump quarantines.",
  );
  assert(row.base_availability === "UNAVAILABLE_HUMAN_HALT", "An open halt must latch the human-halt state.");

  const other = await openHalt(client, world, world.secondInstrumentId, "LOCKED_OR_CROSSED");
  const second = await sql<{
    decision: string;
    event_at: string | null;
  }>`select q.decision, (q.event_at at time zone 'UTC')::text event_at from platform.market_data_halts h
    join platform.market_data_quality_events q on q.id = h.quality_event_id where h.id = ${other}`.execute(client.database);
  assert(
    second.rows[0]?.decision === "HALT" && second.rows[0]?.event_at === null,
    "A non-price halt records HALT and a null event time.",
  );

  await asRoleRejected(
    client,
    "platform_market_data",
    (database) =>
      sql`select platform.open_market_data_halt(${world.providerId},
    ${world.instrumentId}, 'LOCKED_OR_CROSSED', null, null, null, null, null, null)`.execute(database),
    "55000",
    "second open halt",
  );
  await asRoleRejected(
    client,
    "platform_market_data",
    (database) =>
      sql`select platform.open_market_data_halt(${world.providerId},
    ${world.otherInstrumentId}, 'BOGUS', null, null, null, null, null, null)`.execute(database),
    "22023",
    "unknown halt reason",
  );
  await asRoleRejected(
    client,
    "platform_market_data",
    (database) =>
      sql`select platform.open_market_data_halt(${world.providerId},
    ${world.otherInstrumentId}, 'PRICE_JUMP', null, null, null, null, null, null)`.execute(database),
    "23514",
    "price jump without candidate",
  );
  await asRoleRejected(
    client,
    "platform_market_data",
    (database) =>
      sql`select platform.open_market_data_halt(${world.providerId},
    ${world.otherInstrumentId}, 'LOCKED_OR_CROSSED', null, null, null, 1, null, null)`.execute(database),
    "23514",
    "non-price halt with candidate",
  );
  const leftovers = await sql<{
    count: string;
  }>`select count(*)::text count from platform.market_data_halts where instrument_id = ${world.otherInstrumentId}`.execute(
    client.database,
  );
  assert(leftovers.rows[0]?.count === "0", "Rejected opens must leave no halt behind.");
  for (const role of [
    "platform_market_data_operator",
    "platform_market_data_consumer",
    "platform_runtime",
    "platform_catalog_provisioner",
  ]) {
    await asRoleRejected(
      client,
      role,
      (database) =>
        sql`select platform.open_market_data_halt(${world.providerId}, ${world.otherInstrumentId},
      'LOCKED_OR_CROSSED', null, null, null, null, null, null)`.execute(database),
      "42501",
      `${role} open halt`,
    );
  }
  console.log("openHaltRecordsMicrosecondEvidenceExactly");
}

interface ListedHalt {
  readonly halt_id: string;
  readonly instrument_id: string;
  readonly reason_code: string;
  readonly candidate_price: string | null;
  readonly candidate_trade_id: string | null;
  readonly reference_price: string | null;
  readonly opened_at: Date;
}

async function listOpenHaltsReturnsOnlyUnresolvedInOpenOrder(client: DatabaseClient, world: World): Promise<void> {
  const first = await openHalt(client, world, world.instrumentId, "OUT_OF_ORDER_MATCH_ID", { trade: "11", sequence: "11" });
  const second = await openHalt(client, world, world.secondInstrumentId, "PRICE_JUMP", {
    eventAt: "2025-10-17 11:00:00.5+00",
    trade: "22",
    sequence: "22",
    price: "200.5",
    size: "1",
    reference: "100",
  });
  const third = await openHalt(client, world, world.otherInstrumentId, "IN_SESSION_MATCH_GAP", { trade: "33", sequence: "33" });
  const mine = new Set([first, second, third]);
  const list = (): Promise<ListedHalt[]> =>
    asRole(client, "platform_market_data_operator", async (database) => {
      const rows = await sql<ListedHalt>`select * from platform.list_open_market_data_halts()`.execute(database);
      return rows.rows.filter((row) => mine.has(row.halt_id));
    });
  const all = await list();
  assert(
    all.map((row) => row.halt_id).join() === [first, second, third].join(),
    "Open halts must come back in the order they were opened.",
  );
  const priceJump = all[1]!;
  assert(
    priceJump.reason_code === "PRICE_JUMP" &&
      Number(priceJump.candidate_price) === 200.5 &&
      Number(priceJump.reference_price) === 100,
    "Candidate evidence must be returned.",
  );
  assert(
    all[0]!.candidate_price === null && all[0]!.candidate_trade_id === "11",
    "Absent candidate evidence must come back null.",
  );
  assert(all[0]!.opened_at <= all[1]!.opened_at && all[1]!.opened_at <= all[2]!.opened_at, "Open times must be non-decreasing.");

  await asRole(client, "platform_market_data_operator", (database) =>
    sql`select * from platform.clear_market_data_halt(${world.session.id},
    ${world.session.secret}, ${first}, ${world.instrumentId}, 'gates test', null)`.execute(database),
  );
  const afterClear = await list();
  assert(
    afterClear.map((row) => row.halt_id).join() === [second, third].join(),
    "A resolved halt must leave the list and order must hold.",
  );
  for (const role of [
    "platform_market_data",
    "platform_market_data_consumer",
    "platform_runtime",
    "platform_catalog_provisioner",
  ]) {
    await asRoleRejected(
      client,
      role,
      (database) => sql`select * from platform.list_open_market_data_halts()`.execute(database),
      "42501",
      `${role} list halts`,
    );
  }
  await asRoleRejected(
    client,
    "platform_market_data",
    (database) =>
      sql`select * from platform.clear_market_data_halt(${world.session.id},
    ${world.session.secret}, ${second}, ${world.secondInstrumentId}, 'writer attempt', 200.5)`.execute(database),
    "42501",
    "writer clear",
  );
  console.log("listOpenHaltsReturnsOnlyUnresolvedInOpenOrder");
}

async function marketOf(client: DatabaseClient, instrumentId: string): Promise<string> {
  const row = await sql<{ market_id: string }>`select market_id from platform.instruments where id = ${instrumentId}`.execute(
    client.database,
  );
  return row.rows[0]!.market_id;
}

async function stateOf(client: DatabaseClient, instrumentId: string): Promise<string | undefined> {
  const row = await sql<{ base_availability: string }>`select base_availability from platform.market_data_instrument_state
    where instrument_id = ${instrumentId}`.execute(client.database);
  return row.rows[0]?.base_availability;
}

async function recoveryEvents(
  client: DatabaseClient,
  providerId: string,
  instrumentId: string | null,
): Promise<{ reason_code: string; requires_human_clear: boolean }[]> {
  const rows = await sql<{ reason_code: string; requires_human_clear: boolean }>`select reason_code, requires_human_clear
    from platform.market_data_quality_events where provider_id = ${providerId} and decision = 'RECOVERY'
    and instrument_id is not distinct from ${instrumentId} order by reason_code`.execute(client.database);
  return rows.rows;
}

async function transition(
  client: DatabaseClient,
  providerId: string,
  state: string,
  reason: string,
  instrumentId: string | null,
): Promise<void> {
  await asRole(client, "platform_market_data", (database) =>
    sql`select platform.transition_market_data_state(
    ${providerId}, ${state}, ${reason}, ${instrumentId})`.execute(database),
  );
}

async function transitionMarketDataStateRules(client: DatabaseClient, world: World): Promise<void> {
  const allowed: readonly (readonly [string, string])[] = [
    ["UNAVAILABLE_DISABLED_SCOPE", "DISABLED_OR_UNMAPPED"],
    ["UNAVAILABLE_REBASELINING", "HEARTBEAT_TIMEOUT"],
    ["UNAVAILABLE_PROVIDER_CIRCUIT", "PROVIDER_CIRCUIT"],
    ["UNAVAILABLE_PERSISTENCE", "PERSISTENCE_TIMEOUT"],
  ];
  for (const [state, reason] of allowed) {
    await transition(client, world.providerId, state, reason, world.instrumentId);
    assert((await stateOf(client, world.instrumentId)) === state, `An instrument transition to ${state} must be stored.`);
  }
  const events = await recoveryEvents(client, world.providerId, world.instrumentId);
  assert(
    events.length === 4 && events.every((event) => event.requires_human_clear === false),
    "Each transition records one RECOVERY event that needs no human.",
  );
  await asRoleRejected(
    client,
    "platform_market_data",
    (database) =>
      sql`select platform.transition_market_data_state(${world.providerId},
    'UNAVAILABLE_REBASELINING', 'NOT_A_REASON', ${world.instrumentId})`.execute(database),
    "23514",
    "unknown recovery reason",
  );
  assert(
    (await stateOf(client, world.instrumentId)) === "UNAVAILABLE_PERSISTENCE",
    "A rejected transition must roll the state change back.",
  );
  for (const bad of ["AVAILABLE", "UNAVAILABLE_HUMAN_HALT", "bogus"]) {
    await asRoleRejected(
      client,
      "platform_market_data",
      (database) =>
        sql`select platform.transition_market_data_state(${world.providerId},
      ${bad}, 'ANY', ${world.instrumentId})`.execute(database),
      "22023",
      `transition to ${bad}`,
    );
  }
  for (const reason of [
    "LOCKED_OR_CROSSED",
    "OUT_OF_ORDER_MATCH_ID",
    "IN_SESSION_MATCH_GAP",
    "PRICE_JUMP",
    "PRODUCT_ASSERTION_FAILURE",
    "IDEMPOTENCY_CONFLICT",
  ]) {
    await asRoleRejected(
      client,
      "platform_market_data",
      (database) =>
        sql`select platform.transition_market_data_state(${world.providerId},
      'UNAVAILABLE_PERSISTENCE', ${reason}, ${world.instrumentId})`.execute(database),
      "22023",
      `halt reason ${reason} used as a transition`,
    );
  }
  assert(
    (await recoveryEvents(client, world.providerId, world.instrumentId)).length === 4,
    "Rejected transitions must write no event.",
  );

  await openHalt(client, world, world.secondInstrumentId, "LOCKED_OR_CROSSED");
  const eventsBefore = (await recoveryEvents(client, world.providerId, world.secondInstrumentId)).length;
  await asRoleRejected(
    client,
    "platform_market_data",
    (database) =>
      sql`select platform.transition_market_data_state(${world.providerId},
    'UNAVAILABLE_REBASELINING', 'HEARTBEAT_TIMEOUT', ${world.secondInstrumentId})`.execute(database),
    "55000",
    "transition over a human halt",
  );
  assert(
    (await stateOf(client, world.secondInstrumentId)) === "UNAVAILABLE_HUMAN_HALT",
    "A human halt must survive an instrument transition.",
  );
  assert(
    (await recoveryEvents(client, world.providerId, world.secondInstrumentId)).length === eventsBefore,
    "A refused transition must write no event.",
  );

  await transition(client, world.otherProviderId, "UNAVAILABLE_PERSISTENCE", "QUEUE_OVERFLOW", world.otherInstrumentId);
  await transition(client, world.providerId, "UNAVAILABLE_PROVIDER_CIRCUIT", "PROVIDER_CIRCUIT", null);
  assert(
    (await stateOf(client, world.instrumentId)) === "UNAVAILABLE_PROVIDER_CIRCUIT",
    "A provider-wide transition must reach the provider's instruments.",
  );
  assert(
    (await stateOf(client, world.secondInstrumentId)) === "UNAVAILABLE_HUMAN_HALT",
    "A provider-wide transition must skip human-halted instruments.",
  );
  assert(
    (await stateOf(client, world.otherInstrumentId)) === "UNAVAILABLE_PERSISTENCE",
    "A provider-wide transition must not touch another provider.",
  );
  const wide = await recoveryEvents(client, world.providerId, null);
  assert(
    wide.length === 1 && wide[0]?.reason_code === "PROVIDER_CIRCUIT",
    "A provider-wide transition records one event with no instrument.",
  );

  const strayBefore = await recoveryEvents(client, world.otherProviderId, world.instrumentId);
  await asRoleRejected(
    client,
    "platform_market_data",
    (database) =>
      sql`select platform.transition_market_data_state(${world.otherProviderId}, 'UNAVAILABLE_PERSISTENCE', 'QUEUE_OVERFLOW',
        ${world.instrumentId})`.execute(database),
    "22023",
    "transition naming the wrong provider",
  );
  assert(
    (await stateOf(client, world.instrumentId)) === "UNAVAILABLE_PROVIDER_CIRCUIT",
    "A transition naming the wrong provider must not change state.",
  );
  assert(
    (await recoveryEvents(client, world.otherProviderId, world.instrumentId)).length === strayBefore.length,
    "A transition naming the wrong provider must write no event.",
  );
  const unseen = await newInstrument(
    client,
    await marketOf(client, world.instrumentId),
    world.providerId,
    `${world.instrumentId.slice(-6)}z`,
  );
  await asRoleRejected(
    client,
    "platform_market_data",
    (database) =>
      sql`select platform.transition_market_data_state(${world.otherProviderId}, 'UNAVAILABLE_PERSISTENCE', 'QUEUE_OVERFLOW',
        ${unseen})`.execute(database),
    "22023",
    "wrong provider for an instrument with no state",
  );
  assert((await stateOf(client, unseen)) === undefined, "A refused transition must not create a state row.");

  const view = await sql<{ availability: string }>`select availability from platform.market_data_effective_state
    where instrument_id = ${world.instrumentId}`.execute(client.database);
  assert(view.rows[0]?.availability === "UNAVAILABLE_PROVIDER_CIRCUIT", "The effective view must show the transition.");
  for (const role of [
    "platform_market_data_operator",
    "platform_market_data_consumer",
    "platform_runtime",
    "platform_catalog_provisioner",
  ]) {
    await asRoleRejected(
      client,
      role,
      (database) =>
        sql`select platform.transition_market_data_state(${world.providerId},
      'UNAVAILABLE_PERSISTENCE', 'DENIED', null)`.execute(database),
      "42501",
      `${role} transition`,
    );
  }
  console.log("transitionMarketDataStateRules");
}

async function main(): Promise<void> {
  const client = createDatabaseClient({ runtimeMode: "test", environment: environment() });
  const nonce = `${process.pid}${Date.now()}`;
  try {
    const result = await runBeforeAfter(client, nonce);
    await phase4AuthorizationMatrixBeforeAfter(result);
    await n1OnlyChangesHaltClearOutcomeForGlobalSuperAdmin(result);
    await marketDataClearRequiresSuperAdminGlobalPermission(client);
    await relationPrivilegeSnapshot(client);
    console.log("relationPrivilegeSnapshot");
    await functionExecuteMatrix(client);
    console.log("functionExecuteMatrix");
    await catalogColumnWritePrivileges(client);
    console.log("catalogColumnWritePrivileges");
    await openHaltRecordsMicrosecondEvidenceExactly(client, await newWorld(client, `${nonce}a`));
    await listOpenHaltsReturnsOnlyUnresolvedInOpenOrder(client, await newWorld(client, `${nonce}b`));
    await transitionMarketDataStateRules(client, await newWorld(client, `${nonce}c`));
  } finally {
    await sql`drop schema if exists platform cascade`.execute(client.database).catch(() => undefined);
    await client.close();
  }
}

let finished = false;

process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("Gates integration test ended without finishing.");
    process.exitCode = 1;
  }
});

void main().then(
  () => {
    finished = true;
    process.exit(0);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
