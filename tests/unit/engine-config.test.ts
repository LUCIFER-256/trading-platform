import { EngineConfigurationError, parseEngineEnvironment } from "../../apps/market-data/src/engine-config";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const base = {
  MARKET_DATA_WS_ENDPOINT: "wss://ws.example.invalid/feed",
  MARKET_DATA_REST_BASE_URL: "https://api.example.invalid",
  MARKET_DATA_INSTRUMENTS: "btcusd=BTC-USD,ethusd=ETH-USD",
  MARKET_DATA_TERMS_ACKNOWLEDGEMENT: "RA1_RISK_ACCEPTED",
};

function refuses(environment: Record<string, string | undefined>, code: string): void {
  try {
    parseEngineEnvironment(environment);
  } catch (error) {
    assert(error instanceof EngineConfigurationError, "Configuration must use its safe error.");
    assert(error.code === code, `Expected ${code}, got ${error.code}.`);
    assert(!error.message.includes("example.invalid"), "The error must not echo configuration values.");
    return;
  }
  throw new Error(`Configuration must refuse with ${code}.`);
}

function unitEngineConfigurationParsesAndRefuses(): void {
  const parsed = parseEngineEnvironment({ ...base, MARKET_DATA_QUALITY_FLUSH_INTERVAL_MS: "800" });
  assert(parsed.runtimeMode === "development", "Runtime mode must default to development.");
  assert(parsed.catalog.instruments.length === 2, "Both instruments must parse.");
  assert(parsed.qualityFlushIntervalMs === 800, "Flush interval must parse.");
  assert(parsed.termsAcknowledgement === "RA1_RISK_ACCEPTED", "Acknowledgement must pass through untouched.");
  refuses({ ...base, PLATFORM_RUNTIME_MODE: "live" }, "LIVE_MODE");
  refuses({ ...base, PLATFORM_RUNTIME_MODE: "bogus" }, "RUNTIME_MODE");
  refuses({ ...base, MARKET_DATA_WS_ENDPOINT: undefined }, "WS_ENDPOINT");
  refuses({ ...base, MARKET_DATA_WS_ENDPOINT: "ws://plain.example.invalid" }, "WS_ENDPOINT");
  refuses({ ...base, MARKET_DATA_WS_ENDPOINT: "wss://user:pw@host.example.invalid" }, "WS_ENDPOINT");
  refuses({ ...base, MARKET_DATA_REST_BASE_URL: "http://api.example.invalid" }, "REST_BASE_URL");
  refuses({ ...base, MARKET_DATA_REST_BASE_URL: undefined }, "REST_BASE_URL");
  refuses({ ...base, MARKET_DATA_INSTRUMENTS: undefined }, "INSTRUMENTS");
  refuses({ ...base, MARKET_DATA_INSTRUMENTS: "" }, "INSTRUMENTS");
  refuses({ ...base, MARKET_DATA_INSTRUMENTS: "btcusd=btc-usd" }, "INSTRUMENTS");
  refuses({ ...base, MARKET_DATA_INSTRUMENTS: "btcusd=BTC-USD,btcusd=ETH-USD" }, "INSTRUMENTS");
  refuses({ ...base, MARKET_DATA_INSTRUMENTS: "a=BTC-USD,b=BTC-USD" }, "INSTRUMENTS");
  refuses({ ...base, MARKET_DATA_INSTRUMENTS: "btcusd" }, "INSTRUMENTS");
  refuses({ ...base, MARKET_DATA_QUALITY_FLUSH_INTERVAL_MS: "5" }, "FLUSH_INTERVAL");
  refuses({ ...base, MARKET_DATA_QUALITY_FLUSH_INTERVAL_MS: "abc" }, "FLUSH_INTERVAL");
  assert(parsed.extraCaFile === undefined, "No extra CA by default.");
  const withCa = parseEngineEnvironment({ ...base, PLATFORM_RUNTIME_MODE: "test", MARKET_DATA_EXTRA_CA_FILE: "/x/ca.pem" });
  assert(withCa.extraCaFile === "/x/ca.pem", "Test mode must accept an extra CA.");
  refuses({ ...base, MARKET_DATA_EXTRA_CA_FILE: "/x/ca.pem" }, "EXTRA_CA");
  refuses({ ...base, PLATFORM_RUNTIME_MODE: "paper", MARKET_DATA_EXTRA_CA_FILE: "/x/ca.pem" }, "EXTRA_CA");
  refuses({ ...base, PLATFORM_RUNTIME_MODE: "test", MARKET_DATA_EXTRA_CA_FILE: "" }, "EXTRA_CA");
  console.log("unitEngineConfigurationParsesAndRefuses");
}

unitEngineConfigurationParsesAndRefuses();
