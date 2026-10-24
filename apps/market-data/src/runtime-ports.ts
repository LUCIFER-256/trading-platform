import type { Clock, Prng, TimerScheduler, TimerToken } from "./ports";

export class RealClock implements Clock {
  public nowMs(): number { return Date.now(); }
}

export class RealTimerScheduler implements TimerScheduler {
  public schedule(afterMs: number, callback: () => void): TimerToken { return setTimeout(callback, afterMs) as unknown as TimerToken; }
  public cancel(token: TimerToken): void { clearTimeout(token as unknown as ReturnType<typeof setTimeout>); }
}

export class RealPrng implements Prng {
  public nextIntInclusive(min: number, max: number): number { return min + Math.floor(Math.random() * (max - min + 1)); }
}
