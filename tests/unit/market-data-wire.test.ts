import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { COINBASE_MAX_PAYLOAD_BYTES, CoinbaseWsTransport, type WireCallbacks } from "../../apps/market-data/src/coinbase/ws-client";
import { canonicalDecimal } from "../../packages/market-data/src";
import { startFakeProvider, type FakeProvider } from "../fake-provider/server";
import { FakeClock } from "./support/market-data-fakes";
import {
  assert,
  buildWireSession,
  createTestPki,
  heartbeat,
  match,
  passed,
  settle,
  size,
  ticker,
  turns,
  until,
  type TestPki,
  type WireSession,
} from "./support/market-data-wire-helpers";

const BACKOFF_FIRST_DELAY_MS = 518;
const TICKER_BASE_MS = 1_000_000;
const TICKER_BASE_ISO = "1970-01-01T00:16:40.000000Z";

interface Recorder {
  readonly callbacks: WireCallbacks;
  readonly sequence: string[];
  readonly messages: string[];
  readonly failures: { readonly code: string; readonly retryAfter: string | undefined }[];
  opened(): number;
  closed(): number;
}

function recorder(): Recorder {
  const sequence: string[] = [];
  const messages: string[] = [];
  const failures: { code: string; retryAfter: string | undefined }[] = [];
  let openCount = 0;
  let closeCount = 0;
  return {
    sequence,
    messages,
    failures,
    opened: () => openCount,
    closed: () => closeCount,
    callbacks: {
      opened(): void {
        openCount += 1;
        sequence.push("opened");
      },
      message(frame: string): void {
        messages.push(frame);
        sequence.push(`message:${frame.length}`);
      },
      closed(code: number, reasonLength: number, wasClean: boolean): void {
        closeCount += 1;
        sequence.push(`closed:${code}:${reasonLength}:${wasClean}`);
      },
      failed(code: string, retryAfter?: string): void {
        failures.push({ code, retryAfter });
        sequence.push(`failed:${code}`);
      },
    },
  };
}

async function withProvider(
  work: (provider: FakeProvider, pki: TestPki) => Promise<void>,
  unknownCa = false,
  hooks: { onConnection?: () => void; onFrame?: (text: string) => void } = {},
): Promise<void> {
  const pki = createTestPki();
  let provider: FakeProvider | undefined;
  try {
    provider = await startFakeProvider({
      keyPem: unknownCa ? pki.unknownCaServerKeyPem : pki.serverKeyPem,
      certPem: unknownCa ? pki.unknownCaServerCertPem : pki.serverCertPem,
      ...hooks,
    });
    await work(provider, pki);
  } finally {
    if (provider !== undefined) {
      await provider.stop();
    }
    pki.cleanup();
  }
}

function payloadOfBytes(count: number): string {
  return "a".repeat(count);
}

function listSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        found.push(...listSources(full));
      }
    } else if (/\.(ts|js|cjs|mjs)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function repositoryRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

async function transportRejectsOversizeFrameAt65536Bytes(): Promise<void> {
  await withProvider(async (provider, pki) => {
    const record = recorder();
    const transport = new CoinbaseWsTransport({ ca: pki.caPem });
    transport.open(provider.url, record.callbacks);
    await until(() => record.opened() === 1, "client opens");
    provider.sendFrame(payloadOfBytes(COINBASE_MAX_PAYLOAD_BYTES));
    await until(() => record.messages.length === 1, "the exactly 65,536-byte frame is delivered");
    assert(record.messages[0]!.length === 65_536, "The delivered frame has 65,536 characters.");
    assert(Buffer.byteLength(record.messages[0]!, "utf8") === 65_536, "The delivered frame has 65,536 bytes.");
    await settle();
    assert(record.closed() === 0 && record.failures.length === 0, "A 65,536-byte frame leaves the connection open and clean.");
    provider.sendFrame(payloadOfBytes(COINBASE_MAX_PAYLOAD_BYTES + 1));
    await until(() => record.closed() >= 1, "oversize frame ends the connection");
    console.log(`oversize callback sequence: ${JSON.stringify(record.sequence)}`);
    assert(record.messages.length === 1, "The 65,537-byte frame is never delivered to message.");
    assert(record.failures.some((entry) => entry.code === "PAYLOAD_TOO_LARGE"), "Oversize frame reports PAYLOAD_TOO_LARGE.");
    assert(!record.failures.some((entry) => entry.code === "NETWORK"), "Oversize frame never reports NETWORK.");
    transport.close();
  });
  passed("transportRejectsOversizeFrameAt65536Bytes");
}

async function transportProductionDefaultsKeepTlsVerification(): Promise<void> {
  await withProvider(async (provider, pki) => {
    const refused = recorder();
    new CoinbaseWsTransport().open(provider.url, refused.callbacks);
    await until(() => refused.failures.length >= 1, "unknown CA is refused");
    await settle();
    assert(refused.failures[0]!.code === "TLS", `Unknown CA without a ca option reports TLS, saw ${refused.failures[0]!.code}.`);
    assert(refused.opened() === 0, "Unknown CA never opens.");
    assert(provider.connections() === 0 && provider.upgradeCount() === 0, "The refused handshake reaches no upgrade.");
    assert(provider.tcpConnections() >= 1, "The client did reach the server before refusing the certificate.");
    const allowed = recorder();
    const transport = new CoinbaseWsTransport({ ca: pki.unknownCaPem });
    transport.open(provider.url, allowed.callbacks);
    await until(() => allowed.opened() === 1, "matching trust anchor opens");
    assert(provider.connections() === 1, "The allowed path with the matching trust anchor establishes one connection.");
    transport.close();
  }, true);
  const forbidden = ["rejectUnauthorized", "NODE_TLS_REJECT_UNAUTHORIZED"];
  const offenders: string[] = [];
  for (const file of listSources(path.join(repositoryRoot(), "apps"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const word of forbidden) {
      if (text.includes(word)) {
        offenders.push(`${file}:${word}`);
      }
    }
  }
  assert(offenders.length === 0, `No file under apps/ disables TLS verification: ${offenders.join(", ")}`);
  for (const name of ["ws-client.ts", "session.ts"]) {
    const text = fs.readFileSync(path.join(repositoryRoot(), "apps", "market-data", "src", "coinbase", name), "utf8");
    for (const word of forbidden) {
      assert(!text.includes(word), `${name} does not contain ${word}.`);
    }
  }
  passed("transportProductionDefaultsKeepTlsVerification");
}

async function transportRefusesPlainWs(): Promise<void> {
  let plainConnections = 0;
  const plain = net.createServer((socket) => {
    plainConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    plain.listen(0, "127.0.0.1", resolve);
  });
  try {
    await withProvider(async (provider, pki) => {
      const plainPort = (plain.address() as net.AddressInfo).port;
      const allowed = recorder();
      const secure = new CoinbaseWsTransport({ ca: pki.caPem });
      secure.open(provider.url, allowed.callbacks);
      await until(() => allowed.opened() === 1, "wss opens on the same host");
      secure.close();
      const before = provider.tcpConnections();
      for (const url of [`ws://127.0.0.1:${provider.port}`, `ws://127.0.0.1:${plainPort}`]) {
        let thrown: unknown;
        try {
          new CoinbaseWsTransport({ ca: pki.caPem }).open(url, recorder().callbacks);
        } catch (error) {
          thrown = error;
        }
        assert(thrown instanceof Error && thrown.message === "CONFIGURATION", `Plain ws URL ${url} throws CONFIGURATION.`);
      }
      await settle();
      assert(provider.tcpConnections() === before, "The plain ws URL opened no new connection to the TLS server.");
      assert(plainConnections === 0, "The plain ws URL opened no connection to the plain listener.");
    });
  } finally {
    await new Promise<void>((resolve) => {
      plain.close(() => resolve());
    });
  }
  passed("transportRefusesPlainWs");
}

async function transportSendsNoAuthenticationHeader(): Promise<void> {
  await withProvider(async (provider, pki) => {
    const record = recorder();
    const transport = new CoinbaseWsTransport({ ca: pki.caPem });
    transport.open(provider.url, record.callbacks);
    await until(() => record.opened() === 1, "client opens");
    await until(() => provider.upgradeCount() === 1, "upgrade recorded");
    const names = provider.upgradeRequests[0]!.headerNames;
    console.log(`upgrade header names: ${JSON.stringify(names)}`);
    for (const forbidden of ["authorization", "cookie", "proxy-authorization", "x-api-key"]) {
      assert(!names.includes(forbidden), `The upgrade request carries no ${forbidden} header.`);
    }
    const allowed = ["host", "connection", "upgrade", "sec-websocket-version", "sec-websocket-key", "sec-websocket-extensions"];
    const extra = names.filter((name) => !allowed.includes(name));
    assert(extra.length === 0, `The upgrade header names are a subset of the allowed list, extra: ${JSON.stringify(extra)}`);
    transport.close();
  });
  passed("transportSendsNoAuthenticationHeader");
}

async function transportSubscribeMessageOverRealSocketIsExact(): Promise<void> {
  await withProvider(async (provider, pki) => {
    const record = recorder();
    const transport = new CoinbaseWsTransport({ ca: pki.caPem });
    transport.open(provider.url, record.callbacks);
    await until(() => record.opened() === 1, "client opens");
    transport.subscribe(["BTC-USD"]);
    await until(() => provider.frameCount() >= 1, "subscribe frame arrives");
    await settle();
    assert(provider.frameCount() === 1, "The server received exactly one frame.");
    const text = provider.receivedFrames[0]!;
    assert(
      text === '{"type":"subscribe","product_ids":["BTC-USD"],"channels":["ticker","matches","heartbeat"]}',
      `The subscribe frame is exact, saw ${text}.`,
    );
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert(JSON.stringify(Object.keys(parsed)) === JSON.stringify(["type", "product_ids", "channels"]), "No other keys are present.");
    transport.close();
  });
  passed("transportSubscribeMessageOverRealSocketIsExact");
}

function tickerAt(offsetMs: number, tradeId: number, symbol = "BTC-USD"): Record<string, unknown> {
  const iso = new Date(TICKER_BASE_MS + offsetMs).toISOString().replace("Z", "000Z");
  return ticker({
    product_id: symbol,
    sequence: tradeId,
    trade_id: tradeId,
    time: iso,
    best_bid: "100.00",
    best_bid_size: "1.00",
    best_ask: "100.02",
    best_ask_size: "1.00",
    price: "100.01",
    last_size: "1.00",
  });
}

async function normalFlow(provider: FakeProvider, harness: WireSession): Promise<void> {
  await until(() => provider.connections() === 1, "first connection");
  await until(() => provider.frameCount() === 1, "subscribe frame");
  provider.sendFrame({ type: "subscriptions", channels: [] });
  provider.sendFrame(match(10));
  provider.sendFrame(tickerAt(0, 1));
  provider.sendFrame(tickerAt(100, 2));
  provider.sendFrame(tickerAt(200, 3));
  provider.sendFrame(heartbeat("BTC-USD", 4, 10));
  await until(() => harness.port.calls.filter((call) => call === "append:btc").length === 3, "three observations appended");
}

async function wireEndToEndNormalFlowAcceptsTickers(): Promise<void> {
  const ordered: string[] = [];
  await withProvider(
    async (provider, pki) => {
      const harness = buildWireSession({ endpoint: provider.url, ca: pki.caPem, ordered });
      harness.clock.now = TICKER_BASE_MS;
      assert(TICKER_BASE_ISO === new Date(TICKER_BASE_MS).toISOString().replace("Z", "000Z"), "The fixture timestamp matches the clock.");
      await harness.session.connect();
      await normalFlow(provider, harness);
      await settle();
      assert(
        JSON.stringify(ordered) === JSON.stringify(["rest:BTC-USD", "socket", "subscribe"]),
        `Connect order is REST, socket, subscribe, saw ${JSON.stringify(ordered)}.`,
      );
      assert(harness.port.calls.filter((call) => call === "append:btc").length === 3, "Exactly three observations were appended.");
      assert(harness.port.availability.get("btc") === "AVAILABLE", "The instrument is AVAILABLE.");
      assert(harness.events.filter((event) => event.type === "failedAttempt").length === 0, "No failed attempt was recorded.");
      assert(harness.circuit.state() === "CLOSED", "The circuit stays CLOSED.");
      assert(harness.port.haltRequests.length === 0, "No halt was opened.");
    },
    false,
    {
      onConnection: () => ordered.push("socket"),
      onFrame: (text) => {
        if ((JSON.parse(text) as { type?: string }).type === "subscribe") {
          ordered.push("subscribe");
        }
      },
    },
  );
  passed("wireEndToEndNormalFlowAcceptsTickers");
}

async function wireServerCloseTriggersBackoffReconnect(): Promise<void> {
  const ordered: string[] = [];
  await withProvider(
    async (provider, pki) => {
      const harness = buildWireSession({ endpoint: provider.url, ca: pki.caPem, ordered });
      harness.clock.now = TICKER_BASE_MS;
      await harness.session.connect();
      await normalFlow(provider, harness);
      const base = harness.clock.now;
      provider.closeClient();
      await until(() => harness.events.filter((event) => event.type === "failedAttempt").length === 1, "one failed attempt");
      await settle();
      assert(harness.events.filter((event) => event.type === "failedAttempt").length === 1, "Exactly one failed attempt is recorded.");
      harness.scheduler.advanceTo(base + BACKOFF_FIRST_DELAY_MS - 1);
      await turns();
      await settle();
      assert(provider.upgradeCount() === 1 && size(harness.restCalls) === 1, "No reconnect before the first backoff delay.");
      harness.scheduler.advanceTo(base + BACKOFF_FIRST_DELAY_MS);
      await until(() => provider.connections() === 2, "second connection after the backoff");
      await until(() => provider.frameCount() === 2, "second subscribe frame");
      assert(
        JSON.stringify(ordered) ===
          JSON.stringify(["rest:BTC-USD", "socket", "subscribe", "rest:BTC-USD", "socket", "subscribe"]),
        `Reconnect repeats REST, socket, subscribe, saw ${JSON.stringify(ordered)}.`,
      );
      provider.sendFrame({ type: "subscriptions", channels: [] });
      provider.sendFrame(match(500));
      provider.sendFrame(match(501));
      provider.sendFrame(match(503));
      await until(() => harness.port.haltRequests.length === 1, "the control gap halts");
      await settle();
      assert(harness.port.haltRequests.length === 1, "Only the control gap halts.");
      assert(harness.port.haltRequests[0]!.reasonCode === "IN_SESSION_MATCH_GAP", "The halt reason is the in-session match gap.");
      assert(harness.port.haltRequests[0]!.tradeId === "503", "The first match after reconnect (500) was a baseline, not a gap.");
    },
    false,
    {
      onConnection: () => ordered.push("socket"),
      onFrame: (text) => {
        if ((JSON.parse(text) as { type?: string }).type === "subscribe") {
          ordered.push("subscribe");
        }
      },
    },
  );
  passed("wireServerCloseTriggersBackoffReconnect");
}

async function rateLimitedRun(retryAfter: string | undefined, expectedWaitMs: number): Promise<void> {
  await withProvider(async (provider, pki) => {
    const harness = buildWireSession({ endpoint: provider.url, ca: pki.caPem });
    provider.rejectNextUpgrade(429, retryAfter === undefined ? {} : { "Retry-After": retryAfter });
    await harness.session.connect();
    await until(() => harness.events.filter((event) => event.type === "failedAttempt").length === 1, "429 recorded as failed attempt");
    await until(() => provider.rejectedClosed() === 1, "the rejected upgrade socket is closed by the client");
    assert(provider.upgradeCount() === 1 && provider.connections() === 0, "Only the rejected upgrade was seen.");
    harness.scheduler.advanceTo(expectedWaitMs - 1);
    await turns();
    await settle();
    assert(provider.upgradeCount() === 1 && size(harness.restCalls) === 1, `No second attempt at ${expectedWaitMs - 1} ms.`);
    harness.scheduler.advanceTo(expectedWaitMs);
    await until(() => provider.connections() === 1, `second connection at ${expectedWaitMs} ms`);
    assert(provider.upgradeCount() === 2, "Exactly one new upgrade at the wait boundary.");
    assert(harness.events.filter((event) => event.type === "failedAttempt").length === 1, "Exactly one failed attempt in the event log.");
  });
}

async function transportDestroysRateLimitedUpgradeResponse(): Promise<void> {
  await withProvider(async (provider, pki) => {
    const record = recorder();
    provider.rejectNextUpgrade(429, { "Retry-After": "2" });
    new CoinbaseWsTransport({ ca: pki.caPem }).open(provider.url, record.callbacks);
    await until(() => record.failures.length >= 1, "429 reported");
    assert(
      record.failures[0]!.code === "RATE_LIMIT" && record.failures[0]!.retryAfter === "2",
      "429 reports RATE_LIMIT with Retry-After 2.",
    );
    await until(() => provider.rejectedClosed() === 1, "transport alone closes the rejected upgrade socket");
    assert(record.opened() === 0, "The rejected upgrade never opens.");
  });
}

async function wireHttp429UpgradeHonorsRetryAfter(): Promise<void> {
  await transportDestroysRateLimitedUpgradeResponse();
  await rateLimitedRun("2", 2000);
  await rateLimitedRun(undefined, 60_000);
  passed("wireHttp429UpgradeHonorsRetryAfter");
}

async function wireTlsFailureOpensThirtyMinuteCircuit(): Promise<void> {
  await withProvider(
    async (provider) => {
      const harness = buildWireSession({ endpoint: provider.url });
      await harness.session.connect();
      await until(() => harness.events.filter((event) => event.type === "remediationRequired").length === 1, "remediation event");
      await settle();
      assert(provider.tcpConnections() === 1 && provider.connections() === 0, "The first attempt reached TCP and no WebSocket opened.");
      harness.scheduler.advanceTo(1_799_999);
      await turns();
      await settle();
      assert(provider.tcpConnections() === 1 && size(harness.restCalls) === 1, "No connection attempt at 1,799,999 ms.");
      assert(harness.events.filter((event) => event.type === "remediationRequired").length === 1, "Exactly one remediation event.");
      harness.scheduler.advanceTo(1_800_000);
      await until(() => provider.tcpConnections() === 2, "one new attempt at 1,800,000 ms");
      await settle();
      assert(provider.tcpConnections() === 2 && size(harness.restCalls) === 2, "Exactly one attempt at 1,800,000 ms.");
    },
    true,
  );
  passed("wireTlsFailureOpensThirtyMinuteCircuit");
}

async function wireMalformedFramesForceReconnectAndHaltStaysAcrossReconnect(): Promise<void> {
  await withProvider(async (provider, pki) => {
    const harness = buildWireSession({ endpoint: provider.url, ca: pki.caPem, instrumentCount: 2 });
    const connecting = harness.session.connect();
    await turns();
    harness.scheduler.advanceTo(100);
    await connecting;
    await until(() => provider.connections() === 1 && provider.frameCount() === 1, "first connection subscribed");
    assert(
      provider.receivedFrames[0] ===
        '{"type":"subscribe","product_ids":["BTC-USD","ETH-USD"],"channels":["ticker","matches","heartbeat"]}',
      "Both instruments are subscribed on the first connection.",
    );
    provider.sendFrame('{"nope":true}');
    provider.sendFrame('{"nope":true}');
    await settle();
    assert(harness.events.length === 0, "Two malformed frames do not trip the circuit.");
    provider.sendFrame('{"nope":true}');
    await until(() => harness.events.some((event) => event.type === "reconnect"), "third malformed frame requests reconnect");
    harness.scheduler.advanceTo(100 + BACKOFF_FIRST_DELAY_MS);
    await turns();
    harness.scheduler.advanceTo(100 + BACKOFF_FIRST_DELAY_MS + 100);
    await until(() => provider.connections() === 2, "second connection after the backoff");
    await until(() => provider.frameCount() === 2, "second subscribe frame");
    provider.sendFrame({ type: "subscriptions", channels: [] });
    provider.sendFrame(match(1));
    provider.sendFrame(match(3));
    await until(() => harness.port.haltRequests.length === 1, "match gap opens a durable halt");
    assert(harness.port.haltRequests[0]!.reasonCode === "IN_SESSION_MATCH_GAP", "The halt reason is IN_SESSION_MATCH_GAP.");
    assert(harness.port.haltRequests[0]!.instrumentId === "btc", "The halted instrument is btc.");
    const restBefore = size(harness.restCalls);
    provider.closeClient();
    await until(() => harness.events.filter((event) => event.type === "failedAttempt").length >= 2, "second forced close recorded");
    harness.scheduler.advanceTo(harness.clock.now + 1250);
    await until(() => provider.connections() === 3, "third connection after the forced reconnect");
    await until(() => provider.frameCount() === 3, "third subscribe frame");
    assert(
      provider.receivedFrames[2] === '{"type":"subscribe","product_ids":["ETH-USD"],"channels":["ticker","matches","heartbeat"]}',
      `The halted instrument is absent from the subscription, saw ${provider.receivedFrames[2]}.`,
    );
    assert(
      JSON.stringify(harness.restCalls.slice(restBefore)) === JSON.stringify(["ETH-USD"]),
      "REST is not called for the halted instrument.",
    );
    assert(harness.port.haltRequests.length === 1, "No second halt was opened.");
  });
  passed("wireMalformedFramesForceReconnectAndHaltStaysAcrossReconnect");
}

async function main(): Promise<void> {
  assert(canonicalDecimal("2.00") !== undefined, "Decimal helper loads.");
  assert(new FakeClock().nowMs() === 0, "Fake clock loads.");
  await transportRejectsOversizeFrameAt65536Bytes();
  await transportProductionDefaultsKeepTlsVerification();
  await transportRefusesPlainWs();
  await transportSendsNoAuthenticationHeader();
  await transportSubscribeMessageOverRealSocketIsExact();
  await wireEndToEndNormalFlowAcceptsTickers();
  await wireServerCloseTriggersBackoffReconnect();
  await wireHttp429UpgradeHonorsRetryAfter();
  await wireTlsFailureOpensThirtyMinuteCircuit();
  await wireMalformedFramesForceReconnectAndHaltStaysAcrossReconnect();
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
