import type { Clock, PersistencePort } from "./ports";

export interface QualityBucket { readonly flushId: string; readonly providerId: string; readonly instrumentId: string | null; readonly reasonCode: string; readonly bucketStartedAt: number; readonly count: number; }

export class QualityAggregator {
  private readonly buckets = new Map<string, QualityBucket>();
  private nextFlushId = 1;
  public constructor(private readonly clock: Clock) {}
  public reject(providerId: string, instrumentId: string | null, reasonCode: string): void {
    const bucketStartedAt = Math.floor(this.clock.nowMs() / 60_000) * 60_000;
    const key = JSON.stringify([providerId, instrumentId, reasonCode, bucketStartedAt]);
    const prior = this.buckets.get(key);
    this.buckets.set(key, prior === undefined ? { flushId: `quality-${this.nextFlushId++}`, providerId, instrumentId, reasonCode, bucketStartedAt, count: 1 } : { ...prior, count: prior.count + 1 });
  }
  public pending(): readonly QualityBucket[] { return [...this.buckets.values()]; }
  public async flushClosed(persistence: PersistencePort): Promise<void> {
    for (const [key, bucket] of this.buckets) {
      if (bucket.bucketStartedAt + 60_000 > this.clock.nowMs()) continue;
      await persistence.appendQualityBucket({ flushId: bucket.flushId, providerId: bucket.providerId, instrumentId: bucket.instrumentId, reasonCode: bucket.reasonCode, bucketStartedAt: new Date(bucket.bucketStartedAt), count: BigInt(bucket.count) });
      this.buckets.delete(key);
    }
  }
}
