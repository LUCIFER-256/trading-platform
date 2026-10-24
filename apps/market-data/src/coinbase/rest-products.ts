import { validateProductAssertion, type ProductAssertion } from "../../../../packages/market-data/src";
import type { DecimalString } from "../../../../packages/shared/src";
import type { PersistencePort, TimerScheduler } from "../ports";
import type { ProviderCircuit } from "../circuit";

export interface ProductFetcher {
  getProduct(productId: string): Promise<{
    readonly status: number;
    readonly body: ProductAssertion;
    readonly retryAfter?: string;
  }>;
}

export interface ProductTarget {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly priceIncrement: DecimalString;
  readonly sizeIncrement: DecimalString;
}

export interface ProductAssertionResult {
  readonly accepted: readonly ProductTarget[];
  readonly retryAfter?: string;
}

export class RestTransientFailure extends Error {}

export class CoinbaseProductAssertions {
  public constructor(
    private readonly providerId: string,
    private readonly fetcher: ProductFetcher,
    private readonly scheduler: TimerScheduler,
    private readonly persistence: PersistencePort,
    private readonly circuit: ProviderCircuit,
  ) {}
  public async assertAll(targets: readonly ProductTarget[]): Promise<ProductAssertionResult> {
    const accepted: ProductTarget[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      if (index > 0) {
        await new Promise<void>((resolve) => {
          this.scheduler.schedule(100, resolve);
        });
      }
      let response: Awaited<ReturnType<ProductFetcher["getProduct"]>>;
      try {
        response = await this.fetcher.getProduct(target.symbol);
      } catch {
        throw new RestTransientFailure();
      }
      if (response.status === 429) {
        this.circuit.http429(response.retryAfter);
        return response.retryAfter === undefined
          ? { accepted, retryAfter: "60" }
          : { accepted, retryAfter: response.retryAfter };
      }
      if (response.status === 404) {
        await this.persistence.openHalt({
          providerId: this.providerId,
          instrumentId: target.instrumentId,
          reasonCode: "PRODUCT_ASSERTION_FAILURE",
          eventAtUs: null,
          tradeId: null,
          providerSequence: null,
          candidatePrice: null,
          candidateSize: null,
          referencePrice: null,
        });
        continue;
      }
      if (response.status !== 200) {
        throw new RestTransientFailure();
      }
      const result = validateProductAssertion(response.body, target);
      if (result.outcome === "ACCEPTED") {
        accepted.push(target);
      } else {
        await this.persistence.openHalt({
          providerId: this.providerId,
          instrumentId: target.instrumentId,
          reasonCode: result.reason,
          eventAtUs: null,
          tradeId: null,
          providerSequence: null,
          candidatePrice: null,
          candidateSize: null,
          referencePrice: null,
        });
      }
    }
    return { accepted };
  }
}
