import { getDatabase, statement, transaction } from "../../db/database.js";
import { buildFtsQuery, chunkText } from "./text.js";
import { cosine, decodeVector, reciprocalRankFusion } from "./vectors.js";

export type KnowledgeSource = "admin" | "file" | "correction";

export interface KnowledgeDocument {
  id: number;
  title: string;
  source: KnowledgeSource;
  sourceRef: string | null;
  createdBy: string;
  createdAt: string;
  chunkCount: number;
}

export interface KnowledgeHit {
  chunkId: number;
  documentId: number;
  title: string;
  source: KnowledgeSource;
  content: string;
  /** Fused RRF score (higher is better). */
  score: number;
  /** 1-based BM25 rank when the keyword search matched. */
  keywordRank?: number;
  /** Cosine similarity when the semantic search ran. */
  vectorSimilarity?: number;
}

export type RetrievalMode = "hybrid" | "keyword" | "vector";

export interface RetrievalOptions {
  queryVector?: Float32Array;
  /** Embedding model of `queryVector`; only chunks embedded with the same model are compared. */
  embeddingModel?: string;
  limit?: number;
  /** Semantic matches below this cosine similarity are ignored (keyword matches always count). */
  minSimilarity: number;
  mode?: RetrievalMode;
}

export const MAX_DOCUMENT_CHARACTERS = 200_000;
const CANDIDATES_PER_RETRIEVER = 20;

export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeError";
  }
}

export function addDocument(input: {
  guildId: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  sourceRef?: string;
  createdBy: string;
}): KnowledgeDocument {
  const chunks = chunkText(input.content.slice(0, MAX_DOCUMENT_CHARACTERS));
  if (chunks.length === 0) throw new KnowledgeError("The document has no text.");

  const documentId = transaction(() => {
    const result = statement(`
      INSERT INTO knowledge_documents (guild_id, title, source, source_ref, created_by, chunk_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.guildId, input.title, input.source, input.sourceRef ?? null, input.createdBy, chunks.length);
    const id = Number(result.lastInsertRowid);
    const insertChunk = statement(
      "INSERT INTO knowledge_chunks (document_id, guild_id, position, content) VALUES (?, ?, ?, ?)"
    );
    chunks.forEach((chunk, position) => insertChunk.run(id, input.guildId, position, chunk));
    return id;
  });
  return getDocument(input.guildId, documentId) as KnowledgeDocument;
}

const DOCUMENT_COLUMNS = `
  id, title, source, source_ref AS sourceRef, created_by AS createdBy,
  created_at AS createdAt, chunk_count AS chunkCount
`;

export function getDocument(guildId: string, documentId: number): KnowledgeDocument | undefined {
  return statement(`SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE guild_id = ? AND id = ?`)
    .get(guildId, documentId) as KnowledgeDocument | undefined;
}

export function listDocuments(guildId: string, limit = 25): KnowledgeDocument[] {
  return statement(`SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE guild_id = ? ORDER BY id DESC LIMIT ?`)
    .all(guildId, limit) as KnowledgeDocument[];
}

/** Deletes a document and its chunks (the FTS index is kept in sync by triggers). */
export function deleteDocument(guildId: string, documentId: number): boolean {
  return transaction(() => {
    statement("DELETE FROM knowledge_chunks WHERE guild_id = ? AND document_id = ?").run(guildId, documentId);
    return statement("DELETE FROM knowledge_documents WHERE guild_id = ? AND id = ?").run(guildId, documentId).changes > 0;
  });
}

export function hasKnowledge(guildId: string): boolean {
  return statement("SELECT 1 FROM knowledge_chunks WHERE guild_id = ? LIMIT 1").get(guildId) !== undefined;
}

export function getKnowledgeCounts(guildId: string, embeddingModel?: string): {
  documents: number;
  chunks: number;
  embeddedChunks: number;
  corrections: number;
} {
  const row = statement(`
    SELECT
      (SELECT COUNT(*) FROM knowledge_documents WHERE guild_id = @guildId) AS documents,
      (SELECT COUNT(*) FROM knowledge_documents WHERE guild_id = @guildId AND source = 'correction') AS corrections,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE guild_id = @guildId) AS chunks,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE guild_id = @guildId AND embedding_model = @model) AS embeddedChunks
  `).get({ guildId, model: embeddingModel ?? "" }) as {
    documents: number;
    corrections: number;
    chunks: number;
    embeddedChunks: number;
  };
  return row;
}

/**
 * Hybrid retrieval: BM25 keyword search (SQLite FTS5) and cosine similarity
 * over embeddings, merged with Reciprocal Rank Fusion. Keyword search alone
 * still works when no embedding model is configured.
 */
export function retrieveKnowledge(guildId: string, query: string, options: RetrievalOptions): KnowledgeHit[] {
  const mode = options.mode ?? "hybrid";
  const limit = options.limit ?? 4;

  // 1. Keyword retrieval (BM25): precise for names, numbers and exact terms
  //    ("1.20.4", "MLBB"), but blind to paraphrases and other languages.
  const keywordIds = mode === "vector" ? [] : keywordSearch(guildId, query, CANDIDATES_PER_RETRIEVER);

  // 2. Semantic retrieval (embeddings): finds the same meaning in other words
  //    ("dunia kotak-kotak" ≈ Minecraft). Only runs when the question was embedded.
  const vectorResults = mode !== "keyword" && options.queryVector && options.embeddingModel
    ? vectorSearch(guildId, options.queryVector, options.embeddingModel, CANDIDATES_PER_RETRIEVER)
    : [];
  // Vector search always returns *something*, even for unrelated questions, so weak
  // matches are dropped. Keyword matches need no threshold: a shared word is real evidence.
  const vectorIds = vectorResults.filter(result => result.similarity >= options.minSimilarity).map(result => result.id);

  // 3. Merge both rankings with Reciprocal Rank Fusion. It works on positions, not scores,
  //    so BM25 scores and cosine similarities never have to be made comparable.
  const fused = reciprocalRankFusion([keywordIds, vectorIds], id => id).slice(0, limit);
  if (fused.length === 0) return [];

  // 4. Load text and document titles only for the winners, and keep the per-retriever
  //    evidence (rank, similarity) for /ai knowledge search and the evals.
  const keywordRank = new Map(keywordIds.map((id, index) => [id, index + 1]));
  const similarity = new Map(vectorResults.map(result => [result.id, result.similarity]));
  const rows = loadChunks(fused.map(entry => entry.item));

  return fused.flatMap(({ item: chunkId, score }) => {
    const row = rows.get(chunkId);
    if (!row) return [];
    return [{
      chunkId,
      documentId: row.documentId,
      title: row.title,
      source: row.source,
      content: row.content,
      score,
      keywordRank: keywordRank.get(chunkId),
      vectorSimilarity: similarity.get(chunkId)
    }];
  });
}

function keywordSearch(guildId: string, query: string, limit: number): number[] {
  // The question is turned into quoted OR-terms ("jadwal" OR "turnamen"), so user input can
  // never inject FTS5 operators. bm25() ranks rarer, more specific words higher.
  const match = buildFtsQuery(query);
  if (!match) return [];
  const rows = statement(`
    SELECT knowledge_chunks.id AS id
    FROM knowledge_fts
    JOIN knowledge_chunks ON knowledge_chunks.id = knowledge_fts.rowid
    WHERE knowledge_fts MATCH ? AND knowledge_chunks.guild_id = ?
    ORDER BY bm25(knowledge_fts)
    LIMIT ?
  `).all(match, guildId, limit) as Array<{ id: number }>;
  return rows.map(row => row.id);
}

function vectorSearch(
  guildId: string,
  queryVector: Float32Array,
  model: string,
  limit: number
): Array<{ id: number; similarity: number }> {
  // Exact (brute-force) cosine search over this server's chunks. A server knowledge base
  // has hundreds to a few thousand chunks, which takes milliseconds. A bigger deployment
  // would swap this for an ANN index (sqlite-vec, pgvector) without changing the callers.
  // Only vectors from the current embedding model are compared: vectors from different
  // models live in different spaces.
  const rows = statement(`
    SELECT id, embedding FROM knowledge_chunks
    WHERE guild_id = ? AND embedding_model = ? AND embedding IS NOT NULL
  `).all(guildId, model) as Array<{ id: number; embedding: Buffer }>;

  const scored: Array<{ id: number; similarity: number }> = [];
  for (const row of rows) {
    const vector = decodeVector(row.embedding);
    if (vector) scored.push({ id: row.id, similarity: cosine(queryVector, vector) });
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

function loadChunks(ids: readonly number[]): Map<number, {
  documentId: number;
  title: string;
  source: KnowledgeSource;
  content: string;
}> {
  const rows = getDatabase().prepare(`
    SELECT c.id, c.document_id AS documentId, c.content, d.title, d.source
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.id = c.document_id
    WHERE c.id IN (${ids.map(() => "?").join(", ")})
  `).all(...ids) as Array<{ id: number; documentId: number; content: string; title: string; source: KnowledgeSource }>;
  return new Map(rows.map(row => [row.id, row]));
}
