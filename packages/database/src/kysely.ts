import type { Kysely, Transaction } from "kysely";

/**
 * Intentionally empty: Sprint 2.2 creates no schema, migration metadata, or
 * business table. Future table typings are added only with approved migrations.
 */
export interface DatabaseSchema {}

/** The database package's Kysely client type. */
export type KyselyDatabase = Kysely<DatabaseSchema>;

/** A Kysely context pinned to one PostgreSQL transaction connection. */
export type DatabaseTransaction = Transaction<DatabaseSchema>;
