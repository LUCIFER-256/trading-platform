import type { KyselyDatabase, MarketDataStartupRecovery } from "../../packages/database/src";
import {
  loadStartupCatalog,
  recoverMarketDataStartup,
  resolveStartupCatalog,
  StartupRecoveryError,
  type StartupRepository,
} from "../../apps/market-data/src/persistence/startup";
import type { CatalogConfiguration, CatalogMapping } from "../../apps/market-data/src/persistence/postgres-persistence-port";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const configuration: CatalogConfiguration = {
  providerLabel: "coinbase",
  providerUuid: "provider-id",
  instruments: [
    { label: "active", symbol: "ACTIVE-USD" },
    { label: "policyless", symbol: "POLICYLESS-USD" },
    { label: "disabled", symbol: "DISABLED-USD" },
    { label: "human", symbol: "HUMAN-USD" },
    { label: "broken", symbol: "BROKEN-USD" },
  ],
};

const mapping: CatalogMapping = {
  providerId: "coinbase",
  providerUuid: "provider-id",
  instrumentsByLabel: new Map([
    ["active", "active-id"],
    ["human", "human-id"],
    ["broken", "broken-id"],
  ]),
  instrumentsBySymbol: new Map(),
};

function recovery(overrides: Partial<MarketDataStartupRecovery> = {}): MarketDataStartupRecovery {
  return {
    lastAcceptedPrice: "100.00",
    eventAt: new Date("2026-10-28T10:11:12.345Z"),
    haltId: null,
    haltReasonCode: null,
    candidatePrice: null,
    candidateSize: null,
    candidateTradeId: null,
    candidateProviderSequence: null,
    referencePrice: null,
    resetId: null,
    confirmedCandidatePrice: null,
    toleranceBps: null,
    expiresAt: null,
    ...overrides,
  };
}

const calls: StartupRepository = {
  async catalogRows() {
    return [];
  },
  async inspectScope(_database, _providerId, symbol) {
    if (symbol === "POLICYLESS-USD") return "NO_POLICY";
    return "DISABLED_SCOPE";
  },
  async marketDataStartupRecovery(_database, instrumentId) {
    if (instrumentId === "human-id") return recovery({ haltId: "halt-id" });
    if (instrumentId === "broken-id") throw { code: "08006", message: "unsafe connection detail" };
    return recovery();
  },
};

async function startupSkipsAndSeedsIndependently(): Promise<void> {
  const result = await recoverMarketDataStartup({} as KyselyDatabase, mapping, configuration, calls);
  assert(result.started.length === 1 && result.started[0]?.label === "active", "Active instrument must start.");
  assert(result.skipped.get("policyless") === "NO_POLICY", "Missing policy must be skipped.");
  assert(result.skipped.get("disabled") === "DISABLED_SCOPE", "Disabled scope must be skipped.");
  assert(result.skipped.get("human") === "HUMAN_HALT", "Human halt must be skipped.");
  assert(result.skipped.get("broken") === "RECOVERY_ERROR", "One failure must not stop other instruments.");
  assert(
    result.failures.get("broken")?.message === "Market-data startup recovery failed. SQLSTATE 08006.",
    "Recovery failure must retain only its safe error.",
  );
  assert(
    !result.failures.get("broken")?.message.includes("unsafe")!,
    "Recovery failure must not expose driver text.",
  );
  assert(result.humanHalted.has("human"), "Human-halted set must use configured identifiers.");
  assert(result.recovery.get("active")?.price === "100.00", "Recovery must retain the decimal price.");
  assert(
    result.recovery.get("active")?.eventTime === "1793182272345000",
    "Recovery Date must convert to a microsecond string.",
  );
  console.log("startupSkipsAndSeedsIndependently");
}

async function startupNoRowIsFreshStart(): Promise<void> {
  const fresh: StartupRepository = {
    catalogRows: calls.catalogRows,
    inspectScope: calls.inspectScope,
    async marketDataStartupRecovery() {
      return undefined;
    },
  };
  const result = await recoverMarketDataStartup({} as KyselyDatabase, {
    ...mapping,
    instrumentsByLabel: new Map([["active", "active-id"]]),
  }, { providerLabel: "coinbase", providerUuid: "provider-id", instruments: [configuration.instruments[0]!] }, fresh);
  assert(result.started[0]?.label === "active", "No state row must begin as a fresh start.");
  assert(!result.recovery.has("active"), "Fresh start must not have a seed.");
  console.log("startupNoRowIsFreshStart");
}

function startupErrorTextIsSafe(): void {
  const error = new StartupRecoveryError("08006");
  assert(error.message === "Market-data startup recovery failed. SQLSTATE 08006.", "Error must expose operation and SQLSTATE.");
  assert(!error.message.includes("unsafe"), "Error must not expose driver text.");
  console.log("startupErrorTextIsSafe");
}

const catalogRows = [
  { providerId: "provider-id", instrumentId: "active-id", providerSymbol: "ACTIVE-USD" },
  { providerId: "provider-id", instrumentId: "human-id", providerSymbol: "HUMAN-USD" },
];

function startupCatalogResolvesOnlyInstrumentsPresentInCatalog(): void {
  const resolved = resolveStartupCatalog(catalogRows, {
    providerLabel: "coinbase",
    providerUuid: "provider-id",
    instruments: [
      { label: "active", symbol: "ACTIVE-USD" },
      { label: "policyless", symbol: "POLICYLESS-USD" },
      { label: "human", symbol: "HUMAN-USD" },
    ],
  });
  assert(resolved.mapping !== undefined, "Resolvable instruments must produce a mapping.");
  assert(resolved.mapping.instrumentsByLabel.get("active") === "active-id", "Active label must map to its instrument.");
  assert(resolved.mapping.instrumentsByLabel.get("human") === "human-id", "Human label must map to its instrument.");
  assert(!resolved.mapping.instrumentsByLabel.has("policyless"), "An instrument absent from the catalog is not mapped.");
  assert(resolved.mapping.providerUuid === "provider-id", "Provider must come from the catalog rows.");
  assert(resolved.unresolved.length === 1 && resolved.unresolved[0] === "policyless", "Absent instruments are reported.");
  const none = resolveStartupCatalog([], configuration);
  assert(none.mapping === undefined && none.unresolved.length === configuration.instruments.length, "Nothing resolvable.");
  let refused = false;
  try {
    resolveStartupCatalog([
      ...catalogRows,
      { providerId: "provider-id", instrumentId: "other-id", providerSymbol: "ACTIVE-USD" },
    ], { providerLabel: "coinbase", providerUuid: "provider-id", instruments: [{ label: "active", symbol: "ACTIVE-USD" }] });
  } catch (error) {
    refused = error instanceof Error && error.message === "Market-data persistence catalog failed.";
  }
  assert(refused, "A symbol mapped twice must be refused, not skipped.");
  console.log("startupCatalogResolvesOnlyInstrumentsPresentInCatalog");
}

async function startupWithNoMappingSkipsEverythingWithoutProvider(): Promise<void> {
  const seen: Array<string | undefined> = [];
  const probe: StartupRepository = {
    ...calls,
    async inspectScope(_database, providerId, symbol) {
      seen.push(providerId);
      if (symbol === "BROKEN-USD") throw { code: "57P01", message: "unsafe detail" };
      return "NO_POLICY";
    },
  };
  const result = await recoverMarketDataStartup({} as KyselyDatabase, undefined, configuration, probe);
  assert(result.started.length === 0, "Nothing may start without a mapping.");
  assert(result.skipped.get("active") === "NO_POLICY", "Every instrument must be inspected for a reason.");
  assert(seen.length > 0, "Every unresolved instrument must be inspected.");
  assert(seen.every((value) => value === "provider-id"), "The configured provider filter is always applied.");
  assert(result.skipped.get("broken") === "RECOVERY_ERROR", "An inspection failure is a recovery error.");
  assert(
    result.failures.get("broken")?.message === "Market-data startup recovery failed. SQLSTATE 57P01.",
    "An inspection failure keeps only its safe error.",
  );
  assert(!result.failures.has("active"), "A normal skip is not a failure.");
  console.log("startupWithNoMappingSkipsEverythingWithoutProvider");
}

async function startupCatalogLoadFailureIsSafe(): Promise<void> {
  const failing: StartupRepository = {
    ...calls,
    async catalogRows() {
      throw { code: "42501", message: "permission denied for table secrets" };
    },
  };
  let message = "";
  try {
    await loadStartupCatalog({} as KyselyDatabase, configuration, failing);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assert(message === "Market-data startup recovery failed. SQLSTATE 42501.", "Catalog failure must be safe.");
  const loaded = await loadStartupCatalog({} as KyselyDatabase, configuration, {
    ...calls,
    async catalogRows() {
      return catalogRows;
    },
  });
  assert(loaded.mapping?.instrumentsByLabel.get("active") === "active-id", "The same fixture loads when the catalog works.");
  console.log("startupCatalogLoadFailureIsSafe");
}

function startupCatalogSeparatesProvidersWithTheSameSymbol(): void {
  const rows = [
    { providerId: "p-one", instrumentId: "i-one", providerSymbol: "BTC-USD" },
    { providerId: "p-two", instrumentId: "i-two", providerSymbol: "BTC-USD" },
  ];
  const wanted = [{ label: "btc", symbol: "BTC-USD" }];
  const one = resolveStartupCatalog(rows, { providerLabel: "coinbase", providerUuid: "p-one", instruments: wanted });
  assert(one.mapping?.providerUuid === "p-one", "Provider one must be selected.");
  assert(one.mapping.instrumentsByLabel.get("btc") === "i-one", "Provider one must resolve to its own row.");
  const two = resolveStartupCatalog(rows, { providerLabel: "coinbase", providerUuid: "p-two", instruments: wanted });
  assert(two.mapping?.providerUuid === "p-two", "Provider two must be selected.");
  assert(two.mapping.instrumentsByLabel.get("btc") === "i-two", "Provider two must resolve to its own row.");
  const wrong = resolveStartupCatalog(rows, { providerLabel: "coinbase", providerUuid: "p-three", instruments: wanted });
  assert(wrong.mapping === undefined, "An unknown provider resolves nothing.");
  assert(wrong.unresolved.length === 1 && wrong.unresolved[0] === "btc", "The instrument is reported unresolved.");
  console.log("startupCatalogSeparatesProvidersWithTheSameSymbol");
}

void startupSkipsAndSeedsIndependently()
  .then(startupNoRowIsFreshStart)
  .then(startupErrorTextIsSafe)
  .then(startupCatalogResolvesOnlyInstrumentsPresentInCatalog)
  .then(startupCatalogSeparatesProvidersWithTheSameSymbol)
  .then(startupWithNoMappingSkipsEverythingWithoutProvider)
  .then(startupCatalogLoadFailureIsSafe)
  .catch((error: unknown) => {
    throw error;
  });
