import type { EmbeddingProvider, EmbeddingResult } from "../../src/ai/embeddings.js";
import { tokenize } from "../../src/ai/rag/text.js";
import { normalize } from "../../src/ai/rag/vectors.js";

/**
 * Deterministic bag-of-words "embedding" for tests. The optional synonym map
 * puts different words into the same bucket, which imitates how a real
 * multilingual model gives "Minggu" and "Sunday" similar meanings.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly calls: string[][] = [];

  constructor(
    readonly id = "test:hashing",
    private readonly dimensions = 256,
    private readonly synonyms: Record<string, string> = {}
  ) {}

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    this.calls.push([...texts]);
    return { vectors: texts.map(text => this.vector(text)), inputTokens: texts.length };
  }

  private vector(text: string): Float32Array {
    const values = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenize(text)) values[hash(this.synonyms[token] ?? token) % this.dimensions] += 1;
    if (!values.some(value => value !== 0)) values[0] = 1;
    return normalize(values);
  }
}

function hash(text: string): number {
  let value = 2166136261;
  for (const character of text) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
