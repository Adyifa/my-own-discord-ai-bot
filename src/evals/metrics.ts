export interface BinaryMetrics {
  total: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Standard binary classification metrics ("is this message a violation?"). */
export function binaryMetrics(pairs: ReadonlyArray<{ expected: boolean; predicted: boolean }>): BinaryMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const { expected, predicted } of pairs) {
    if (expected && predicted) tp += 1;
    else if (!expected && predicted) fp += 1;
    else if (!expected && !predicted) tn += 1;
    else fn += 1;
  }
  const total = pairs.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return {
    total,
    tp,
    fp,
    tn,
    fn,
    accuracy: total > 0 ? (tp + tn) / total : 0,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  };
}

/** 1 / rank of the first relevant item (0 when it is missing). */
export function reciprocalRank(ranked: readonly string[], relevant: string): number {
  const index = ranked.indexOf(relevant);
  return index >= 0 ? 1 / (index + 1) : 0;
}

export function hitAtK(ranked: readonly string[], relevant: string, k: number): boolean {
  return ranked.slice(0, k).includes(relevant);
}

export function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Nearest-rank percentile, e.g. p = 95 for p95 latency. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Runs async work over items with at most `concurrency` in flight, keeping input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
