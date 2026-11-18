/**
 * In-memory per-key cooldowns. `acquire` returns 0 when the caller may
 * proceed (and starts a new cooldown), otherwise the milliseconds remaining.
 */
export class Cooldowns {
  private readonly expiries = new Map<string, number>();

  constructor(
    private readonly durationMs: number,
    private readonly maxEntries = 10_000
  ) {}

  acquire(key: string, now = Date.now()): number {
    const expiresAt = this.expiries.get(key) ?? 0;
    if (expiresAt > now) return expiresAt - now;

    this.expiries.set(key, now + this.durationMs);
    if (this.expiries.size > this.maxEntries) this.prune(now);
    return 0;
  }

  /** Cancels a cooldown, e.g. when the request failed before doing any work. */
  release(key: string): void {
    this.expiries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, expiry] of this.expiries) {
      if (expiry <= now) this.expiries.delete(key);
    }
  }
}
