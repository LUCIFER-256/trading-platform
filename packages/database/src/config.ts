import type { RuntimeMode } from "../../core/src";

export type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;
export type DatabaseSslMode = "disable" | "require" | "verify-ca" | "verify-full";

export interface DatabaseConfigurationInput {
  readonly runtimeMode: RuntimeMode;
  readonly environment: DatabaseEnvironment;
}

/**
 * This is deliberately a non-secret configuration summary. The connection URL
 * is validated and then discarded; Sprint 2.2 uses it only inside the
 * internal driver-construction boundary.
 */
export interface DatabaseConfiguration {
  readonly runtimeMode: RuntimeMode;
  readonly connectionSource: "DATABASE_URL" | "TEST_DATABASE_URL";
  readonly ssl: {
    readonly mode: DatabaseSslMode;
    readonly caPath?: string;
  };
  readonly poolMax?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly transactionTimeoutMs?: number;
  readonly applicationName?: string;
}

export type DatabaseConfigurationErrorCode =
  | "MISSING_DATABASE_URL"
  | "MISSING_TEST_DATABASE_URL"
  | "INVALID_DATABASE_URL"
  | "INVALID_NUMERIC_CONFIGURATION"
  | "INVALID_SSL_CONFIGURATION"
  | "INVALID_APPLICATION_NAME";

/** Errors intentionally contain no environment values or credentials. */
export class DatabaseConfigurationError extends Error {
  readonly name = "DatabaseConfigurationError";

  constructor(readonly code: DatabaseConfigurationErrorCode) {
    super(configurationMessage(code));
  }

  toJSON(): Readonly<{ name: string; code: DatabaseConfigurationErrorCode; message: string }> {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export function loadDatabaseConfiguration(input: DatabaseConfigurationInput): DatabaseConfiguration {
  const connectionSource = input.runtimeMode === "test" ? "TEST_DATABASE_URL" : "DATABASE_URL";
  validatePostgresUrl(input.environment[connectionSource], connectionSource);

  const ssl = parseSslConfiguration(input.environment);
  const applicationName = parseApplicationName(input.environment.DATABASE_APPLICATION_NAME);
  const poolMax = parseOptionalPositiveInteger(input.environment.DATABASE_POOL_MAX);
  const connectionTimeoutMs = parseOptionalPositiveInteger(input.environment.DATABASE_CONNECTION_TIMEOUT_MS);
  const idleTimeoutMs = parseOptionalPositiveInteger(input.environment.DATABASE_IDLE_TIMEOUT_MS);
  const statementTimeoutMs = parseOptionalPositiveInteger(input.environment.DATABASE_STATEMENT_TIMEOUT_MS);
  const lockTimeoutMs = parseOptionalPositiveInteger(input.environment.DATABASE_LOCK_TIMEOUT_MS);
  const transactionTimeoutMs = parseOptionalPositiveInteger(input.environment.DATABASE_TRANSACTION_TIMEOUT_MS);

  return {
    runtimeMode: input.runtimeMode,
    connectionSource,
    ssl,
    ...(poolMax === undefined ? {} : { poolMax }),
    ...(connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs }),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(statementTimeoutMs === undefined ? {} : { statementTimeoutMs }),
    ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
    ...(transactionTimeoutMs === undefined ? {} : { transactionTimeoutMs }),
    ...(applicationName === undefined ? {} : { applicationName })
  };
}

function validatePostgresUrl(value: string | undefined, source: "DATABASE_URL" | "TEST_DATABASE_URL"): void {
  if (value === undefined || value.trim() === "") {
    throw new DatabaseConfigurationError(source === "TEST_DATABASE_URL" ? "MISSING_TEST_DATABASE_URL" : "MISSING_DATABASE_URL");
  }

  try {
    const url = new URL(value);
    if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || url.hostname === "" || url.pathname === "/") {
      throw new Error("invalid PostgreSQL URL");
    }
  } catch {
    throw new DatabaseConfigurationError("INVALID_DATABASE_URL");
  }
}

function parseSslConfiguration(environment: DatabaseEnvironment): DatabaseConfiguration["ssl"] {
  const mode = environment.DATABASE_SSL_MODE;
  if (mode !== "disable" && mode !== "require" && mode !== "verify-ca" && mode !== "verify-full") {
    throw new DatabaseConfigurationError("INVALID_SSL_CONFIGURATION");
  }

  const rawCaPath = environment.DATABASE_SSL_CA_PATH;
  const caPath = rawCaPath?.trim();
  if (rawCaPath !== undefined && caPath === "") {
    throw new DatabaseConfigurationError("INVALID_SSL_CONFIGURATION");
  }
  if ((mode === "verify-ca" || mode === "verify-full") && caPath === undefined) {
    throw new DatabaseConfigurationError("INVALID_SSL_CONFIGURATION");
  }
  if (mode === "disable" && caPath !== undefined) {
    throw new DatabaseConfigurationError("INVALID_SSL_CONFIGURATION");
  }

  return caPath === undefined ? { mode } : { mode, caPath };
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new DatabaseConfigurationError("INVALID_NUMERIC_CONFIGURATION");

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new DatabaseConfigurationError("INVALID_NUMERIC_CONFIGURATION");
  return parsed;
}

function parseApplicationName(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (/[^\x20-\x7E]/.test(value)) throw new DatabaseConfigurationError("INVALID_APPLICATION_NAME");
  return value;
}

function configurationMessage(code: DatabaseConfigurationErrorCode): string {
  switch (code) {
    case "MISSING_DATABASE_URL":
      return "DATABASE_URL is required outside test mode.";
    case "MISSING_TEST_DATABASE_URL":
      return "TEST_DATABASE_URL is required in test mode.";
    case "INVALID_DATABASE_URL":
      return "Database connection URL is invalid.";
    case "INVALID_NUMERIC_CONFIGURATION":
      return "Database numeric configuration is invalid.";
    case "INVALID_SSL_CONFIGURATION":
      return "Database SSL configuration is invalid.";
    case "INVALID_APPLICATION_NAME":
      return "Database application name is invalid.";
  }
}
