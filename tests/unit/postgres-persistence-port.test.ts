import {
  buildCatalogMapping,
  PostgresPersistenceError,
  PostgresPersistencePort,
  uuidV7,
  type CatalogConfiguration,
  type CatalogMapping,
  type CatalogRow,
  type PostgresPersistenceRepository,
} from "../../apps/market-data/src/persistence/postgres-persistence-port";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const configuration: CatalogConfiguration = {
  providerLabel: "coinbase",
  providerUuid: "00000000-0000-7000-8000-000000000001",
  instruments: [
    { label: "btc", symbol: "BTC-USD" },
    { label: "eth", symbol: "ETH-USD" },
  ],
};
const rows: CatalogRow[] = [
  {
    providerId: "00000000-0000-7000-8000-000000000001",
    instrumentId: "00000000-0000-7000-8000-000000000002",
    providerSymbol: "BTC-USD",
  },
  {
    providerId: "00000000-0000-7000-8000-000000000001",
    instrumentId: "00000000-0000-7000-8000-000000000003",
    providerSymbol: "ETH-USD",
  },
];
const mapping: CatalogMapping = buildCatalogMapping(rows, configuration);
const observation = {
  providerId: "coinbase",
  instrumentId: "btc",
  providerSymbol: "BTC-USD",
  providerSequence: "1",
  tradeId: "1",
  eventAtUs: "1",
  receivedAt: new Date("2026-01-01T00:00:00Z"),
  bid: "1",
  bidSize: "1",
  ask: "2",
  askSize: "1",
  lastPrice: "1",
  lastSize: "1",
  volume24h: null,
};

function fake(calls: unknown[], failQuality = false): PostgresPersistenceRepository {
  return {
    appendObservation: async (_database, request) => {
      calls.push(request);
      return { outcome: "PRICE_JUMP_HALT", observationId: null, haltId: "halt" };
    },
    openHalt: async (_database, request) => {
      calls.push(request);
      return "halt";
    },
    transitionState: async (_database, request) => {
      calls.push(request);
    },
    appendQualityBucket: async (_database, request) => {
      calls.push(request);
      if (failQuality) throw { code: "08006" };
    },
  };
}

async function mappingsAndOutcomes(): Promise<void> {
  const calls: unknown[] = [];
  const port = new PostgresPersistencePort({} as never, mapping, fake(calls));
  const result = await port.appendObservation(observation);
  assert(result.outcome === "PRICE_JUMP_HALT", "PRICE_JUMP_HALT must pass through unchanged.");
  const conflictPort = new PostgresPersistencePort({} as never, mapping, {
    ...fake(calls),
    appendObservation: async (_database, request) => {
      calls.push(request);
      return { outcome: "IDEMPOTENCY_CONFLICT", observationId: null, haltId: "halt" };
    },
  });
  const conflict = await conflictPort.appendObservation(observation);
  assert(
    conflict.outcome === "IDEMPOTENCY_CONFLICT",
    "IDEMPOTENCY_CONFLICT must pass through unchanged.",
  );
  await port.openHalt({
    providerId: "coinbase",
    instrumentId: "btc",
    reasonCode: "IDEMPOTENCY_CONFLICT",
    eventAtUs: null,
    tradeId: null,
    providerSequence: null,
    candidatePrice: null,
    candidateSize: null,
    referencePrice: null,
  });
  await port.transitionState({
    providerId: "coinbase",
    instrumentId: null,
    newBaseAvailability: "UNAVAILABLE_PERSISTENCE",
    reasonCode: "PERSISTENCE_TIMEOUT",
  });
  await port.appendQualityBucket({
    flushId: "quality-1",
    providerId: "coinbase",
    instrumentId: null,
    reasonCode: "MALFORMED",
    bucketStartedAt: new Date(),
    count: 1n,
  });
  const values = calls as Array<{ providerId: string; instrumentId: string | null }>;
  assert(
    values[0]?.instrumentId === mapping.instrumentsByLabel.get("btc"),
    "Observation must map its label.",
  );
  assert(
    values[3]?.instrumentId === null && values[4]?.instrumentId === null,
    "Nullable calls must preserve null.",
  );
  console.log("postgresPersistenceMapsCatalogAndPreservesOutcomes");
}

async function catalogMatchesProviderAndSymbol(): Promise<void> {
  const otherProvider = "00000000-0000-7000-8000-000000000050";
  const otherRows: CatalogRow[] = [
    { providerId: otherProvider, instrumentId: "00000000-0000-7000-8000-000000000051", providerSymbol: "BTC-USD" },
    { providerId: otherProvider, instrumentId: "00000000-0000-7000-8000-000000000052", providerSymbol: "ETH-USD" },
  ];
  const both = [...rows, ...otherRows];
  const mine = buildCatalogMapping(both, configuration);
  assert(mine.providerUuid === rows[0]!.providerId, "The configured provider must be selected.");
  assert(mine.instrumentsByLabel.get("btc") === rows[0]!.instrumentId, "The configured provider's instrument must be used.");
  const theirs = buildCatalogMapping(both, { ...configuration, providerUuid: otherProvider });
  assert(theirs.providerUuid === otherProvider, "Another provider id must select the other provider.");
  assert(theirs.instrumentsByLabel.get("eth") === otherRows[1]!.instrumentId, "The other provider's instrument must be used.");
  rejects(() => buildCatalogMapping(both, { ...configuration, providerUuid: "00000000-0000-7000-8000-0000000000ff" }));
  rejects(() => buildCatalogMapping(rows, { ...configuration, providerUuid: "" }));
  console.log("catalogMatchesProviderAndSymbol");
}

async function catalogMappingRefusals(): Promise<void> {
  const secondProvider = { ...rows[0]!, providerId: "00000000-0000-7000-8000-000000000099" };
  rejects(() => buildCatalogMapping([], configuration));
  rejects(() => buildCatalogMapping([rows[0]!, secondProvider], configuration));
  rejects(() => buildCatalogMapping(rows, {
    ...configuration,
    instruments: [{ label: "btc", symbol: "BTC-USD" }, { label: "btc", symbol: "ETH-USD" }],
  }));
  rejects(() => buildCatalogMapping(rows, {
    ...configuration,
    instruments: [{ label: "btc", symbol: "BTC-USD" }, { label: "eth", symbol: "BTC-USD" }],
  }));
  rejects(() => buildCatalogMapping([...rows, rows[0]!], configuration));
  console.log("postgresPersistenceCatalogMappingRefusals");
}

async function safeRefusalsAndNoRetry(): Promise<void> {
  let attempts = 0;
  const calls: unknown[] = [];
  const port = new PostgresPersistencePort({} as never, mapping, {
    ...fake(calls),
    appendObservation: async () => {
      attempts += 1;
      throw { code: "08006", message: "postgres://secret" };
    },
  });
  await rejectsAsync(
    () => port.appendObservation({ ...observation, providerSymbol: "ETH-USD" }),
    "catalog",
  );
  await rejectsAsync(() => port.openHalt({
    providerId: "coinbase",
    instrumentId: null as never,
    reasonCode: "UNKNOWN",
    eventAtUs: null,
    tradeId: null,
    providerSequence: null,
    candidatePrice: null,
    candidateSize: null,
    referencePrice: null,
  }), "catalog");
  await rejectsAsync(() => port.appendObservation(observation), "append");
  assert(attempts === 1, "Adapter must make exactly one failed repository call.");
  console.log("postgresPersistenceRefusesUnsafeMappingsAndMapsErrors");
}

async function adapterAddsNoTimer(): Promise<void> {
  const calls: unknown[] = [];
  let timerCalls = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((...arguments_: Parameters<typeof setTimeout>) => {
    timerCalls += 1;
    return originalSetTimeout(...arguments_);
  }) as typeof setTimeout;
  try {
    const port = new PostgresPersistencePort({} as never, mapping, fake(calls));
    await port.appendObservation(observation);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert(calls.length === 1, "Adapter must make one repository call without retry.");
  assert(timerCalls === 0, "Adapter must not create a timer.");
  console.log("postgresPersistenceAddsNoTimer");
}

async function flushLifecycle(): Promise<void> {
  const request = {
    flushId: "quality-1",
    providerId: "coinbase",
    instrumentId: "btc",
    reasonCode: "MALFORMED",
    bucketStartedAt: new Date(),
    count: 1n,
  };
  const failedCalls: unknown[] = [];
  const failed = new PostgresPersistencePort({} as never, mapping, fake(failedCalls, true));
  await rejectsAsync(() => failed.appendQualityBucket(request), "quality");
  await rejectsAsync(() => failed.appendQualityBucket(request), "quality");
  const failedIds = (failedCalls as Array<{ flushId: string }>).map((call) => call.flushId);
  assert(failedIds[0] === failedIds[1], "Failed flush retries must keep the UUID.");

  const succeededCalls: unknown[] = [];
  const succeeded = new PostgresPersistencePort({} as never, mapping, fake(succeededCalls));
  await succeeded.appendQualityBucket(request);
  await succeeded.appendQualityBucket(request);
  const ids = (succeededCalls as Array<{ flushId: string }>).map((call) => call.flushId);
  assert(ids[0] !== ids[1], "Successful flushes must release the in-memory UUID.");
  assert(ids.every((id) => /^.{14}7/.test(id)), "Every flush identifier must be UUIDv7.");
  assert(uuidV7(1_700_000_000_000) !== uuidV7(1_700_000_000_000), "UUIDv7 tails must not repeat.");
  console.log("postgresPersistenceFlushIdsAreUuidV7");
}

async function refusedQualityDoesNotRetainFlushId(): Promise<void> {
  const port = new PostgresPersistencePort({} as never, mapping, fake([]));
  await rejectsAsync(() => port.appendQualityBucket({
    flushId: "quality-refused",
    providerId: "wrong-provider",
    instrumentId: "btc",
    reasonCode: "MALFORMED",
    bucketStartedAt: new Date(),
    count: 1n,
  }), "catalog");
  const internals = port as unknown as { flushIds: ReadonlyMap<string, string> };
  assert(internals.flushIds.size === 0, "A refused quality bucket must not retain a flush UUID.");
  console.log("postgresPersistenceRefusedQualityDoesNotRetainFlushId");
}

function rejects(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    assert(error instanceof PostgresPersistenceError, "Expected catalog refusal.");
    return;
  }
  throw new Error("Expected catalog refusal.");
}

async function rejectsAsync(action: () => Promise<unknown>, operation: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof PostgresPersistenceError && error.operation === operation,
      `Expected ${operation} refusal.`,
    );
    return;
  }
  throw new Error(`Expected ${operation} refusal.`);
}

async function refusesUnknownHaltReason(): Promise<void> {
  const calls: unknown[] = [];
  const port = new PostgresPersistencePort({} as never, mapping, fake(calls));
  const request = {
    providerId: "coinbase",
    instrumentId: "btc",
    eventAtUs: null,
    tradeId: null,
    providerSequence: null,
    candidatePrice: null,
    candidateSize: null,
    referencePrice: null,
  };
  const allowed = [
    "LOCKED_OR_CROSSED",
    "OUT_OF_ORDER_MATCH_ID",
    "IN_SESSION_MATCH_GAP",
    "PRICE_JUMP",
    "PRODUCT_ASSERTION_FAILURE",
    "IDEMPOTENCY_CONFLICT",
  ];
  for (const reasonCode of allowed) {
    assert(await port.openHalt({ ...request, reasonCode }) === "halt", `${reasonCode} must be accepted.`);
  }
  assert(calls.length === allowed.length, "Every allowed halt reason reaches the repository once.");
  await rejectsAsync(() => port.openHalt({ ...request, reasonCode: "UNKNOWN" }), "halt");
  await rejectsAsync(() => port.openHalt({ ...request, reasonCode: "" }), "halt");
  assert(calls.length === allowed.length, "A refused halt reason never reaches the repository.");
  console.log("postgresPersistenceRefusesUnknownHaltReason");
}

void mappingsAndOutcomes()
  .then(catalogMappingRefusals)
  .then(catalogMatchesProviderAndSymbol)
  .then(safeRefusalsAndNoRetry)
  .then(refusesUnknownHaltReason)
  .then(adapterAddsNoTimer)
  .then(flushLifecycle)
  .then(refusedQualityDoesNotRetainFlushId);
