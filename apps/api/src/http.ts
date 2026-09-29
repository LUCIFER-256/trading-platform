import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseInfrastructureError, sql, type KyselyDatabase } from "../../../packages/database/src";
import { authenticateAndCreateSession, createOpaqueSecret, type PasswordHasher } from "./auth";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_REQUEST_TARGET_BYTES = 2 * 1024;
const CSRF_TOKEN_BYTES = 32;
const SESSION_COOKIE = "__Host-platform_session";
const CSRF_COOKIE = "__Host-platform_csrf";

export interface HttpApiDependencies {
  readonly database: KyselyDatabase;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly passwordHasher?: PasswordHasher;
}

export interface HttpApiServer {
  readonly server: Server;
  close(): Promise<void>;
}

export function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === "") throw new Error("PLATFORM_ALLOWED_ORIGINS is required.");
  const origins = value.split(",").map((origin) => origin.trim());
  if (origins.some((origin) => !isExactHttpsOrigin(origin))) throw new Error("PLATFORM_ALLOWED_ORIGINS contains an invalid origin.");
  return new Set(origins);
}

export function createHttpApiServer(dependencies: HttpApiDependencies): HttpApiServer {
  const server = createServer({ maxHeaderSize: 8 * 1024 }, (request, response) => {
    void handleRequest(request, response, dependencies);
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (error, socket) => {
    const status = (error as NodeJS.ErrnoException).code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
    socket.end(`HTTP/1.1 ${status} ${status === 431 ? "Request Header Fields Too Large" : "Bad Request"}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${JSON.stringify({ error: status === 431 ? "request_headers_too_large" : "invalid_request" })}`);
  });
  return { server, close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))) };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, dependencies: HttpApiDependencies): Promise<void> {
  try {
    if ((request.url?.length ?? 0) > MAX_REQUEST_TARGET_BYTES) return send(response, 400, "invalid_request");
    const path = request.url?.split("?", 1)[0];
    if (request.method === "GET" && path === "/v1/auth/csrf") return sendCsrf(response);
    if (request.method === "POST" && path === "/v1/auth/login") return await login(request, response, dependencies);
    if (request.method === "POST" && path === "/v1/auth/logout") return await logout(request, response, dependencies);
    return send(response, 404, "not_found");
  } catch (error) {
    if (error instanceof BodyTooLargeError) return send(response, 413, "request_too_large");
    if (error instanceof RequestTimeoutError) return send(response, 408, "request_timeout");
    if (error instanceof InvalidRequestError) return send(response, 400, "invalid_request");
    return send(response, isDatabaseUnavailable(error) ? 503 : 500, isDatabaseUnavailable(error) ? "service_unavailable" : "internal_error");
  }
}

function sendCsrf(response: ServerResponse): void {
  response.setHeader("Set-Cookie", csrfCookie(createCsrfToken(), 600));
  send(response, 204);
}

async function login(request: IncomingMessage, response: ServerResponse, dependencies: HttpApiDependencies): Promise<void> {
  if (!hasAcceptedOrigin(request, dependencies.allowedOrigins) || !hasValidCsrf(request)) return send(response, 403, "request_rejected");
  const body = await readJson(request);
  if (!isLoginBody(body)) return send(response, 400, "invalid_request");
  const session = await authenticateAndCreateSession(dependencies.database, body.userCode, body.password, dependencies.passwordHasher);
  if (session === undefined) return send(response, 401, "authentication_required");
  response.setHeader("Set-Cookie", [sessionCookie(`${session.sessionId}.${session.sessionSecret}`), csrfCookie(createCsrfToken(), 28_800)]);
  send(response, 204);
}

async function logout(request: IncomingMessage, response: ServerResponse, dependencies: HttpApiDependencies): Promise<void> {
  if (!hasAcceptedOrigin(request, dependencies.allowedOrigins) || !hasValidCsrf(request)) return send(response, 403, "request_rejected");
  const session = parseSessionCookie(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
  if (session !== undefined) await sql`select platform.revoke_auth_session(${session.id}, 'http_logout')`.execute(dependencies.database);
  response.setHeader("Set-Cookie", [expiredCookie(SESSION_COOKIE, true), expiredCookie(CSRF_COOKIE, false)]);
  send(response, 204);
}

function send(response: ServerResponse, status: number, error?: string): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (error === undefined) { response.end(); return; }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ error }));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json; charset=utf-8") throw new InvalidRequestError();
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new RequestTimeoutError()), 15_000);
    request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY_BYTES) reject(new BodyTooLargeError()); else chunks.push(chunk); });
    request.once("end", () => { clearTimeout(timeout); resolve(); });
    request.once("error", reject);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new InvalidRequestError(); }
}

class BodyTooLargeError extends Error {}
class RequestTimeoutError extends Error {}
class InvalidRequestError extends Error {}
function isLoginBody(value: unknown): value is { readonly userCode: string; readonly password: string } {
  return value !== null && typeof value === "object" && Object.keys(value).length === 2 && typeof (value as Record<string, unknown>).userCode === "string" && typeof (value as Record<string, unknown>).password === "string";
}
function isExactHttpsOrigin(origin: string): boolean { try { const url = new URL(origin); return url.protocol === "https:" && url.origin === origin && url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === ""; } catch { return false; } }
function parseCookies(header: string | undefined): Readonly<Record<string, string>> { if (header === undefined) return {}; return Object.fromEntries(header.split(";").map((part) => { const index = part.indexOf("="); return index < 1 ? ["", ""] : [part.slice(0, index).trim(), part.slice(index + 1)]; })); }
function hasAcceptedOrigin(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): boolean { const origin = request.headers.origin; return typeof origin === "string" && allowedOrigins.has(origin); }
function hasValidCsrf(request: IncomingMessage): boolean { const cookie = parseCookies(request.headers.cookie)[CSRF_COOKIE]; const header = request.headers["x-csrf-token"]; return typeof cookie === "string" && typeof header === "string" && cookie.length === 43 && header.length === 43 && timingSafeEqual(Buffer.from(cookie), Buffer.from(header)); }
function createCsrfToken(): string { return randomBytes(CSRF_TOKEN_BYTES).toString("base64url"); }
function sessionCookie(value: string): string { return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`; }
function csrfCookie(value: string, maxAge: number): string { return `${CSRF_COOKIE}=${value}; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`; }
function expiredCookie(name: string, httpOnly: boolean): string { return `${name}=;${httpOnly ? " HttpOnly;" : ""} Secure; SameSite=Strict; Path=/; Max-Age=0`; }
export interface ParsedSessionCookie {
  readonly id: string;
  readonly secret: string;
}

/** Parses both opaque components so authenticated routes can pass them to database authority checks. */
export function parseSessionCookie(value: string | undefined): ParsedSessionCookie | undefined {
  const match = value?.match(/^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i);
  return match === null || match === undefined ? undefined : { id: match[1]!, secret: match[2]! };
}
function isDatabaseUnavailable(error: unknown): boolean { const code = error instanceof DatabaseInfrastructureError ? error.code : error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined; return code === "CONNECTION_FAILURE" || code === "POOL_RESOURCE_FAILURE" || code === "ECONNREFUSED" || code === "57P01" || code === "57P02" || code === "57P03" || code === "08000" || code === "08001" || code === "08003" || code === "08006"; }
