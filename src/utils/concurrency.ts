/**
 * Runs at most `maxConcurrent` background tasks at a time. Extra tasks wait in
 * a bounded queue; when the queue is full new work is rejected instead of
 * piling up (load shedding). Tasks are expected to handle their own errors.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number
  ) {
    if (maxConcurrent < 1) throw new Error("maxConcurrent must be at least 1");
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Schedules the task. Returns false (and drops it) when the limiter is saturated. */
  tryRun(task: () => Promise<void>): boolean {
    if (this.active >= this.maxConcurrent && this.queue.length >= this.maxQueue) return false;

    const start = (): void => {
      this.active += 1;
      Promise.resolve()
        .then(task)
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          this.queue.shift()?.();
        });
    };

    if (this.active < this.maxConcurrent) start();
    else this.queue.push(start);
    return true;
  }
}
