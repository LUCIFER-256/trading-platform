import { parseRuntimeMode, type RuntimeMode } from "../../../packages/core/src";
import type { CatalogConfiguration } from "./persistence/postgres-persistence-port";

export type EngineEnvironment = Readonly<Record<string, string | undefined>>;

export class EngineConfigurationError extends Error {
  public readonly name = "EngineConfigurationError";

  public constructor(readonly code:
    "RUNTIME_MODE" | "LIVE_MODE" | "EXTRA_CA" | "WS_ENDPOINT" | "REST_BASE_URL" | "INSTRUMENTS" | "FLUSH_INTERVAL"
    | "ALLOWED_HOSTS" | "HOST_NOT_ALLOWED") {
    super(`Market-data engine configuration is invalid: ${code}.`);
  }
}

export interface EngineConfiguration {
  readonly runtimeMode: RuntimeMode;
  readonly endpoint: string;
  readonly restBaseUrl: string;
  readonly catalog: CatalogConfiguration;
  readonly termsAcknowledgement: string | undefined;
  readonly qualityFlushIntervalMs: number | undefined;
  readonly extraCaFile: string | undefined;
}

const LABEL = /^[a-z][a-z0-9]{0,15}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const SYMBOL = /^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}$/;

function requiredUrl(value: string | undefined, protocol: "wss:" | "https:", code: "WS_ENDPOINT" | "REST_BASE_URL"): string {
  let parsed: URL;
  try {
    parsed = new URL(value ?? "");
  } catch {
    throw new EngineConfigurationError(code);
  }
  if (parsed.protocol !== protocol || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new EngineConfigurationError(code);
  }
  return value!;
}

function allowedHosts(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.length === 0) throw new EngineConfigurationError("ALLOWED_HOSTS");
  const hosts = new Set<string>();
  for (const host of value.split(",")) {
    if (!HOST.test(host) || host.includes("..")) throw new EngineConfigurationError("ALLOWED_HOSTS");
    hosts.add(host);
  }
  return hosts;
}

function instruments(value: string | undefined): CatalogConfiguration["instruments"] {
  if (value === undefined || value.length === 0) throw new EngineConfigurationError("INSTRUMENTS");
  const result: { label: string; symbol: string }[] = [];
  for (const part of value.split(",")) {
    const pieces = part.split("=");
    const label = pieces[0];
    const symbol = pieces[1];
    if (pieces.length !== 2 || label === undefined || symbol === undefined || !LABEL.test(label) || !SYMBOL.test(symbol)) {
      throw new EngineConfigurationError("INSTRUMENTS");
    }
    if (result.some((item) => item.label === label || item.symbol === symbol)) {
      throw new EngineConfigurationError("INSTRUMENTS");
    }
    result.push({ label, symbol });
  }
  return result;
}

export function parseEngineEnvironment(environment: EngineEnvironment): EngineConfiguration {
  const mode = parseRuntimeMode(environment.PLATFORM_RUNTIME_MODE ?? "development");
  if (!mode.ok) throw new EngineConfigurationError("RUNTIME_MODE");
  if (mode.value === "live") throw new EngineConfigurationError("LIVE_MODE");
  const flush = environment.MARKET_DATA_QUALITY_FLUSH_INTERVAL_MS;
  let qualityFlushIntervalMs: number | undefined;
  if (flush !== undefined) {
    if (!/^[1-9][0-9]{2,6}$/.test(flush)) throw new EngineConfigurationError("FLUSH_INTERVAL");
    qualityFlushIntervalMs = Number(flush);
  }
  const extraCaFile = environment.MARKET_DATA_EXTRA_CA_FILE;
  if (extraCaFile !== undefined && (mode.value !== "test" || extraCaFile.length === 0)) {
    throw new EngineConfigurationError("EXTRA_CA");
  }
  const hosts = allowedHosts(environment.MARKET_DATA_ALLOWED_HOSTS);
  const endpoint = requiredUrl(environment.MARKET_DATA_WS_ENDPOINT, "wss:", "WS_ENDPOINT");
  const restBaseUrl = requiredUrl(environment.MARKET_DATA_REST_BASE_URL, "https:", "REST_BASE_URL");
  if (!hosts.has(new URL(endpoint).hostname) || !hosts.has(new URL(restBaseUrl).hostname)) {
    throw new EngineConfigurationError("HOST_NOT_ALLOWED");
  }
  return {
    runtimeMode: mode.value,
    endpoint,
    restBaseUrl,
    catalog: { providerLabel: "coinbase", instruments: instruments(environment.MARKET_DATA_INSTRUMENTS) },
    termsAcknowledgement: environment.MARKET_DATA_TERMS_ACKNOWLEDGEMENT,
    qualityFlushIntervalMs,
    extraCaFile,
  };
}
