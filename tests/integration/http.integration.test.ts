import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import { tmpdir } from "node:os";
import { createDatabaseClient, runPendingMigrations, sql, type DatabaseClient } from "../../packages/database/src";
import { createProductionPasswordHasher } from "../../apps/api/src/auth";
import { parseSessionCookie } from "../../apps/api/src/http";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function log(step: string): void { console.error(`[HTTP CHECKPOINT] ${step}`); }
function run(command: string, args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, [...args], { cwd }, (error, stdout, stderr) => error === null ? resolve(stdout) : reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`))));
}
function wait(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close((error) => error === undefined ? resolve((address as net.AddressInfo).port) : reject(error)); }); });
}
async function eventually(action: () => Promise<void>, attempts = 80): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) { try { await action(); return; } catch (error) { last = error; await wait(250); } }
  throw last;
}
interface Response { readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: string; }
function requestHttps(port: number, input: { readonly method: string; readonly path: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string; readonly ca: Buffer }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: "localhost", port, method: input.method, path: input.path, headers: input.headers, ca: input.ca, rejectUnauthorized: true }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject); if (input.body !== undefined) request.write(input.body); request.end();
  });
}
function requestHttp(port: number, pathValue: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: pathValue }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") })); });
    request.once("error", reject); request.end();
  });
}
function rawTls(port: number, ca: Buffer, fragments: readonly { readonly value: string; readonly pauseAfterMs?: number }[], acceptConnectionClose = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "localhost", port, ca, servername: "localhost", rejectUnauthorized: true }); let output = ""; let index = 0; let settled = false;
    const finish = (error?: Error): void => { if (settled) return; settled = true; if (error === undefined) resolve(output); else reject(error); };
    const send = (): void => { const fragment = fragments[index++]; if (fragment === undefined) return; socket.write(fragment.value); if (fragment.pauseAfterMs === undefined) send(); else setTimeout(send, fragment.pauseAfterMs); };
    socket.once("secureConnect", send); socket.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); }); socket.once("end", () => finish()); socket.once("close", () => { if (acceptConnectionClose) finish(); }); socket.once("error", (error) => { if (acceptConnectionClose) finish(); else finish(error); }); socket.setTimeout(25_000, () => { socket.destroy(new Error("raw TLS request timed out")); });
  });
}
function cookie(response: Response, name: string): string {
  const header = response.headers["set-cookie"]?.find((value) => value.startsWith(`${name}=`));
  assert(header !== undefined, `Expected ${name} Set-Cookie header.`); return header.split(";", 1)[0]!.slice(name.length + 1);
}
function cookies(response: Response): string { return `${"__Host-platform_csrf"}=${cookie(response, "__Host-platform_csrf")}`; }
function assertJson(response: Response, status: number, error?: string): void { assert(response.status === status, `Expected HTTP ${status}, got ${response.status}: ${response.body}`); if (error !== undefined) assert(response.body === JSON.stringify({ error }), `Expected ${error} envelope, got ${response.body}`); }
function assertHardened(response: Response): void { assert(response.headers["cache-control"] === "no-store", "Response must have Cache-Control: no-store."); assert(response.headers["x-content-type-options"] === "nosniff", "Response must have X-Content-Type-Options: nosniff."); assert(response.headers["referrer-policy"] === "no-referrer", "Response must have Referrer-Policy: no-referrer."); }
function loginHeaders(csrf: string): Readonly<Record<string, string>> { return { Origin: "https://localhost", Cookie: `__Host-platform_csrf=${csrf}`, "X-CSRF-Token": csrf, "Content-Type": "application/json; charset=utf-8" }; }
async function startPostgres(name: string, port: number): Promise<void> { await run("docker", ["run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=postgres", "-p", `${port}:5432`, "postgres:18.6"]); await eventually(async () => { await run("docker", ["exec", name, "pg_isready", "-U", "postgres"]); }); }
async function stopContainer(name: string): Promise<void> { try { await run("docker", ["rm", "-f", name]); } catch { /* already removed */ } }
async function startNginx(name: string, image: string, httpPort: number, httpsPort: number, socketDirectory: string, tlsDirectory: string): Promise<void> {
  await run("docker", ["run", "--rm", "-d", "--name", name, "-p", `${httpPort}:80`, "-p", `${httpsPort}:443`, "-v", `${socketDirectory}:/run/trading-platform`, "-v", `${tlsDirectory}:/etc/trading-platform/tls:ro`, image]);
}
async function seedDatabase(client: DatabaseClient): Promise<{ readonly userCode: string; readonly password: string }> {
  await runPendingMigrations(client, { migrationFolder: path.resolve(__dirname, "../../packages/database/src/migrations"), migrationTableName: `http_migrations_${process.pid}`, migrationLockTableName: `http_migrations_lock_${process.pid}` });
  const password = "http-integration-password"; const hash = await createProductionPasswordHasher().hash(password); const userCode = `http-user-${process.pid}-${Date.now()}`;
  const user = await sql<{ readonly id: string }>`insert into platform.users (user_code, enabled) values (${userCode}, true) returning id`.execute(client.database); const userId = user.rows[0]?.id; assert(userId !== undefined, "HTTP integration user must be created.");
  await sql`insert into platform.password_credentials (user_id, password_hash, credential_version) values (${userId}, ${hash}, 1)`.execute(client.database);
  return { userCode, password };
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../../.."); const apiUid = process.getuid?.(); assert(apiUid !== undefined, "The Linux integration harness requires a numeric API UID."); const nonce = `${process.pid}-${Date.now()}`; const databaseName = `trading-http-postgres-${nonce}`; const nginxName = `trading-http-nginx-${nonce}`; const nginxImage = "trading-http-nginx-phase41-test";
  const postgresPort = await freePort(); const httpPort = await freePort(); const httpsPort = await freePort(); const temporary = await mkdtemp(path.join(tmpdir(), "trading-http-")); const socketDirectory = path.join(temporary, "socket"); const tlsDirectory = path.join(temporary, "tls");
  await run("mkdir", ["-p", socketDirectory, tlsDirectory]); await chmod(socketDirectory, 0o750);
  let database: DatabaseClient | undefined; let node: ChildProcess | undefined;
  try {
    log("building pinned NGINX image and starting PostgreSQL 18.6"); await run("docker", ["build", "-t", nginxImage, "infra/nginx"], root); await startPostgres(databaseName, postgresPort);
    const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/postgres`; database = createDatabaseClient({ runtimeMode: "test", environment: { TEST_DATABASE_URL: adminUrl, DATABASE_SSL_MODE: "disable" } }); await eventually(() => database!.checkHealth()); const credentials = await seedDatabase(database);
    log("creating mkcert TLS material"); await run("mkcert", ["-cert-file", path.join(tlsDirectory, "localhost.pem"), "-key-file", path.join(tlsDirectory, "localhost-key.pem"), "localhost", "127.0.0.1", "::1"]); const caroot = (await run("mkcert", ["-CAROOT"])).trim(); const ca = await readFile(path.join(caroot, "rootCA.pem"));
    const runtimeUrl = `${adminUrl}?options=${encodeURIComponent("-c role=platform_runtime")}`; log("starting Unix-socket Node API"); node = spawn(process.execPath, [path.join(root, "dist/apps/api/src/http-server.js")], { cwd: root, env: { ...process.env, API_LISTEN_SOCKET: path.join(socketDirectory, "api.sock"), TRADING_MODE: "development", DATABASE_URL: runtimeUrl, DATABASE_SSL_MODE: "disable", PLATFORM_ALLOWED_ORIGINS: "https://localhost" }, stdio: ["ignore", "pipe", "pipe"] });
    let nodeOutput = ""; node.stdout?.on("data", (value: Buffer) => { nodeOutput += value; }); node.stderr?.on("data", (value: Buffer) => { nodeOutput += value; }); log("starting NGINX"); await startNginx(nginxName, nginxImage, httpPort, httpsPort, socketDirectory, tlsDirectory); await run("docker", ["exec", nginxName, "sh", "-c", `chown ${apiUid}:101 /run/trading-platform && chmod 750 /run/trading-platform`]); await eventually(async () => { await run("docker", ["exec", nginxName, "sh", "-c", `chown ${apiUid}:101 /run/trading-platform/api.sock && chmod 660 /run/trading-platform/api.sock`]); }); const socketMode = await run("docker", ["exec", nginxName, "stat", "-c", "%a %u %g", "/run/trading-platform/api.sock"]); assert(socketMode.trim() === `660 ${apiUid} 101`, `Socket permissions must grant only the API owner and NGINX group: ${socketMode}`); log("waiting for HTTPS readiness"); await wait(250); const ready = await requestHttps(httpsPort, { method: "GET", path: "/v1/auth/csrf", ca }); assert(ready.status === 204 && ready.headers["set-cookie"]?.some((value) => /^__Host-platform_csrf=[A-Za-z0-9_-]{43}; Secure; SameSite=Strict; Path=\/; Max-Age=600$/.test(value)), `CSRF route must issue its distinctive CSRF cookie, not only return 204: ${ready.status} ${ready.body}; Node output: ${nodeOutput}`);
    log("verifying HTTPS transport, cookie flags, and first-time-user rejection");
    const redirect = await requestHttp(httpPort, "/v1/auth/csrf"); assert(redirect.status === 308 && redirect.headers.location === "https://localhost/v1/auth/csrf", "Port 80 must redirect to canonical HTTPS.");
    const firstTime = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/login", ca, headers: { Origin: "https://localhost", "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(credentials) }); assertJson(firstTime, 403, "request_rejected"); assertHardened(firstTime);
    const csrfIssued = await requestHttps(httpsPort, { method: "GET", path: "/v1/auth/csrf", ca }); assert(csrfIssued.status === 204, "CSRF issuance must return 204."); assertHardened(csrfIssued); const csrfSetCookie = csrfIssued.headers["set-cookie"]?.[0] ?? ""; assert(csrfSetCookie === `__Host-platform_csrf=${cookie(csrfIssued, "__Host-platform_csrf")}; Secure; SameSite=Strict; Path=/; Max-Age=600`, `Observed CSRF cookie flags were incorrect: ${csrfSetCookie}`); const csrf = cookie(csrfIssued, "__Host-platform_csrf");
    const login = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/login", ca, headers: loginHeaders(csrf), body: JSON.stringify(credentials) }); assert(login.status === 204, `Valid login must succeed, got ${login.status}: ${login.body}`); assertHardened(login); const sessionSetCookie = login.headers["set-cookie"]?.find((value) => value.startsWith("__Host-platform_session=")) ?? ""; assert(/^__Host-platform_session=[0-9a-f-]+\.[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/i.test(sessionSetCookie), `Observed session cookie flags were incorrect: ${sessionSetCookie}`); const parsed = parseSessionCookie(cookie(login, "__Host-platform_session")); assert(parsed !== undefined && parsed.secret.length === 43, "Session cookie parser must round-trip the issued secret.");
    const rotatedCsrf = cookie(login, "__Host-platform_csrf"); const sessionCookie = `__Host-platform_session=${cookie(login, "__Host-platform_session")}; __Host-platform_csrf=${rotatedCsrf}`;
    const absentOrigin = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/logout", ca, headers: { Cookie: sessionCookie, "X-CSRF-Token": rotatedCsrf } }); assertJson(absentOrigin, 403, "request_rejected");
    const crossOrigin = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/logout", ca, headers: { Origin: "https://evil.example", Cookie: sessionCookie, "X-CSRF-Token": rotatedCsrf } }); assertJson(crossOrigin, 403, "request_rejected"); assert(Object.keys(crossOrigin.headers).every((name) => !name.startsWith("access-control-allow-")), "Cross-origin rejection must emit no CORS permission.");
    const mismatchCsrf = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/logout", ca, headers: { Origin: "https://localhost", Cookie: sessionCookie, "X-CSRF-Token": "x".repeat(43) } }); assertJson(mismatchCsrf, 403, "request_rejected");
    const malformed = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/login", ca, headers: loginHeaders(rotatedCsrf), body: "{" }); assertJson(malformed, 400, "invalid_request");
    const contentType = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/login", ca, headers: { ...loginHeaders(rotatedCsrf), "Content-Type": "application/json" }, body: JSON.stringify(credentials) }); assertJson(contentType, 400, "invalid_request");
    const declaredLarge = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/login", ca, headers: { ...loginHeaders(rotatedCsrf), "Content-Length": "8193" }, body: "x".repeat(8193) }); assertJson(declaredLarge, 413, "request_too_large");
    log("verifying streamed overflow, header overflow, and timeouts through NGINX");
    const chunked = await rawTls(httpsPort, ca, [`POST /v1/auth/login HTTP/1.1\r\nHost: localhost\r\nOrigin: https://localhost\r\nCookie: __Host-platform_csrf=${rotatedCsrf}\r\nX-CSRF-Token: ${rotatedCsrf}\r\nContent-Type: application/json; charset=utf-8\r\nTransfer-Encoding: chunked\r\n\r\n2001\r\n${"x".repeat(8193)}\r\n0\r\n\r\n`].map((value) => ({ value }))); assert(/^HTTP\/1\.1 413\b/m.test(chunked) && chunked.includes('{"error":"request_too_large"}'), `Chunked overflow must be 413: ${chunked}`);
    const headersTooLarge = await rawTls(httpsPort, ca, [{ value: `GET / HTTP/1.1\r\nHost: localhost\r\nX-Long: ${"a".repeat(9 * 1024)}\r\n\r\n` }]); assert(/^HTTP\/1\.1 431\b/m.test(headersTooLarge) && headersTooLarge.includes('{"error":"request_headers_too_large"}'), `Header overflow must be 431: ${headersTooLarge}`);
    const body = JSON.stringify(credentials); const [slowHeader, slowBody] = await Promise.all([
      // NGINX must finish parsing request headers before it can select an upstream, so a slow header closes without a response.
      rawTls(httpsPort, ca, [{ value: "GET / HTTP/1.1\r\nHost: localhost\r\n", pauseAfterMs: 11_000 }], true),
      rawTls(httpsPort, ca, [{ value: `POST /v1/auth/login HTTP/1.1\r\nHost: localhost\r\nOrigin: https://localhost\r\nCookie: __Host-platform_csrf=${rotatedCsrf}\r\nX-CSRF-Token: ${rotatedCsrf}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 1)}`, pauseAfterMs: 16_000 }])
    ]); assert(slowHeader === "", `Slow header must close without an HTTP response: ${slowHeader}`); assert(/^HTTP\/1\.1 408\b/m.test(slowBody) && slowBody.includes('{"error":"request_timeout"}'), `Slow body must be rejected with JSON 408: ${slowBody}`);
    const socketListing = await run("ss", ["-ltnp"]); assert(!socketListing.includes(`pid=${node.pid}`), "The Node API process must not own a public TCP listener.");
    log("verifying valid logout, database revocation, and fresh NGINX leaky-bucket boundary");
    const logout = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/logout", ca, headers: { Origin: "https://localhost", Cookie: sessionCookie, "X-CSRF-Token": rotatedCsrf } }); assert(logout.status === 204, "Valid logout must succeed."); const revoked = await sql<{ readonly revoked_at: Date | null }>`select revoked_at from platform.auth_sessions where id = ${parsed.id}`.execute(database.database); assert(revoked.rows[0]?.revoked_at !== null, "Logout must revoke the database session selected by the parsed cookie.");
    await stopContainer(nginxName); await startNginx(nginxName, nginxImage, httpPort, httpsPort, socketDirectory, tlsDirectory); await eventually(async () => { const response = await requestHttps(httpsPort, { method: "GET", path: "/v1/auth/csrf", ca }); assert(response.status === 204, "Fresh NGINX must become ready."); }); const rateCsrfResponse = await requestHttps(httpsPort, { method: "GET", path: "/v1/auth/csrf", ca }); const rateCsrf = cookie(rateCsrfResponse, "__Host-platform_csrf"); const rateAttempts: Response[] = []; for (let attempt = 0; attempt < 11; attempt += 1) rateAttempts.push(await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/login", ca, headers: loginHeaders(rateCsrf), body: JSON.stringify(credentials) })); assert(rateAttempts.slice(0, 10).every((response) => response.status === 204) && rateAttempts[10]?.status === 429, `Fresh login limiter must accept ten then reject eleven: ${rateAttempts.map((response) => response.status).join(",")}`); assertJson(rateAttempts[10]!, 429, "rate_limited"); assert(typeof rateAttempts[10]?.headers["retry-after"] === "string", "Rate-limit response must provide Retry-After.");
    await stopContainer(nginxName); await startNginx(nginxName, nginxImage, httpPort, httpsPort, socketDirectory, tlsDirectory); await eventually(async () => { const response = await requestHttps(httpsPort, { method: "GET", path: "/v1/auth/csrf", ca }); assert(response.status === 204, "Fresh NGINX must become ready for the database-unavailable probe."); }); log("inducing real PostgreSQL unavailability and observing safe 503"); await stopContainer(databaseName); const unavailable = await requestHttps(httpsPort, { method: "POST", path: "/v1/auth/login", ca, headers: loginHeaders(rateCsrf), body: JSON.stringify(credentials) }); assertJson(unavailable, 503, "service_unavailable"); assertHardened(unavailable);
    console.log("HTTP NGINX/TLS/PostgreSQL black-box integration tests passed.");
  } finally {
    if (node !== undefined && !node.killed) { node.kill("SIGKILL"); await new Promise<void>((resolve) => node?.once("exit", () => resolve()) ?? resolve()); }
    if (database !== undefined) await database.close().catch(() => undefined); await stopContainer(nginxName); await stopContainer(databaseName); await rm(temporary, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
