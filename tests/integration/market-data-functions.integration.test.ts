import * as path from "node:path";
import { Client as PgClient } from "pg";
import {
  appendMarketDataObservation,
  appendMarketDataQualityBucket,
  applyMarketDataCatalogManifest,
  clearMarketDataHalt,
  createDatabaseClient,
  marketDataStartupRecovery,
  openMarketDataHalt,
  runPendingMigrations,
  sql,
  type DatabaseClient,
  type DatabaseEnvironment
} from "../../packages/database/src";
import { createTestPasswordHasher } from "../../apps/api/src/auth";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function rejected(action: () => Promise<unknown>, expected: string, message: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    assert(
      candidate.code === expected || (typeof candidate.message === "string" && candidate.message.includes(expected)),
      `${message}: expected ${expected}, received ${String(candidate.code)} ${String(candidate.message)}`
    );
    return;
  }
  throw new Error(`${message}: expected rejection ${expected}.`);
}

function environment(): DatabaseEnvironment {
  if (process.env.TEST_DATABASE_URL === undefined) throw new Error("TEST_DATABASE_URL is required.");
  return { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE };
}

interface Fixture {
  readonly providerId: string;
  readonly instrumentId: string;
  readonly sessionId: string;
  readonly secret: string;
}

function observation(data: Fixture, tradeId: string, eventAtUs = "1760698800123456", price = "100.000000000000000000") {
  return {
    providerId: data.providerId,
    instrumentId: data.instrumentId,
    providerSymbol: "SYNTH-USD",
    providerSequence: tradeId,
    tradeId,
    eventAtUs,
    receivedAt: new Date(),
    bid: "99.000000000000000000",
    bidSize: "1.000000000000000000",
    ask: "101.000000000000000000",
    askSize: "1.000000000000000000",
    lastPrice: price,
    lastSize: "1.000000000000000000",
    volume24h: "0"
  };
}

async function fixture(client: DatabaseClient, suffix: string): Promise<Fixture> {
  const market = await sql<{ id: string }>`insert into platform.markets(market_code,enabled) values (${`md-market-${suffix}`},true) returning id`.execute(client.database);
  const provider = await sql<{ id: string }>`insert into platform.providers(provider_code,enabled) values (${`md-provider-${suffix}`},true) returning id`.execute(client.database);
  const instrument = await sql<{ id: string }>`insert into platform.instruments(market_id,instrument_code,enabled,price_increment,size_increment) values (${market.rows[0]!.id},${`md-instrument-${suffix}`},true,'0.01','0.00000001') returning id`.execute(client.database);
  await sql`insert into platform.provider_instrument_symbols(provider_id,instrument_id,provider_symbol,enabled) values (${provider.rows[0]!.id},${instrument.rows[0]!.id},'SYNTH-USD',true)`.execute(client.database);
  await sql`insert into platform.market_data_policies(instrument_id,enabled,max_ingestion_age_ms,max_event_age_ms,max_future_skew_ms) values (${instrument.rows[0]!.id},true,600000,600000,60000)`.execute(client.database);
  const user = await sql<{ id: string }>`insert into platform.users(user_code,enabled) values (${`md-admin-${suffix}`},true) returning id`.execute(client.database);
  const passwordHash = await createTestPasswordHasher().hash("integration-password");
  await sql`insert into platform.password_credentials(user_id,password_hash,credential_version) values (${user.rows[0]!.id},${passwordHash},1)`.execute(client.database);
  await sql`insert into platform.account_role_assignments(user_id,account_id,role,enabled) values (${user.rows[0]!.id},null,'SUPER_ADMIN',true)`.execute(client.database);
  const secret = `market-data-${suffix}-session-secret-sufficiently-long`;
  const session = await sql<{ id: string }>`select platform.create_auth_session(${user.rows[0]!.id},${secret},1,clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '8 hours') as id`.execute(client.database);
  return { providerId: provider.rows[0]!.id, instrumentId: instrument.rows[0]!.id, sessionId: session.rows[0]!.id, secret };
}

async function clearPriceHalt(client: DatabaseClient, data: Fixture, candidate: string): Promise<string> {
  const haltId = await openMarketDataHalt(client.database, { providerId: data.providerId, instrumentId: data.instrumentId, reasonCode: "PRICE_JUMP", eventAtUs: "1760698800123456", tradeId: "10", providerSequence: "10", candidatePrice: candidate, candidateSize: "1", referencePrice: "100" });
  await clearMarketDataHalt(client.database, { sessionId: data.sessionId, sessionSecret: data.secret, haltId, instrumentId: data.instrumentId, resolutionReason: "synthetic review", typedCandidatePrice: candidate });
  return haltId;
}

async function assertPriceJumpAtomic(client: DatabaseClient, data: Fixture, tradeId: string, resultHaltId: string, expectedReference: string): Promise<void> {
  const row = await sql<{ halt: string; quality: string; observations: string; consumptions: string; state: string; reference_price: string }>`
    select
      (select count(*)::text from platform.market_data_halts where id=${resultHaltId}) halt,
      (select count(*)::text from platform.market_data_quality_events q join platform.market_data_halts h on h.quality_event_id=q.id where h.id=${resultHaltId} and q.reason_code='PRICE_JUMP') quality,
      (select count(*)::text from platform.market_data_observations where instrument_id=${data.instrumentId} and trade_id=${tradeId}) observations,
      (select count(*)::text from platform.market_data_jump_reset_consumptions c join platform.market_data_jump_resets r on r.id=c.reset_id where r.instrument_id=${data.instrumentId}) consumptions,
      (select base_availability from platform.market_data_instrument_state where instrument_id=${data.instrumentId}) state,
      (select reference_price::text from platform.market_data_halts where id=${resultHaltId}) reference_price
  `.execute(client.database);
  const value = row.rows[0];
  assert(value?.halt === "1" && value.quality === "1", "PRICE_JUMP must write its halt and quality event.");
  assert(value.observations === "0" && value.consumptions === "0", "PRICE_JUMP must not write an observation or consumption.");
  assert(value.state === "UNAVAILABLE_HUMAN_HALT" && value.reference_price === expectedReference, "PRICE_JUMP state and reference must be atomic.");
}

async function outOfBandResetWithNoAcceptedPriceStillWritesHalt(client: DatabaseClient, data: Fixture): Promise<void> {
  await clearPriceHalt(client, data, "125.000000000000000000");
  const result = await appendMarketDataObservation(client.database, observation(data, "101", undefined, "150.000000000000000000"));
  assert(result.outcome === "PRICE_JUMP_HALT" && result.haltId !== null, "out-of-band reset without observation must halt.");
  await assertPriceJumpAtomic(client, data, "101", result.haltId, "125.000000000000000000");
}

async function outOfBandOrExpiredResetWritesPriceJumpHaltAtomically(client: DatabaseClient, data: Fixture): Promise<void> {
  await appendMarketDataObservation(client.database, observation(data, "201", undefined, "100.000000000000000000"));
  await clearPriceHalt(client, data, "125.000000000000000000");
  const outside = await appendMarketDataObservation(client.database, observation(data, "202", undefined, "150.000000000000000000"));
  assert(outside.outcome === "PRICE_JUMP_HALT" && outside.haltId !== null, "out-of-band reset must halt.");
  await assertPriceJumpAtomic(client, data, "202", outside.haltId, "100.000000000000000000");

  const second = await fixture(client, "expired-reset");
  await appendMarketDataObservation(client.database, observation(second, "211", undefined, "100.000000000000000000"));
  await sql`update platform.market_data_policies set jump_reset_ttl_ms=1000 where instrument_id=${second.instrumentId}`.execute(client.database);
  await clearPriceHalt(client, second, "125.000000000000000000");
  await sql`select pg_sleep(1.01)`.execute(client.database);
  const expired = await appendMarketDataObservation(client.database, observation(second, "212", undefined, "125.000000000000000000"));
  assert(expired.outcome === "PRICE_JUMP_HALT" && expired.haltId !== null, "expired reset must halt.");
  await assertPriceJumpAtomic(client, second, "212", expired.haltId, "100.000000000000000000");
}

async function eventAtMicrosecondRegression(client: DatabaseClient, data: Fixture): Promise<void> {
  const values = ["0", "1", "999999", "1000000", "1760698800123456", "9007199254740993", "253402300799999998", "253402300799999999"];
  for (const [index, eventAtUs] of values.entries()) {
    const result = await appendMarketDataObservation(client.database, observation(data, `${300 + index}`, eventAtUs));
    assert(result.outcome === "ACCEPTED" && result.observationId !== null, `microsecond ${eventAtUs} must be accepted.`);
    const row = await sql<{ event_at_us: string; event_at: string }>`select event_at_us::text,to_char(event_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') event_at from platform.market_data_observations where id=${result.observationId}`.execute(client.database);
    const seconds = BigInt(eventAtUs) / 1000000n;
    const fraction = (BigInt(eventAtUs) % 1000000n).toString().padStart(6, "0");
    const expected = `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
    assert(row.rows[0]?.event_at_us === eventAtUs && row.rows[0]?.event_at === expected, `microsecond ${eventAtUs} must round-trip exactly.`);
  }
}

async function olderUnconsumedResetNotResurrectedAfterNewerConsumed(client: DatabaseClient, data: Fixture): Promise<void> {
  await clearPriceHalt(client, data, "125.000000000000000000");
  await clearPriceHalt(client, data, "130.000000000000000000");
  let recovery = await marketDataStartupRecovery(client.database, data.instrumentId);
  assert(recovery?.confirmedCandidatePrice === "130.000000000000000000", "R2 must be returned before consumption.");
  const accepted = await appendMarketDataObservation(client.database, observation(data, "401", undefined, "130.000000000000000000"));
  assert(accepted.outcome === "ACCEPTED", "R2-priced tick must be accepted and consume R2.");
  recovery = await marketDataStartupRecovery(client.database, data.instrumentId);
  assert(recovery?.resetId === null, "consumed R2 must suppress older R1 during recovery.");
  const ordinary = await appendMarketDataObservation(client.database, observation(data, "402", undefined, "125.000000000000000000"));
  assert(ordinary.outcome === "ACCEPTED", "older R1 must not be resurrected.");
  const count = await sql<{ count: string }>`select count(*)::text count from platform.market_data_jump_reset_consumptions c join platform.market_data_jump_resets r on r.id=c.reset_id where r.instrument_id=${data.instrumentId}`.execute(client.database);
  assert(count.rows[0]?.count === "1", "only R2 must have a consumption row.");
}

async function idempotencyConflictWritesHaltAtomicallyAndReturnsConflictResult(client: DatabaseClient, data: Fixture): Promise<void> {
  await appendMarketDataObservation(client.database, observation(data, "500"));
  const result = await appendMarketDataObservation(client.database, { ...observation(data, "500"), lastPrice: "101.000000000000000000" });
  assert(result.outcome === "IDEMPOTENCY_CONFLICT" && result.haltId !== null && result.observationId === null, "conflict result invariant must hold.");
  const row = await sql<{ halts: string; events: string; observations: string }>`
    select
      (select count(*)::text from platform.market_data_halts where id=${result.haltId}) halts,
      (select count(*)::text from platform.market_data_quality_events q join platform.market_data_halts h on h.quality_event_id=q.id where h.id=${result.haltId} and q.reason_code='IDEMPOTENCY_CONFLICT') events,
      (select count(*)::text from platform.market_data_observations where instrument_id=${data.instrumentId} and trade_id='500') observations
  `.execute(client.database);
  assert(row.rows[0]?.halts === "1" && row.rows[0]?.events === "1" && row.rows[0]?.observations === "1", "idempotency conflict must be atomic and not raise 23505.");
}

async function qualityBucketNullInstrumentAndFlushRetryDoesNotDoubleCount(client: DatabaseClient, data: Fixture): Promise<void> {
  const flushId = "00000000-0000-7000-8000-000000000001";
  const request = { flushId, providerId: data.providerId, instrumentId: null, reasonCode: "MALFORMED", bucketStartedAt: new Date("2026-10-17T00:00:00Z"), count: 2n };
  await appendMarketDataQualityBucket(client.database, request);
  await appendMarketDataQualityBucket(client.database, request);
  const row = await sql<{ rejected_count: string }>`select rejected_count::text from platform.market_data_quality_buckets where provider_id=${data.providerId} and instrument_id is null`.execute(client.database);
  assert(row.rows[0]?.rejected_count === "2", "same flush id must not double count a null-instrument bucket.");
}

async function clearWithRealSessionWritesResolutionAuditAndRebaselines(client: DatabaseClient, data: Fixture): Promise<void> {
  const haltId = await openMarketDataHalt(client.database, { providerId: data.providerId, instrumentId: data.instrumentId, reasonCode: "PRICE_JUMP", eventAtUs: "1760698800123456", tradeId: "600", providerSequence: "600", candidatePrice: "125", candidateSize: "1", referencePrice: "100" });
  await rejected(() => clearMarketDataHalt(client.database, { sessionId: data.sessionId, sessionSecret: data.secret, haltId, instrumentId: data.instrumentId, resolutionReason: "wrong", typedCandidatePrice: "124" }), "22023", "wrong typed candidate");
  await clearMarketDataHalt(client.database, { sessionId: data.sessionId, sessionSecret: data.secret, haltId, instrumentId: data.instrumentId, resolutionReason: "reviewed", typedCandidatePrice: "125" });
  const row = await sql<{ audit: string; state: string }>`select (select count(*)::text from platform.audit_events where event_type='market_data_halt_cleared' and metadata->>'halt_id'=${haltId}) audit,(select base_availability from platform.market_data_instrument_state where instrument_id=${data.instrumentId}) state`.execute(client.database);
  assert(row.rows[0]?.audit === "1" && row.rows[0]?.state === "UNAVAILABLE_REBASELINING", "clear audit must be scoped to this halt and rebaseline.");
  await rejected(() => clearMarketDataHalt(client.database, { sessionId: data.sessionId, sessionSecret: data.secret, haltId, instrumentId: data.instrumentId, resolutionReason: "again", typedCandidatePrice: "125" }), "23514", "second resolution");
}

async function effectiveStateUsesDatabaseClock(client: DatabaseClient, data: Fixture): Promise<void> {
  await appendMarketDataObservation(client.database, observation(data, "690", (BigInt(Date.now()) * 1000n).toString()));
  await sql`update platform.market_data_policies set max_ingestion_age_ms=5000,max_event_age_ms=5000,max_future_skew_ms=5000 where instrument_id=${data.instrumentId}`.execute(client.database);
  await sql`update platform.market_data_instrument_state set base_availability='AVAILABLE',event_at=clock_timestamp(),ingested_at=clock_timestamp(),last_accepted_price=1 where instrument_id=${data.instrumentId}`.execute(client.database);
  const available = await sql<{ availability: string }>`select availability from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(client.database);
  assert(available.rows[0]?.availability === "AVAILABLE", "fresh state must be available.");
  await sql`update platform.market_data_instrument_state set event_at=clock_timestamp()-interval '10 seconds' where instrument_id=${data.instrumentId}`.execute(client.database);
  assert((await sql<{ availability: string }>`select availability from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(client.database)).rows[0]?.availability === "UNAVAILABLE_STALE", "event age must be stale.");
  await sql`update platform.market_data_instrument_state set event_at=clock_timestamp(),ingested_at=clock_timestamp()-interval '10 seconds' where instrument_id=${data.instrumentId}`.execute(client.database);
  assert((await sql<{ availability: string }>`select availability from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(client.database)).rows[0]?.availability === "UNAVAILABLE_STALE", "ingestion age must be stale.");
  await sql`update platform.market_data_instrument_state set ingested_at=clock_timestamp(),event_at=clock_timestamp()+interval '60 seconds' where instrument_id=${data.instrumentId}`.execute(client.database);
  assert((await sql<{ availability: string }>`select availability from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(client.database)).rows[0]?.availability === "UNAVAILABLE_CLOCK_ANOMALY", "future event must be anomalous.");
  await rejected(() => sql`update platform.market_data_instrument_state set base_availability='AVAILABLE',event_at=null,ingested_at=clock_timestamp() where instrument_id=${data.instrumentId}`.execute(client.database), "23514", "AVAILABLE with null event_at");
  await rejected(() => sql`update platform.market_data_instrument_state set base_availability='AVAILABLE',event_at=clock_timestamp(),ingested_at=null where instrument_id=${data.instrumentId}`.execute(client.database), "23514", "AVAILABLE with null ingested_at");
  await sql`update platform.market_data_instrument_state set base_availability='UNAVAILABLE_REBASELINING',event_at=null,ingested_at=null where instrument_id=${data.instrumentId}`.execute(client.database);
  assert((await sql<{ availability: string }>`select availability from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(client.database)).rows[0]?.availability === "UNAVAILABLE_REBASELINING", "allowed unavailable state with null timestamps must remain unavailable.");
  await sql`update platform.market_data_policies set max_ingestion_age_ms=1000,max_event_age_ms=1000,max_future_skew_ms=5000 where instrument_id=${data.instrumentId}`.execute(client.database);
  await client.database.transaction().execute(async (transaction) => {
    await sql`update platform.market_data_instrument_state set base_availability='AVAILABLE',event_at=clock_timestamp(),ingested_at=clock_timestamp() where instrument_id=${data.instrumentId}`.execute(transaction);
    assert((await sql<{ availability: string }>`select availability from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(transaction)).rows[0]?.availability === "AVAILABLE", "clock_timestamp must be fresh in one transaction.");
    await sql`select pg_sleep(1.2)`.execute(transaction);
    assert((await sql<{ availability: string }>`select availability from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(transaction)).rows[0]?.availability === "UNAVAILABLE_STALE", "clock_timestamp must advance in one transaction.");
  });
  await sql`update platform.market_data_policies set enabled=false where instrument_id=${data.instrumentId}`.execute(client.database);
  assert((await sql<{ availability: string }>`select availability from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(client.database)).rows[0]?.availability === "UNAVAILABLE_DISABLED_SCOPE", "disabled policy must be unavailable.");
  await sql`delete from platform.market_data_policies where instrument_id=${data.instrumentId}`.execute(client.database);
  assert((await sql<{ availability: string }>`select availability from platform.market_data_effective_state where instrument_id=${data.instrumentId}`.execute(client.database)).rows.length === 0, "missing policy must produce no effective-state row.");
}

async function concurrentHaltOpenAndClearSerialized(client: DatabaseClient, data: Fixture): Promise<void> {
  const haltId = await openMarketDataHalt(client.database, { providerId: data.providerId, instrumentId: data.instrumentId, reasonCode: "LOCKED_OR_CROSSED", eventAtUs: "1760698800123456", tradeId: "700", providerSequence: "700", candidatePrice: null, candidateSize: null, referencePrice: null });
  const connectionA = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
  const connectionB = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
  await connectionA.connect();
  await connectionB.connect();
  try {
    await connectionA.query("begin");
    await connectionA.query("select 1 from platform.market_data_instrument_state where instrument_id=$1 for update", [data.instrumentId]);
    let finished = false;
    const pending = connectionB.query("select * from platform.clear_market_data_halt($1,$2,$3,$4,$5,$6)", [data.sessionId, data.secret, haltId, data.instrumentId, "serialized", null]).then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(!finished, "connection B clear must wait on connection A's instrument-state lock.");
    await connectionA.query("commit");
    await pending;
    const state = await sql<{ state: string; resolutions: string }>`select (select base_availability from platform.market_data_instrument_state where instrument_id=${data.instrumentId}) state,(select count(*)::text from platform.market_data_halt_resolutions where halt_id=${haltId}) resolutions`.execute(client.database);
    assert(state.rows[0]?.resolutions === "1" && state.rows[0]?.state === "UNAVAILABLE_REBASELINING", "serialized operations must leave one consistent resolution.");
  } finally {
    await connectionA.query("rollback").catch(() => undefined);
    await connectionA.end();
    await connectionB.end();
  }
}

async function notifyOccursOnlyAfterCommit(client: DatabaseClient, data: Fixture): Promise<void> {
  const listener = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
  await listener.connect();
  const payloads: string[] = [];
  listener.on("notification", (message) => { if (message.channel === "market_data_changed") payloads.push(message.payload ?? ""); });
  try {
    await listener.query("listen market_data_changed");
    await client.database.transaction().execute(async (transaction) => {
      await appendMarketDataObservation(transaction, observation(data, "801", (BigInt(Date.now()) * 1000n).toString()));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert(payloads.length === 0, "NOTIFY must not arrive before commit.");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(payloads.filter((payload) => payload === data.instrumentId).length === 1, "exactly one notification must arrive after commit.");
  } finally {
    await listener.end();
  }
}

async function nonSuperAdminClearRejected(client: DatabaseClient, data: Fixture): Promise<void> {
  const haltId = await openMarketDataHalt(client.database, { providerId: data.providerId, instrumentId: data.instrumentId, reasonCode: "LOCKED_OR_CROSSED", eventAtUs: "1760698800123456", tradeId: "820", providerSequence: "820", candidatePrice: null, candidateSize: null, referencePrice: null });
  async function sessionFor(label: string, role: "ADMIN" | "SUPER_ADMIN" | null, roleEnabled: boolean): Promise<{ sessionId: string; secret: string }> {
    const user = await sql<{ id: string }>`insert into platform.users(user_code,enabled) values (${`${label}-${data.instrumentId}`},true) returning id`.execute(client.database);
    const passwordHash = await createTestPasswordHasher().hash("integration-password");
    await sql`insert into platform.password_credentials(user_id,password_hash,credential_version) values (${user.rows[0]!.id},${passwordHash},1)`.execute(client.database);
    if (role === "ADMIN") {
      const account = await sql<{ id: string }>`insert into platform.accounts(user_id,account_code,enabled) values (${user.rows[0]!.id},${`${label}-account`},true) returning id`.execute(client.database);
      await sql`insert into platform.account_role_assignments(user_id,account_id,role,enabled) values (${user.rows[0]!.id},${account.rows[0]!.id},${role},${roleEnabled})`.execute(client.database);
    }
    if (role === "SUPER_ADMIN") await sql`insert into platform.account_role_assignments(user_id,account_id,role,enabled,revoked_at,revoked_by_user_id,revocation_reason) values (${user.rows[0]!.id},null,${role},${roleEnabled},clock_timestamp(),${user.rows[0]!.id},'test disabled role')`.execute(client.database);
    const secret = `${label}-session-secret-sufficiently-long`;
    const session = await sql<{ id: string }>`select platform.create_auth_session(${user.rows[0]!.id},${secret},1,clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '8 hours') id`.execute(client.database);
    return { sessionId: session.rows[0]!.id, secret };
  }
  for (const [label, role, roleEnabled] of [["no-role", null, false], ["admin", "ADMIN", true], ["disabled-super-admin", "SUPER_ADMIN", false]] as const) {
    const session = await sessionFor(label, role, roleEnabled);
    await rejected(() => clearMarketDataHalt(client.database, { sessionId: session.sessionId, sessionSecret: session.secret, haltId, instrumentId: data.instrumentId, resolutionReason: "not authorized", typedCandidatePrice: null }), "42501", `${label} clear through N1`);
    const rejectedResolution = await sql<{ count: string }>`select count(*)::text count from platform.market_data_halt_resolutions where halt_id=${haltId}`.execute(client.database);
    assert(rejectedResolution.rows[0]?.count === "0", `${label} rejection must not write a halt resolution.`);
  }
  await clearMarketDataHalt(client.database, { sessionId: data.sessionId, sessionSecret: data.secret, haltId, instrumentId: data.instrumentId, resolutionReason: "super-admin control", typedCandidatePrice: null });
  const successfulResolution = await sql<{ count: string }>`select count(*)::text count from platform.market_data_halt_resolutions where halt_id=${haltId}`.execute(client.database);
  assert(successfulResolution.rows[0]?.count === "1", "SUPER_ADMIN control must clear the halt.");
}

async function secondResolutionForSameHaltRejected(client: DatabaseClient, data: Fixture): Promise<void> {
  const haltId = await openMarketDataHalt(client.database, { providerId: data.providerId, instrumentId: data.instrumentId, reasonCode: "LOCKED_OR_CROSSED", eventAtUs: "1760698800123456", tradeId: "830", providerSequence: "830", candidatePrice: null, candidateSize: null, referencePrice: null });
  const request = { sessionId: data.sessionId, sessionSecret: data.secret, haltId, instrumentId: data.instrumentId, resolutionReason: "reviewed", typedCandidatePrice: null };
  await clearMarketDataHalt(client.database, request);
  await rejected(() => clearMarketDataHalt(client.database, request), "23514", "second resolution for the same halt");
}

async function newestResetWinsOverOlderUnconsumedReset(client: DatabaseClient, data: Fixture): Promise<void> {
  await clearPriceHalt(client, data, "125.000000000000000000");
  await clearPriceHalt(client, data, "130.000000000000000000");
  const recovery = await marketDataStartupRecovery(client.database, data.instrumentId);
  assert(recovery?.confirmedCandidatePrice === "130.000000000000000000", "newest reset must win over older unconsumed reset.");
}

async function manifestNegativeMatrix(client: DatabaseClient): Promise<void> {
  const valid = { manifest_version: 1, provider: { provider_code: "manifest-provider" }, market: { market_code: "manifest-market", enabled: false }, instruments: [{ instrument_code: "manifest-instrument", provider_symbol: "MANIFEST-USD", enabled: false, price_increment: null, size_increment: null, policy: { enabled: false } }] };
  await applyMarketDataCatalogManifest(client.database, valid);
  await applyMarketDataCatalogManifest(client.database, valid);
  const disabled = await sql<{ enabled: boolean; price_increment: string | null; size_increment: string | null }>`select enabled,price_increment::text,size_increment::text from platform.instruments where instrument_code='manifest-instrument'`.execute(client.database);
  assert(disabled.rows[0]?.enabled === false && disabled.rows[0]?.price_increment === null && disabled.rows[0]?.size_increment === null, "disabled instrument without increments is accepted.");
  const enabledControl = { ...valid, instruments: [{ ...valid.instruments[0], enabled: true, price_increment: "0.01", size_increment: "0.00000001", policy: { enabled: true } }] };
  await applyMarketDataCatalogManifest(client.database, enabledControl);
  const enabledIncrement = await sql<{ enabled: boolean; price_increment_matches: boolean; size_increment_matches: boolean }>`select enabled,(price_increment=0.01) price_increment_matches,(size_increment=0.00000001) size_increment_matches from platform.instruments where instrument_code='manifest-instrument'`.execute(client.database);
  assert(enabledIncrement.rows[0]?.enabled === true && enabledIncrement.rows[0]?.price_increment_matches === true && enabledIncrement.rows[0]?.size_increment_matches === true, "enabled instrument with canonical increments is accepted.");
  const trailingZeroControl = { ...enabledControl, instruments: [{ ...enabledControl.instruments[0], price_increment: "0.10" }] };
  await applyMarketDataCatalogManifest(client.database, trailingZeroControl);
  const trailingZero = await sql<{ enabled: boolean; price_increment_matches: boolean }>`select enabled,(price_increment=0.10) price_increment_matches from platform.instruments where instrument_code='manifest-instrument'`.execute(client.database);
  assert(trailingZero.rows[0]?.enabled === true && trailingZero.rows[0]?.price_increment_matches === true, "enabled instrument with trailing-zero increment is accepted.");
  const audit = await sql<{ count: string }>`select count(*)::text count from platform.audit_events where event_type='catalog_manifest_applied'`.execute(client.database);
  assert(audit.rows[0]?.count === "4", "each manifest application, including idempotent applications, must write one audit event.");
  const enabled = { ...valid, instruments: [{ ...valid.instruments[0], enabled: true, price_increment: "0.01", size_increment: "0.00000001", policy: { enabled: true } }] };
  const cases: readonly [string, unknown, string][] = [
    ["absent price increment", { ...enabled, instruments: [{ ...enabled.instruments[0], price_increment: undefined }] }, "22023"],
    ["absent size increment", { ...enabled, instruments: [{ ...enabled.instruments[0], size_increment: undefined }] }, "22023"],
    ["JSON-null increment", { ...enabled, instruments: [{ ...enabled.instruments[0], price_increment: null }] }, "22023"],
    ["number increment", { ...enabled, instruments: [{ ...enabled.instruments[0], price_increment: 0.01 }] }, "22023"],
    ["zero 0", { ...enabled, instruments: [{ ...enabled.instruments[0], price_increment: "0" }] }, "22023"],
    ["zero 0.0", { ...enabled, instruments: [{ ...enabled.instruments[0], price_increment: "0.0" }] }, "22023"],
    ["zero 0.00", { ...enabled, instruments: [{ ...enabled.instruments[0], price_increment: "0.00" }] }, "22023"],
    ["noncanonical leading-zero increment", { ...enabled, instruments: [{ ...enabled.instruments[0], price_increment: "01" }] }, "22023"],
    ["nineteen fractional digits", { ...enabled, instruments: [{ ...enabled.instruments[0], price_increment: "0.0000000000000000001" }] }, "22023"],
    ["missing manifest version", { ...valid, manifest_version: undefined }, "22023"],
    ["missing provider", { ...valid, provider: undefined }, "22023"],
    ["missing market", { ...valid, market: undefined }, "22023"],
    ["missing instruments", { ...valid, instruments: undefined }, "22023"],
    ["missing instrument policy", { ...enabled, instruments: [{ ...enabled.instruments[0], policy: undefined }] }, "22023"],
    ["missing instrument code", { ...enabled, instruments: [{ ...enabled.instruments[0], instrument_code: undefined }] }, "22023"],
    ["unknown root", { ...valid, unexpected: true }, "22023"],
    ["unknown provider", { ...valid, provider: { ...valid.provider, unexpected: true } }, "22023"],
    ["unknown market", { ...valid, market: { ...valid.market, unexpected: true } }, "22023"],
    ["unknown instrument", { ...valid, instruments: [{ ...valid.instruments[0], unexpected: true }] }, "22023"],
    ["unknown policy", { ...valid, instruments: [{ ...valid.instruments[0], policy: { enabled: false, unexpected: true } }] }, "22023"],
    ["uppercase provider code", { ...valid, provider: { provider_code: "MANIFEST-PROVIDER" } }, "22023"],
    ["uppercase market code", { ...valid, market: { ...valid.market, market_code: "MANIFEST-MARKET" } }, "22023"],
    ["uppercase instrument code", { ...valid, instruments: [{ ...valid.instruments[0], instrument_code: "MANIFEST-INSTRUMENT" }] }, "22023"],
    ["policy out of range", { ...enabled, instruments: [{ ...enabled.instruments[0], policy: { enabled: true, max_future_skew_ms: 60001 } }] }, "23514"]
  ];
  for (const [name, invalid, expected] of cases) await rejected(() => applyMarketDataCatalogManifest(client.database, invalid), expected, `manifest ${name}`);
}

async function observationAcceptedAndDuplicateIdentical(client: DatabaseClient, data: Fixture): Promise<void> {
  const request = observation(data, "900", (BigInt(Date.now()) * 1000n).toString());
  const first = await appendMarketDataObservation(client.database, request);
  const duplicate = await appendMarketDataObservation(client.database, request);
  assert(first.outcome === "ACCEPTED" && duplicate.outcome === "DUPLICATE_IDENTICAL", "identical retry must be reported as duplicate-identical.");
}

async function volume24hNullAndZeroAreAccepted(client: DatabaseClient, data: Fixture): Promise<void> {
  const zero = await appendMarketDataObservation(client.database, observation(data, "910", (BigInt(Date.now()) * 1000n).toString()));
  const nil = await appendMarketDataObservation(client.database, { ...observation(data, "911", (BigInt(Date.now()) * 1000n + 1n).toString()), volume24h: null });
  assert(zero.outcome === "ACCEPTED" && nil.outcome === "ACCEPTED", "volume24h zero and null must both be accepted.");
}

async function numeric3818Boundaries(client: DatabaseClient, data: Fixture): Promise<void> {
  const value = "99999999999999999999.999999999999999999";
  const result = await appendMarketDataObservation(client.database, {
    ...observation(data, "920", (BigInt(Date.now()) * 1000n).toString(), value),
    bid: value,
    bidSize: value,
    ask: value,
    askSize: value,
    lastSize: value
  });
  assert(result.outcome === "ACCEPTED", "numeric(38,18) boundary values must be accepted.");
}

async function haltOpenClearOneOpenAndSuperAdminViaN1(client: DatabaseClient, data: Fixture): Promise<void> {
  const haltId = await openMarketDataHalt(client.database, { providerId: data.providerId, instrumentId: data.instrumentId, reasonCode: "LOCKED_OR_CROSSED", eventAtUs: "1760698800123456", tradeId: "930", providerSequence: "930", candidatePrice: null, candidateSize: null, referencePrice: null });
  await rejected(() => openMarketDataHalt(client.database, { providerId: data.providerId, instrumentId: data.instrumentId, reasonCode: "LOCKED_OR_CROSSED", eventAtUs: "1760698800123456", tradeId: "931", providerSequence: "931", candidatePrice: null, candidateSize: null, referencePrice: null }), "55000", "one open halt per instrument");
  await clearMarketDataHalt(client.database, { sessionId: data.sessionId, sessionSecret: data.secret, haltId, instrumentId: data.instrumentId, resolutionReason: "reviewed", typedCandidatePrice: null });
  const authorized = await sql<{ user_id: string }>`select * from platform.require_authenticated_session(${data.sessionId},${data.secret},'market_data.halt.clear',null)`.execute(client.database);
  assert(authorized.rows.length === 1, "SUPER_ADMIN must be authorized for N1 halt clear.");
}

async function run(name: string, action: () => Promise<void>): Promise<void> {
  await action();
  console.log(`${name} passed.`);
}

async function main(): Promise<void> {
  const client = createDatabaseClient({ runtimeMode: "test", environment: environment() });
  const nonce = `${process.pid}${Date.now()}`;
  try {
    await sql`drop schema if exists platform cascade`.execute(client.database);
    await runPendingMigrations(client, { migrationFolder: path.join(__dirname, "../../packages/database/src/migrations"), migrationTableName: `market_data_${nonce}`, migrationLockTableName: `market_data_lock_${nonce}` });
    await run("observationAcceptedAndDuplicateIdentical", () => fixture(client, `${nonce}0`).then((data) => observationAcceptedAndDuplicateIdentical(client, data)));
    await run("volume24hNullAndZeroAreAccepted", () => fixture(client, `${nonce}v`).then((data) => volume24hNullAndZeroAreAccepted(client, data)));
    await run("numeric3818Boundaries", () => fixture(client, `${nonce}n`).then((data) => numeric3818Boundaries(client, data)));
    await run("haltOpenClearOneOpenAndSuperAdminViaN1", () => fixture(client, `${nonce}o`).then((data) => haltOpenClearOneOpenAndSuperAdminViaN1(client, data)));
    await run("outOfBandResetWithNoAcceptedPriceStillWritesHalt", () => fixture(client, `${nonce}a`).then((data) => outOfBandResetWithNoAcceptedPriceStillWritesHalt(client, data)));
    await run("outOfBandOrExpiredResetWritesPriceJumpHaltAtomically", () => fixture(client, `${nonce}b`).then((data) => outOfBandOrExpiredResetWritesPriceJumpHaltAtomically(client, data)));
    await run("eventAtMicrosecondRegression", () => fixture(client, `${nonce}c`).then((data) => eventAtMicrosecondRegression(client, data)));
    await run("olderUnconsumedResetNotResurrectedAfterNewerConsumed", () => fixture(client, `${nonce}d`).then((data) => olderUnconsumedResetNotResurrectedAfterNewerConsumed(client, data)));
    await run("idempotencyConflictWritesHaltAtomicallyAndReturnsConflictResult", () => fixture(client, `${nonce}e`).then((data) => idempotencyConflictWritesHaltAtomicallyAndReturnsConflictResult(client, data)));
    await run("qualityBucketNullInstrumentAndFlushRetryDoesNotDoubleCount", () => fixture(client, `${nonce}f`).then((data) => qualityBucketNullInstrumentAndFlushRetryDoesNotDoubleCount(client, data)));
    await run("clearWithRealSessionWritesResolutionAuditAndRebaselines", () => fixture(client, `${nonce}g`).then((data) => clearWithRealSessionWritesResolutionAuditAndRebaselines(client, data)));
    await run("effectiveStateUsesDatabaseClock", () => fixture(client, `${nonce}h`).then((data) => effectiveStateUsesDatabaseClock(client, data)));
    await run("concurrentHaltOpenAndClearSerialized", () => fixture(client, `${nonce}i`).then((data) => concurrentHaltOpenAndClearSerialized(client, data)));
    await run("notifyOccursOnlyAfterCommit", () => fixture(client, `${nonce}j`).then((data) => notifyOccursOnlyAfterCommit(client, data)));
    await run("nonSuperAdminClearRejected", () => fixture(client, `${nonce}k`).then((data) => nonSuperAdminClearRejected(client, data)));
    await run("secondResolutionForSameHaltRejected", () => fixture(client, `${nonce}l`).then((data) => secondResolutionForSameHaltRejected(client, data)));
    await run("newestResetWinsOverOlderUnconsumedReset", () => fixture(client, `${nonce}m`).then((data) => newestResetWinsOverOlderUnconsumedReset(client, data)));
    await run("manifestNegativeMatrix", () => manifestNegativeMatrix(client));
    console.log("Market-data function integration tests passed.");
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => { throw error; });
