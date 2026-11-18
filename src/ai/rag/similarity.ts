import { overlapScore, tokenize } from "./text.js";
import { cosine } from "./vectors.js";

export interface SimilarityQuery {
  text: string;
  vector?: Float32Array;
  /** Embedding model of `vector`; only vectors from the same model are compared. */
  model?: string;
}

export interface SimilarityCandidate<T> {
  item: T;
  text: string;
  vector?: Float32Array | null;
  model?: string | null;
}

export interface SimilarityOptions {
  limit: number;
  minCosine: number;
  minOverlap: number;
}

export interface RankedMatch<T> {
  item: T;
  score: number;
  method: "vector" | "keyword";
}

/**
 * Ranks a small candidate set (learned examples, rated answers) by semantic
 * similarity when both sides have embeddings from the same model, and by word
 * overlap otherwise, so learning keeps working without an embedding model.
 */
export function rankBySimilarity<T>(
  query: SimilarityQuery,
  candidates: readonly SimilarityCandidate<T>[],
  options: SimilarityOptions
): RankedMatch<T>[] {
  const queryTokens = tokenize(query.text);
  const matches: RankedMatch<T>[] = [];

  for (const candidate of candidates) {
    if (query.vector && query.model && candidate.vector && candidate.model === query.model) {
      const score = cosine(query.vector, candidate.vector);
      if (score >= options.minCosine) matches.push({ item: candidate.item, score, method: "vector" });
      continue;
    }
    const score = overlapScore(queryTokens, tokenize(candidate.text));
    if (score >= options.minOverlap) matches.push({ item: candidate.item, score, method: "keyword" });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, options.limit);
}
