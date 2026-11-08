import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { HttpsProductFetcher, ProductFetchError, REST_TIMEOUT_MS } from "../../apps/market-data/src/coinbase/rest-fetcher";
import { assert, createTestPki, product } from "./support/market-data-wire-helpers";

type Handler = (url: string, response: import("node:http").ServerResponse) => void;

async function withServer(
  pki: ReturnType<typeof createTestPki>,
  handler: Handler,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = https.createServer({ key: pki.serverKeyPem, cert: pki.serverCertPem }, (request, response) => {
    handler(request.url ?? "", response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function failsWith(call: Promise<unknown>, code: string, message: string): Promise<void> {
  try {
    await call;
  } catch (error) {
    assert(error instanceof ProductFetchError && error.code === code, `${message} (got ${String(error)}).`);
    return;
  }
  throw new Error(`${message}: call must fail.`);
}

async function unitHttpsProductFetcher(): Promise<void> {
  const pki = createTestPki();
  try {
    await withServer(
      pki,
      (url, response) => {
        if (url === "/products/BTC-USD") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(product("BTC-USD")));
        } else if (url === "/products/ETH-USD") {
          response.writeHead(429, { "retry-after": "7" });
          response.end("{}");
        } else if (url === "/products/SOL-USD") {
          response.writeHead(200);
          response.end("not json");
        } else if (url === "/products/ADA-USD") {
          response.writeHead(200);
          response.end("x".repeat(70_000));
        } else if (url === "/products/XRP-USD") {
          response.writeHead(500);
          response.end("{}");
        }
      },
      async (port) => {
        const base = `https://127.0.0.1:${port}`;
        const fetcher = new HttpsProductFetcher({ baseUrl: base, ca: pki.caPem, timeoutMs: 400 });
        const ok = await fetcher.getProduct("BTC-USD");
        assert(ok.status === 200, "A 200 response must pass through.");
        assert((ok.body as unknown as { id: string }).id === "BTC-USD", "The body must parse.");
        const limited = await fetcher.getProduct("ETH-USD");
        assert(limited.status === 429 && limited.retryAfter === "7", "Status and Retry-After must be reported.");
        const failed = await fetcher.getProduct("XRP-USD");
        assert(failed.status === 500 && failed.retryAfter === undefined, "A server error must report status only.");
        await failsWith(fetcher.getProduct("SOL-USD"), "BODY", "A non-JSON body must be refused");
        await failsWith(fetcher.getProduct("ADA-USD"), "TOO_LARGE", "An oversized body must be refused");
        await failsWith(fetcher.getProduct("btc/../x"), "CONFIGURATION", "A bad product id must be refused");
        const untrusting = new HttpsProductFetcher({ baseUrl: base, ca: pki.unknownCaPem, timeoutMs: 400 });
        await failsWith(untrusting.getProduct("BTC-USD"), "NETWORK", "An untrusted certificate must be refused");
        const defaults = new HttpsProductFetcher({ baseUrl: base, timeoutMs: 400 });
        await failsWith(defaults.getProduct("BTC-USD"), "NETWORK", "Default trust must refuse the test authority");
      },
    );
    await withServer(pki, () => undefined, async (port) => {
      const slow = new HttpsProductFetcher({ baseUrl: `https://127.0.0.1:${port}`, ca: pki.caPem, timeoutMs: 150 });
      await failsWith(slow.getProduct("BTC-USD"), "TIMEOUT", "An unanswered request must time out");
    });
    let dripClosed = false;
    await withServer(
      pki,
      (_url, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        const drip = setInterval(() => response.write(" "), 40);
        response.on("close", () => {
          dripClosed = true;
          clearInterval(drip);
        });
      },
      async (port) => {
        const dripped = new HttpsProductFetcher({ baseUrl: `https://127.0.0.1:${port}`, ca: pki.caPem, timeoutMs: 300 });
        const started = Date.now();
        const guard = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("A slow-drip response was not cut off by the deadline.")), 3_000).unref();
        });
        await failsWith(
          Promise.race([dripped.getProduct("BTC-USD"), guard]),
          "TIMEOUT",
          "A slow-drip response must hit the overall deadline",
        );
        const elapsed = Date.now() - started;
        assert(elapsed >= 250 && elapsed < 1500, `The deadline must bound the whole request (took ${elapsed} ms).`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert(dripClosed, "The deadline must close the connection, not only settle the promise.");
      },
    );
    await withServer(
      pki,
      (_url, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        const drip = setInterval(() => response.write(" "), 40);
        response.on("close", () => clearInterval(drip));
        setTimeout(() => response.end("{}"), 150);
      },
      async (port) => {
        const quick = new HttpsProductFetcher({ baseUrl: `https://127.0.0.1:${port}`, ca: pki.caPem, timeoutMs: 600_000 });
        const timersBefore = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
        const result = await quick.getProduct("BTC-USD");
        assert(result.status === 200, "A response inside the deadline must succeed.");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const timersAfter = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
        assert(timersAfter <= timersBefore, "A finished request must not leave its deadline timer running.");
      },
    );
    assert(REST_TIMEOUT_MS === 5_000, "The REST deadline constant is pinned at 5,000 ms.");
    for (const bad of ["http://example.invalid", "not a url", "https://u:p@example.invalid", "https://example.invalid/?q=1"]) {
      let refused = false;
      try {
        new HttpsProductFetcher({ baseUrl: bad });
      } catch (error) {
        refused = error instanceof ProductFetchError && error.code === "CONFIGURATION";
      }
      assert(refused, "An unsafe base URL must be refused.");
    }
  } finally {
    pki.cleanup();
  }
  console.log("unitHttpsProductFetcher");
}

let finished = false;

process.on("exit", () => {
  if (!finished) {
    console.error("unitHttpsProductFetcher did not finish.");
    process.exitCode = 1;
  }
});

unitHttpsProductFetcher().then(() => {
  finished = true;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
