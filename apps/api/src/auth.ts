import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { sql, type KyselyDatabase } from "../../../packages/database/src";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export const PRODUCTION_ARGON2ID_PARAMETERS = Object.freeze({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
const TEST_ARGON2ID_PARAMETERS = Object.freeze({ memoryCost: 1024, timeCost: 1, parallelism: 1 });
const UNKNOWN_USER_HASH = "$argon2id$v=19$m=19456,p=1,t=2$NI4UO6sfp6JQ9i/1kWYXJg$R7tQbWsCUzNgonoyGoWWr8or4RkkO4GY2YafklRWo5w";

function createHasher(parameters: Readonly<{ memoryCost: number; timeCost: number; parallelism: number }>): PasswordHasher {
  return {
    hash: (password) => argon2.hash(password, { type: argon2.argon2id, ...parameters }),
    verify: (hash, password) => argon2.verify(hash, password)
  };
}

/** Production callers must use this fixed-policy factory; it accepts no configuration. */
export function createProductionPasswordHasher(): PasswordHasher {
  return createHasher(PRODUCTION_ARGON2ID_PARAMETERS);
}

/** Test-only injection point for repeated verification/lockout exercises. */
export function createTestPasswordHasher(): PasswordHasher {
  return createHasher(TEST_ARGON2ID_PARAMETERS);
}

export function createOpaqueSecret(): string {
  return randomBytes(32).toString("base64url");
}

export interface AuthenticatedSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionSecret: string;
}

export async function authenticateAndCreateSession(
  database: KyselyDatabase,
  userCode: string,
  password: string,
  hasher: PasswordHasher = createProductionPasswordHasher()
): Promise<AuthenticatedSession | undefined> {
  const row = await sql<{ readonly id: string; readonly password_hash: string; readonly credential_version: number }>`
    select login_user.id, credential.password_hash, credential.credential_version
    from platform.users login_user join platform.password_credentials credential on credential.user_id = login_user.id
    where login_user.user_code = ${userCode} and login_user.enabled and coalesce(login_user.password_login_locked_until, '-infinity'::timestamptz) <= current_timestamp
  `.execute(database);
  const principal = row.rows[0];
  const verified = await hasher.verify(principal?.password_hash ?? UNKNOWN_USER_HASH, password);
  if (principal === undefined || !verified) {
    await sql`select platform.record_failed_password_login(${userCode})`.execute(database);
    return undefined;
  }
  await sql`select platform.record_successful_password_login(${principal.id})`.execute(database);
  const sessionSecret = createOpaqueSecret();
  const session = await sql<{ readonly id: string }>`
    select platform.create_auth_session(${principal.id}, ${sessionSecret}, ${principal.credential_version}, current_timestamp + interval '30 minutes', current_timestamp + interval '8 hours') as id
  `.execute(database);
  const sessionId = session.rows[0]?.id;
  if (sessionId === undefined) throw new Error("Session creation did not return an identifier.");
  return { userId: principal.id, sessionId, sessionSecret };
}

/** Legacy CLI entry point; HTTP transport uses the same authority service. */
export const authenticateAndCreateCommandSession = authenticateAndCreateSession;

export async function revokeCommandSession(database: KyselyDatabase, sessionId: string): Promise<void> {
  await sql`select platform.revoke_auth_session(${sessionId}, 'cli_completed')`.execute(database);
}
