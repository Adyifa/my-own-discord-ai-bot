/** Scales a vector to unit length, so cosine similarity becomes a plain dot product. */
export function normalize(values: ArrayLike<number>): Float32Array {
  const vector = Float32Array.from(values as ArrayLike<number>);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  }
  return vector;
}

/** Cosine similarity of two normalized vectors. Different sizes (other model) score 0. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

export function encodeVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** SQLite BLOB → Float32Array (copied, because the BLOB may not be 4-byte aligned). */
export function decodeVector(blob: unknown): Float32Array | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/**
 * Reciprocal Rank Fusion: merges several ranked lists without needing their
 * scores to be comparable (BM25 vs cosine). score = Σ 1 / (k + rank).
 */
export function reciprocalRankFusion<T>(
  rankings: ReadonlyArray<readonly T[]>,
  keyOf: (item: T) => string | number,
  k = 60
): Array<{ item: T; score: number }> {
  const fused = new Map<string | number, { item: T; score: number }>();
  for (const ranking of rankings) {
    ranking.forEach((item, index) => {
      const key = keyOf(item);
      const entry = fused.get(key) ?? { item, score: 0 };
      entry.score += 1 / (k + index + 1);
      fused.set(key, entry);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}
