import WebSocket = require("ws");
import type { MarketDataErrorCode } from "../../../../packages/market-data/src";

export const COINBASE_MAX_PAYLOAD_BYTES = 65_536;
export interface WireCallbacks {
  opened(): void;
  message(frame: string): void;
  closed(code: number, reasonLength: number, wasClean: boolean): void;
  failed(code: MarketDataErrorCode, retryAfter?: string): void;
}
export interface WireTransport {
  open(endpoint: string, callbacks: WireCallbacks): void;
  subscribe(productIds: readonly string[]): void;
  close(): void;
}
export interface SocketLike {
  on(event: string, callback: (...args: never[]) => void): SocketLike;
  send(data: string): void;
  close(): void;
}
export interface WsTransportOptions {
  readonly ca?: string | Buffer;
  readonly socketFactory?: (url: string, options: object) => SocketLike;
}

function failureCode(error: unknown): MarketDataErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
    return "PAYLOAD_TOO_LARGE";
  }
  return /CERT|TLS|SSL|UNABLE_TO_VERIFY/.test(code) ? "TLS" : "NETWORK";
}

export class CoinbaseWsTransport implements WireTransport {
  private socket: SocketLike | undefined;
  public constructor(private readonly options: WsTransportOptions = {}) {}

  public open(endpoint: string, callbacks: WireCallbacks): void {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("CONFIGURATION");
    }
    if (parsed.protocol !== "wss:") {
      throw new Error("CONFIGURATION");
    }
    const factory = this.options.socketFactory ?? ((url: string, options: object) => new WebSocket(url, options));
    const socket = factory(endpoint, {
      maxPayload: COINBASE_MAX_PAYLOAD_BYTES,
      ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
    });
    this.socket = socket;
    socket.on("open", () => callbacks.opened());
    socket.on("message", ((data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        callbacks.message(data.toString());
      }
    }) as never);
    socket.on("close", ((code: number, reason: Buffer) => {
      if (code === 1009) {
        callbacks.failed("PAYLOAD_TOO_LARGE");
      }
      callbacks.closed(code, reason.length, code === 1000);
    }) as never);
    socket.on("unexpected-response", ((_request: unknown, response: import("http").IncomingMessage) => {
      if (response.statusCode === 429) {
        const retryAfter = response.headers["retry-after"];
        callbacks.failed("RATE_LIMIT", typeof retryAfter === "string" ? retryAfter : undefined);
      } else {
        callbacks.failed("NETWORK");
      }
      response.destroy();
    }) as never);
    socket.on("error", ((error: Error) => callbacks.failed(failureCode(error))) as never);
  }
  public subscribe(productIds: readonly string[]): void {
    this.socket?.send(JSON.stringify({ type: "subscribe", product_ids: productIds, channels: ["ticker", "matches", "heartbeat"] }));
  }
  public close(): void {
    this.socket?.close();
  }
}
