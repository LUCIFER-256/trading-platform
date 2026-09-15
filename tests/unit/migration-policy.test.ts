import { readdirSync } from "node:fs";
import * as path from "node:path";
import { MIGRATION_NAME_PATTERN } from "../../packages/database/src";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const migrationDirectory = path.join(__dirname, "../../packages/database/src/migrations");
const migrationFiles = readdirSync(migrationDirectory).filter((file) => file.endsWith(".js")).sort();
assert(migrationFiles.length > 0, "At least one migration must exist.");
assert(
  migrationFiles.every((file) => MIGRATION_NAME_PATTERN.test(file.slice(0, -3))),
  "Migration names must use YYYYMMDDHHMMSS_descriptive_snake_case."
);
assert(
  migrationFiles.every((file, index) => index === 0 || migrationFiles[index - 1]! < file),
  "Migration files must be in strict lexical order."
);

for (const migrationFile of migrationFiles) {
  const migration = require(path.join(migrationDirectory, migrationFile)) as { up?: unknown; down?: unknown };
  assert(typeof migration.up === "function", `${migrationFile} must export up.`);
  assert(migration.down === undefined, `${migrationFile} must not export down.`);
}

console.log("Migration policy unit tests passed.");
