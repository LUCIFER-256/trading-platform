import { sql, type Kysely } from "kysely";

const NORMALIZED_CODE = sql.raw("'^[a-z0-9]+(?:-[a-z0-9]+)*$'");

/** Creates the platform asset catalog and one asset-denominated wallet per account. */
export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .withSchema("platform")
    .createTable("assets")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("asset_code", "varchar(63)", (column) => column.notNull())
    .addColumn("asset_kind", "varchar(16)", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("assets_pkey", ["id"])
    .addUniqueConstraint("assets_asset_code_key", ["asset_code"])
    .addCheckConstraint("assets_asset_code_format_check", sql`asset_code ~ ${NORMALIZED_CODE}`)
    .addCheckConstraint("assets_asset_kind_check", sql`asset_kind in ('fiat', 'crypto', 'other')`)
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("wallets")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("account_id", "uuid", (column) => column.notNull())
    .addColumn("asset_id", "uuid", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("wallets_pkey", ["id"])
    .addUniqueConstraint("wallets_account_id_asset_id_key", ["account_id", "asset_id"])
    .addForeignKeyConstraint("wallets_account_id_fkey", ["account_id"], "platform.accounts", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .addForeignKeyConstraint("wallets_asset_id_fkey", ["asset_id"], "platform.assets", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .execute();

  for (const table of ["assets", "wallets"]) {
    await sql.raw(`
      create trigger ${table}_set_updated_at
      before update on platform.${table}
      for each row execute function platform.set_catalog_updated_at()
    `).execute(database);
  }
}
