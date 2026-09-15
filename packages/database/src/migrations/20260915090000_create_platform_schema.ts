import type { Kysely } from "kysely";

/** Creates only the application-owned namespace; business tables are deferred to later sprints. */
export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema.createSchema("platform").ifNotExists().execute();
}
