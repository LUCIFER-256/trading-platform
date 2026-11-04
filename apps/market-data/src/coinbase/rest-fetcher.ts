import * as https from "node:https";
import type { ProductAssertion } from "../../../../packages/market-data/src";
import type { ProductFetcher } from "./rest-products";

export const REST_MAX_BODY_BYTES = 65_536;
export const REST_TIMEOUT_MS = 5_000;

export interface HttpsProductFetcherOptions {
  readonly baseUrl: string;
  readonly ca?: string | Buffer;
  readonly timeoutMs?: number;
}

export class ProductFetchError extends Error {
  public readonly name = "ProductFetchError";

  public constructor(readonly code: "CONFIGURATION" | "NETWORK" | "TIMEOUT" | "TOO_LARGE" | "BODY") {
    super(`Product request failed: ${code}.`);
  }
}

type ProductResponse = Awaited<ReturnType<ProductFetcher["getProduct"]>>;

export class HttpsProductFetcher implements ProductFetcher {
  private readonly base: URL;

  public constructor(private readonly options: HttpsProductFetcherOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new ProductFetchError("CONFIGURATION");
    }
    if (parsed.protocol !== "https:" || parsed.search !== "" || parsed.hash !== "" || parsed.username !== "") {
      throw new ProductFetchError("CONFIGURATION");
    }
    this.base = parsed;
  }

  public getProduct(productId: string): Promise<ProductResponse> {
    if (!/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}$/.test(productId)) {
      return Promise.reject(new ProductFetchError("CONFIGURATION"));
    }
    const prefix = this.base.pathname.endsWith("/") ? this.base.pathname.slice(0, -1) : this.base.pathname;
    return new Promise<ProductResponse>((resolve, reject) => {
      const request = https.request(
        {
          protocol: "https:",
          hostname: this.base.hostname,
          port: this.base.port === "" ? 443 : Number(this.base.port),
          method: "GET",
          path: `${prefix}/products/${productId}`,
          headers: { accept: "application/json", "user-agent": "trading-platform-market-data" },
          ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const header = response.headers["retry-after"];
          const retryAfter = typeof header === "string" ? header : undefined;
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > REST_MAX_BODY_BYTES) {
              request.destroy(new ProductFetchError("TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (status !== 200) {
              const empty = {} as ProductAssertion;
              resolve(retryAfter === undefined ? { status, body: empty } : { status, body: empty, retryAfter });
              return;
            }
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProductAssertion;
              resolve({ status, body });
            } catch {
              reject(new ProductFetchError("BODY"));
            }
          });
          response.on("error", () => reject(new ProductFetchError("NETWORK")));
        },
      );
      request.setTimeout(this.options.timeoutMs ?? REST_TIMEOUT_MS, () => {
        request.destroy(new ProductFetchError("TIMEOUT"));
      });
      request.on("error", (error: Error) => {
        reject(error instanceof ProductFetchError ? error : new ProductFetchError("NETWORK"));
      });
      request.end();
    });
  }
}
