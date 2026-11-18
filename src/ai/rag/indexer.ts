import { statement, transaction } from "../../db/database.js";
import { describeError, logger } from "../../logger.js";
import type { Embedder } from "../embeddings.js";
import { encodeVector } from "./vectors.js";

/**
 * Everything that is searched by meaning. Table and column names come from
 * this constant only (never from input). Exchanges are embedded once they are
 * rated helpful, moderation flags once a moderator has reviewed them.
 */
const TARGETS = [
  { table: "knowledge_chunks", text: "content", filter: "1 = 1" },
  {
    table: "ai_exchanges",
    text: "prompt",
    filter: "id IN (SELECT exchange_id FROM ai_feedback GROUP BY exchange_id HAVING SUM(rating) > 0)"
  },
  { table: "ai_moderation_flags", text: "content", filter: "decision IS NOT NULL" }
] as const;

type TargetTable = (typeof TARGETS)[number]["table"];

export interface PendingEmbedding {
  table: TargetTable;
  id: number;
  text: string;
}

/** Rows without a vector for the current model (new rows, or rows embedded by an older model). */
export function findPendingEmbeddings(model: string, limit: number): PendingEmbedding[] {
  const pending: PendingEmbedding[] = [];
  for (const target of TARGETS) {
    if (pending.length >= limit) break;
    const rows = statement(`
      SELECT id, ${target.text} AS text FROM ${target.table}
      WHERE (embedding_model IS NULL OR embedding_model != ?) AND ${target.filter}
      ORDER BY id
      LIMIT ?
    `).all(model, limit - pending.length) as Array<{ id: number; text: string }>;
    pending.push(...rows.map(row => ({ table: target.table, id: row.id, text: row.text })));
  }
  return pending;
}

export function storeEmbeddings(items: readonly PendingEmbedding[], vectors: readonly Float32Array[], model: string): void {
  transaction(() => {
    items.forEach((item, index) => {
      const vector = vectors[index];
      if (!vector) return;
      statement(`UPDATE ${item.table} SET embedding = ?, embedding_model = ? WHERE id = ?`)
        .run(encodeVector(vector), model, item.id);
    });
  });
}

/**
 * Background job that keeps all searchable rows embedded. It runs after new
 * knowledge, feedback or reviews arrive, on startup and periodically, and
 * re-embeds everything automatically when the embedding model changes.
 */
export class EmbeddingIndexer {
  private running: Promise<number> | undefined;

  constructor(
    private readonly embedder: Embedder,
    private readonly batchSize = 32
  ) {}

  runOnce(maxItems = 2_000): Promise<number> {
    if (!this.running) {
      this.running = this.indexPending(maxItems).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  schedule(): void {
    this.runOnce()
      .then(count => {
        if (count > 0) logger.info("ai.embeddings_indexed", { count, model: this.embedder.id });
      })
      .catch(error => logger.warn("ai.embedding_index_failed", { model: this.embedder.id, ...describeError(error) }));
  }

  private async indexPending(maxItems: number): Promise<number> {
    let indexed = 0;
    while (indexed < maxItems) {
      const pending = findPendingEmbeddings(this.embedder.id, this.batchSize);
      if (pending.length === 0) break;
      const vectors = await this.embedder.embed(pending.map(item => item.text));
      storeEmbeddings(pending, vectors, this.embedder.id);
      indexed += pending.length;
    }
    return indexed;
  }
}
