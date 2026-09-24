import { sql, type Kysely } from "kysely";

const NORMALIZED_CODE = sql.raw("'^[a-z0-9]+(?:-[a-z0-9]+)*$'");

/** Creates platform identities and inert, versioned configuration records. */
export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .withSchema("platform")
    .createTable("users")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("user_code", "varchar(63)", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("users_pkey", ["id"])
    .addUniqueConstraint("users_user_code_key", ["user_code"])
    .addCheckConstraint("users_user_code_format_check", sql`user_code ~ ${NORMALIZED_CODE}`)
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("accounts")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("account_code", "varchar(63)", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("accounts_pkey", ["id"])
    .addUniqueConstraint("accounts_user_id_account_code_key", ["user_id", "account_code"])
    .addCheckConstraint("accounts_account_code_format_check", sql`account_code ~ ${NORMALIZED_CODE}`)
    .addForeignKeyConstraint("accounts_user_id_fkey", ["user_id"], "platform.users", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("strategies")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("strategy_code", "varchar(63)", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("strategies_pkey", ["id"])
    .addUniqueConstraint("strategies_user_id_strategy_code_key", ["user_id", "strategy_code"])
    .addCheckConstraint("strategies_strategy_code_format_check", sql`strategy_code ~ ${NORMALIZED_CODE}`)
    .addForeignKeyConstraint("strategies_user_id_fkey", ["user_id"], "platform.users", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("strategy_configurations")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("strategy_id", "uuid", (column) => column.notNull())
    .addColumn("version", "integer", (column) => column.notNull())
    .addColumn("configuration", "jsonb", (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("strategy_configurations_pkey", ["id"])
    .addUniqueConstraint("strategy_configurations_strategy_id_version_key", ["strategy_id", "version"])
    .addCheckConstraint("strategy_configurations_version_check", sql`version > 0`)
    .addCheckConstraint("strategy_configurations_object_check", sql`jsonb_typeof(configuration) = 'object'`)
    .addForeignKeyConstraint("strategy_configurations_strategy_id_fkey", ["strategy_id"], "platform.strategies", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("risk_configurations")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("account_id", "uuid", (column) => column.notNull())
    .addColumn("version", "integer", (column) => column.notNull())
    .addColumn("configuration", "jsonb", (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("risk_configurations_pkey", ["id"])
    .addUniqueConstraint("risk_configurations_account_id_version_key", ["account_id", "version"])
    .addCheckConstraint("risk_configurations_version_check", sql`version > 0`)
    .addCheckConstraint("risk_configurations_object_check", sql`jsonb_typeof(configuration) = 'object'`)
    .addForeignKeyConstraint("risk_configurations_account_id_fkey", ["account_id"], "platform.accounts", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("broker_connections")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("account_id", "uuid", (column) => column.notNull())
    .addColumn("provider_id", "uuid", (column) => column.notNull())
    .addColumn("connection_code", "varchar(63)", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("broker_connections_pkey", ["id"])
    .addUniqueConstraint("broker_connections_account_id_connection_code_key", ["account_id", "connection_code"])
    .addCheckConstraint("broker_connections_connection_code_format_check", sql`connection_code ~ ${NORMALIZED_CODE}`)
    .addForeignKeyConstraint("broker_connections_account_id_fkey", ["account_id"], "platform.accounts", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .addForeignKeyConstraint("broker_connections_provider_id_fkey", ["provider_id"], "platform.providers", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .execute();

  for (const table of ["users", "accounts", "strategies", "strategy_configurations", "risk_configurations", "broker_connections"]) {
    await sql.raw(`
      create trigger ${table}_set_updated_at
      before update on platform.${table}
      for each row execute function platform.set_catalog_updated_at()
    `).execute(database);
  }

  await sql.raw(`
    create function platform.prevent_strategy_configuration_revision_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'Configuration revisions are immutable.' using errcode = '55000';
      end if;
      if new.strategy_id is distinct from old.strategy_id
        or new.version is distinct from old.version
        or new.configuration is distinct from old.configuration then
        raise exception 'Configuration revision content is immutable.' using errcode = '55000';
      end if;
      return new;
    end;
    $$;

    create function platform.prevent_risk_configuration_revision_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'Configuration revisions are immutable.' using errcode = '55000';
      end if;
      if new.account_id is distinct from old.account_id
        or new.version is distinct from old.version
        or new.configuration is distinct from old.configuration then
        raise exception 'Configuration revision content is immutable.' using errcode = '55000';
      end if;
      return new;
    end;
    $$;

    create trigger strategy_configurations_prevent_revision_mutation
    before update or delete on platform.strategy_configurations
    for each row execute function platform.prevent_strategy_configuration_revision_mutation();

    create trigger risk_configurations_prevent_revision_mutation
    before update or delete on platform.risk_configurations
    for each row execute function platform.prevent_risk_configuration_revision_mutation();
  `).execute(database);
}
