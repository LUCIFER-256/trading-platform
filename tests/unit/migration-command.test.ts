import {
  assertMigrationTargetAuthorized,
  LiveMigrationAuthorizationError,
  type DatabaseEnvironment
} from "../../packages/database/src";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectDenied(action: () => void): void {
  try {
    action();
    throw new Error("Expected migration authorization failure.");
  } catch (error) {
    assert(error instanceof LiveMigrationAuthorizationError, "Expected a safe migration authorization failure.");
  }
}

const development: DatabaseEnvironment = { MIGRATION_TARGET: "development" };
assertMigrationTargetAuthorized("development", development);
expectDenied(() => assertMigrationTargetAuthorized("live", { MIGRATION_TARGET: "live" }));
expectDenied(() => assertMigrationTargetAuthorized("live", { MIGRATION_TARGET: "development", MIGRATIONS_LIVE_APPROVED: "approved", MIGRATION_RELEASE_ID: "release-1" }));
assertMigrationTargetAuthorized("live", {
  MIGRATION_TARGET: "live",
  MIGRATIONS_LIVE_APPROVED: "approved",
  MIGRATION_RELEASE_ID: "release-20260915"
});

console.log("Migration command unit tests passed.");
