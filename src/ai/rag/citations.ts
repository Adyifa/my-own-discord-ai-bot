import type { KnowledgeHit } from "./knowledge.js";

export interface CitedSource {
  number: number;
  title: string;
  documentId: number;
}

/**
 * Numbers knowledge excerpts for one chat turn ([1], [2], …), shared by the
 * automatic retrieval and the search tool, and maps the model's citations
 * back to source documents afterwards.
 */
export class CitationRegistry {
  private readonly numberByChunk = new Map<number, number>();
  private readonly hits: KnowledgeHit[] = [];

  register(hit: KnowledgeHit): number {
    const existing = this.numberByChunk.get(hit.chunkId);
    if (existing !== undefined) return existing;
    this.hits.push(hit);
    const number = this.hits.length;
    this.numberByChunk.set(hit.chunkId, number);
    return number;
  }

  entries(): Array<{ number: number; hit: KnowledgeHit }> {
    return this.hits.map((hit, index) => ({ number: index + 1, hit }));
  }

  /** Sources actually cited in the answer ("[1]", "[1][3]" or "[1, 3]"), one per document. */
  cited(answer: string): CitedSource[] {
    const numbers = new Set<number>();
    for (const match of answer.matchAll(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g)) {
      for (const part of match[1].split(",")) numbers.add(Number(part.trim()));
    }

    const sources: CitedSource[] = [];
    const seenDocuments = new Set<number>();
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const hit = this.hits[number - 1];
      if (!hit || seenDocuments.has(hit.documentId)) continue;
      seenDocuments.add(hit.documentId);
      sources.push({ number, title: hit.title, documentId: hit.documentId });
    }
    return sources;
  }
}
