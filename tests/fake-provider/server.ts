import * as https from "https";
import type { IncomingMessage } from "http";
import type { AddressInfo, Socket } from "net";
import type { Duplex } from "stream";
import WebSocket = require("ws");

export interface FakeProviderOptions {
  readonly keyPem: string;
  readonly certPem: string;
  readonly onConnection?: () => void;
  readonly onFrame?: (text: string) => void;
}

export interface UpgradeRecord {
  readonly headerNames: readonly string[];
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface FakeProvider {
  readonly url: string;
  readonly port: number;
  connections(): number;
  tcpConnections(): number;
  rejectedClosed(): number;
  upgradeCount(): number;
  frameCount(): number;
  readonly upgradeRequests: readonly UpgradeRecord[];
  readonly receivedFrames: readonly string[];
  sendFrame(frame: object | string): void;
  sendRaw(bytes: Buffer): void;
  closeClient(code?: number): void;
  rejectNextUpgrade(statusCode: number, headers: Readonly<Record<string, string>>): void;
  stop(): Promise<void>;
}

interface PendingRejection {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
}

function rejectionText(rejection: PendingRejection): string {
  const lines = [`HTTP/1.1 ${rejection.statusCode} Synthetic Rejection`];
  for (const [name, value] of Object.entries(rejection.headers)) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("Content-Length: 0");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export async function startFakeProvider(options: FakeProviderOptions): Promise<FakeProvider> {
  const server = https.createServer({ key: options.keyPem, cert: options.certPem });
  const sockets = new Set<Socket>();
  const clients = new Set<WebSocket>();
  const upgradeRequests: UpgradeRecord[] = [];
  const receivedFrames: string[] = [];
  const state = { connections: 0, tcpConnections: 0, rejectedClosed: 0 };
  let pending: PendingRejection | undefined;
  let latest: WebSocket | undefined;
  const websocketServer = new WebSocket.WebSocketServer({ noServer: true });

  server.on("connection", (socket: Socket) => {
    state.tcpConnections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => undefined);
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgradeRequests.push({ headerNames: Object.keys(request.headers), headers: { ...request.headers } });
    if (pending !== undefined) {
      const rejection = pending;
      pending = undefined;
      socket.on("close", () => {
        state.rejectedClosed += 1;
      });
      socket.on("error", () => undefined);
      socket.write(rejectionText(rejection));
      return;
    }
    websocketServer.handleUpgrade(request, socket as never, head, (client: WebSocket) => {
      state.connections += 1;
      clients.add(client);
      latest = client;
      client.on("message", (data: unknown) => {
        const text = String(data);
        receivedFrames.push(text);
        options.onFrame?.(text);
      });
      client.on("error", () => undefined);
      client.on("close", () => clients.delete(client));
      options.onConnection?.();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `wss://127.0.0.1:${port}`,
    port,
    connections(): number {
      return state.connections;
    },
    tcpConnections(): number {
      return state.tcpConnections;
    },
    rejectedClosed(): number {
      return state.rejectedClosed;
    },
    upgradeCount(): number {
      return upgradeRequests.length;
    },
    frameCount(): number {
      return receivedFrames.length;
    },
    get upgradeRequests(): readonly UpgradeRecord[] {
      return upgradeRequests;
    },
    get receivedFrames(): readonly string[] {
      return receivedFrames;
    },
    sendFrame(frame: object | string): void {
      latest?.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    },
    sendRaw(bytes: Buffer): void {
      latest?.send(bytes);
    },
    closeClient(code?: number): void {
      for (const client of clients) {
        if (code === undefined) {
          client.terminate();
        } else {
          client.close(code);
        }
      }
    },
    rejectNextUpgrade(statusCode: number, headers: Readonly<Record<string, string>>): void {
      pending = { statusCode, headers };
    },
    stop(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const client of clients) {
          client.terminate();
        }
        for (const socket of sockets) {
          socket.destroy();
        }
        websocketServer.close();
        server.close(() => resolve());
      });
    },
  };
}
