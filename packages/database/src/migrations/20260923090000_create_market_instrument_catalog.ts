import { sql, type Kysely } from "kysely";

const NORMALIZED_CODE = sql.raw("'^[a-z0-9]+(?:-[a-z0-9]+)*$'");

/** Creates the platform-owned market, instrument, provider, and symbol catalog. */
export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .withSchema("platform")
    .createTable("markets")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("market_code", "varchar(63)", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("markets_pkey", ["id"])
    .addUniqueConstraint("markets_market_code_key", ["market_code"])
    .addCheckConstraint("markets_market_code_format_check", sql`market_code ~ ${NORMALIZED_CODE}`)
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("providers")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("provider_code", "varchar(63)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("providers_pkey", ["id"])
    .addUniqueConstraint("providers_provider_code_key", ["provider_code"])
    .addCheckConstraint("providers_provider_code_format_check", sql`provider_code ~ ${NORMALIZED_CODE}`)
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("instruments")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("market_id", "uuid", (column) => column.notNull())
    .addColumn("instrument_code", "varchar(63)", (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("instruments_pkey", ["id"])
    .addUniqueConstraint("instruments_market_id_instrument_code_key", ["market_id", "instrument_code"])
    .addCheckConstraint("instruments_instrument_code_format_check", sql`instrument_code ~ ${NORMALIZED_CODE}`)
    .addForeignKeyConstraint("instruments_market_id_fkey", ["market_id"], "platform.markets", ["id"], (constraint) =>
      constraint.onDelete("restrict")
    )
    .execute();

  await database.schema
    .withSchema("platform")
    .createTable("provider_instrument_symbols")
    .addColumn("id", "uuid", (column) => column.notNull().defaultTo(sql`uuidv7()`))
    .addColumn("provider_id", "uuid", (column) => column.notNull())
    .addColumn("instrument_id", "uuid", (column) => column.notNull())
    .addColumn("provider_symbol", sql`text collate "C"`, (column) => column.notNull())
    .addColumn("enabled", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`current_timestamp`))
    .addPrimaryKeyConstraint("provider_instrument_symbols_pkey", ["id"])
    .addUniqueConstraint("provider_instrument_symbols_provider_id_instrument_id_key", ["provider_id", "instrument_id"])
    .addUniqueConstraint("provider_instrument_symbols_provider_id_provider_symbol_key", ["provider_id", "provider_symbol"])
    .addForeignKeyConstraint(
      "provider_instrument_symbols_provider_id_fkey",
      ["provider_id"],
      "platform.providers",
      ["id"],
      (constraint) => constraint.onDelete("restrict")
    )
    .addForeignKeyConstraint(
      "provider_instrument_symbols_instrument_id_fkey",
      ["instrument_id"],
      "platform.instruments",
      ["id"],
      (constraint) => constraint.onDelete("restrict")
    )
    .execute();

  await database.schema.withSchema("platform").createIndex("markets_enabled_lookup_idx").on("markets").column("enabled").execute();
  await database.schema
    .withSchema("platform")
    .createIndex("instruments_market_enabled_lookup_idx")
    .on("instruments")
    .columns(["market_id", "enabled"])
    .execute();
  await database.schema
    .withSchema("platform")
    .createIndex("provider_instrument_symbols_provider_enabled_lookup_idx")
    .on("provider_instrument_symbols")
    .columns(["provider_id", "enabled"])
    .execute();
  await database.schema
    .withSchema("platform")
    .createIndex("provider_instrument_symbols_instrument_enabled_lookup_idx")
    .on("provider_instrument_symbols")
    .columns(["instrument_id", "enabled"])
    .execute();

  await sql.raw(`
    create function platform.set_catalog_updated_at()
    returns trigger
    language plpgsql
    as $$
    begin
      new.updated_at = current_timestamp;
      return new;
    end;
    $$;
  `).execute(database);
  for (const table of ["markets", "providers", "instruments", "provider_instrument_symbols"]) {
    await sql.raw(`
      create trigger ${table}_set_updated_at
      before update on platform.${table}
      for each row execute function platform.set_catalog_updated_at()
    `).execute(database);
  }
}
