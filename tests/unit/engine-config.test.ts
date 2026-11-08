import { EngineConfigurationError, parseEngineEnvironment } from "../../apps/market-data/src/engine-config";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const base = {
  MARKET_DATA_WS_ENDPOINT: "wss://ws.example.invalid/feed",
  MARKET_DATA_REST_BASE_URL: "https://api.example.invalid",
  MARKET_DATA_INSTRUMENTS: "btcusd=BTC-USD,ethusd=ETH-USD",
  MARKET_DATA_PROVIDER_ID: "00000000-0000-7000-8000-000000000001",
  MARKET_DATA_TERMS_ACKNOWLEDGEMENT: "RA1_RISK_ACCEPTED",
  MARKET_DATA_ALLOWED_HOSTS: "ws.example.invalid,api.example.invalid",
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
  assert(parsed.catalog.providerUuid === "00000000-0000-7000-8000-000000000001", "The provider id must pass through.");
  const upper = "0000000A-0000-7000-8000-00000000000B";
  const lower = parseEngineEnvironment({ ...base, MARKET_DATA_PROVIDER_ID: upper.toLowerCase() });
  assert(lower.catalog.providerUuid === upper.toLowerCase(), "A lowercase hexadecimal id is accepted.");
  const good = "00000000-0000-7000-8000-000000000001";
  const badIds = [undefined, "", "test-provider", upper, `${good}\n`, ` ${good}`, good.slice(0, -1), `${good}0`];
  badIds.push(good.replaceAll("-", ""), `${good.slice(0, -1)}g`);
  for (const bad of badIds) {
    refuses({ ...base, MARKET_DATA_PROVIDER_ID: bad }, "PROVIDER_ID");
  }
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
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: undefined }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "*.example.invalid" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "ws.example.invalid:443,api.example.invalid" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "ws.example.invalid,,api.example.invalid" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "WS.example.invalid,api.example.invalid" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "ws..example.invalid,api.example.invalid" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "api.example.invalid" }, "HOST_NOT_ALLOWED");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "ws.example.invalid" }, "HOST_NOT_ALLOWED");
  refuses({ ...base, MARKET_DATA_WS_ENDPOINT: "wss://other.example.invalid/feed" }, "HOST_NOT_ALLOWED");
  refuses({ ...base, MARKET_DATA_REST_BASE_URL: "https://other.example.invalid" }, "HOST_NOT_ALLOWED");
  refuses({ ...base, MARKET_DATA_WS_ENDPOINT: "wss://sub.ws.example.invalid/feed" }, "HOST_NOT_ALLOWED");
  refuses({ ...base, MARKET_DATA_WS_ENDPOINT: "wss://ws.example.invalid.evil.invalid/feed" }, "HOST_NOT_ALLOWED");
  refuses({ ...base, MARKET_DATA_WS_ENDPOINT: "wss://ws.example.invalid./feed" }, "HOST_NOT_ALLOWED");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "[::1],api.example.invalid" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "-ws.example.invalid,api.example.invalid" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "ws.example.invalid-,api.example.invalid" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: ".ws.example.invalid,api.example.invalid" }, "ALLOWED_HOSTS");
  refuses({ ...base, MARKET_DATA_ALLOWED_HOSTS: "ws.example.invalid.,api.example.invalid" }, "ALLOWED_HOSTS");
  for (const unsafe of [
    "wss://ws.example.invalid\t/feed",
    "wss://ws.example.invalid\n.evil.invalid/feed",
    "wss://ws.example.invalid /feed",
    " wss://ws.example.invalid/feed",
    "wss://ws.example.invalid/feed ",
    "wss://ws.example.invalid\\@evil.invalid/feed",
    "wss://ws.example.invalid\u0000/feed",
    "wss://w\u00e9s.example.invalid/feed",
    "wss://ws.example.invalid/\u007ffeed",
  ]) {
    refuses({ ...base, MARKET_DATA_WS_ENDPOINT: unsafe }, "WS_ENDPOINT");
  }
  refuses({ ...base, MARKET_DATA_REST_BASE_URL: "https://api.example.invalid\t" }, "REST_BASE_URL");
  refuses({ ...base, MARKET_DATA_REST_BASE_URL: "https://api.example.invalid\\@evil.invalid" }, "REST_BASE_URL");
  refuses({ ...base, MARKET_DATA_WS_ENDPOINT: "wss://ws%2eexample.invalid.evil.invalid/feed" }, "HOST_NOT_ALLOWED");
  const tilde = parseEngineEnvironment({ ...base, MARKET_DATA_WS_ENDPOINT: "wss://ws.example.invalid/feed~v1" });
  assert(tilde.endpoint === "wss://ws.example.invalid/feed~v1", "The last printable ASCII character must be accepted.");
  const bang = parseEngineEnvironment({ ...base, MARKET_DATA_REST_BASE_URL: "https://api.example.invalid/!v1" });
  assert(bang.restBaseUrl === "https://api.example.invalid/!v1", "The first printable ASCII character must be accepted.");
  const ported = parseEngineEnvironment({ ...base, MARKET_DATA_WS_ENDPOINT: "wss://ws.example.invalid:8443/feed" });
  assert(ported.endpoint === "wss://ws.example.invalid:8443/feed", "The allowlist restricts hosts, not ports.");
  const spare = "ws.example.invalid,api.example.invalid,spare.example.invalid";
  const mixed = parseEngineEnvironment({ ...base, MARKET_DATA_ALLOWED_HOSTS: spare });
  assert(mixed.restBaseUrl === "https://api.example.invalid", "Extra allowed hosts must not be required.");
  console.log("unitEngineConfigurationParsesAndRefuses");
}

unitEngineConfigurationParsesAndRefuses();
