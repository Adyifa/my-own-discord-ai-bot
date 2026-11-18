import { statement, transaction } from "../../db/database.js";
import { rankBySimilarity, type SimilarityQuery } from "../rag/similarity.js";
import { decodeVector } from "../rag/vectors.js";

/** One answered question, kept so members can rate it and good answers can be reused. */
export interface Exchange {
  id: number;
  guildId: string;
  channelId: string;
  userId: string;
  messageId: string | null;
  prompt: string;
  answer: string;
  provider: string;
  model: string;
  createdAt: string;
}

export interface FeedbackTotals {
  up: number;
  down: number;
}

export interface Exemplar {
  prompt: string;
  answer: string;
  similarity: number;
}

const EXCHANGE_COLUMNS = `
  id, guild_id AS guildId, channel_id AS channelId, user_id AS userId, message_id AS messageId,
  prompt, answer, provider, model, created_at AS createdAt
`;

/**
 * Exchanges with a positive net rating and no thumbs-down from a moderator.
 * This SQL is the heart of the feedback loop: SUM(rating) > 0 means members liked it
 * on balance, and the MAX(...) = 0 condition lets a single moderator 👎 veto a popular
 * but wrong answer, so a group of members cannot "teach" the bot something false.
 */
const HELPFUL_EXCHANGES = `
  SELECT exchange_id FROM ai_feedback
  GROUP BY exchange_id
  HAVING SUM(rating) > 0 AND MAX(CASE WHEN rating < 0 AND is_moderator = 1 THEN 1 ELSE 0 END) = 0
`;

export function recordExchange(input: Omit<Exchange, "id" | "messageId" | "createdAt">): number {
  const result = statement(`
    INSERT INTO ai_exchanges (guild_id, channel_id, user_id, prompt, answer, provider, model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.guildId, input.channelId, input.userId, input.prompt, input.answer, input.provider, input.model);
  return Number(result.lastInsertRowid);
}

export function attachExchangeMessage(exchangeId: number, messageId: string): void {
  statement("UPDATE ai_exchanges SET message_id = ? WHERE id = ?").run(messageId, exchangeId);
}

export function deleteExchange(exchangeId: number): void {
  transaction(() => {
    statement("DELETE FROM ai_feedback WHERE exchange_id = ?").run(exchangeId);
    statement("DELETE FROM ai_exchanges WHERE id = ?").run(exchangeId);
  });
}

export function getExchange(exchangeId: number): Exchange | undefined {
  return statement(`SELECT ${EXCHANGE_COLUMNS} FROM ai_exchanges WHERE id = ?`).get(exchangeId) as Exchange | undefined;
}

/** One vote per person per answer; voting again replaces the previous vote. */
export function recordFeedback(
  exchangeId: number,
  userId: string,
  rating: 1 | -1,
  isModerator: boolean
): FeedbackTotals {
  statement(`
    INSERT INTO ai_feedback (exchange_id, user_id, rating, is_moderator) VALUES (?, ?, ?, ?)
    ON CONFLICT (exchange_id, user_id) DO UPDATE SET
      rating = excluded.rating,
      is_moderator = excluded.is_moderator,
      created_at = CURRENT_TIMESTAMP
  `).run(exchangeId, userId, rating, Number(isModerator));
  return getFeedbackTotals(exchangeId);
}

export function getFeedbackTotals(exchangeId: number): FeedbackTotals {
  const row = statement(`
    SELECT
      COALESCE(SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END), 0) AS up,
      COALESCE(SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END), 0) AS down
    FROM ai_feedback WHERE exchange_id = ?
  `).get(exchangeId) as FeedbackTotals;
  return row;
}

export function hasExemplars(guildId: string): boolean {
  return statement(`SELECT 1 FROM ai_exchanges WHERE guild_id = ? AND id IN (${HELPFUL_EXCHANGES}) LIMIT 1`)
    .get(guildId) !== undefined;
}

/**
 * Few-shot learning from feedback: answers the community rated helpful are
 * reused as reference examples when a similar question comes in.
 */
export function findExemplars(
  guildId: string,
  query: SimilarityQuery,
  options: { limit?: number; minCosine?: number; minOverlap?: number } = {}
): Exemplar[] {
  // Candidates: the newest 300 helpful answers of this server (the prompt was embedded
  // by the background indexer when the answer got its first 👍).
  const rows = statement(`
    SELECT prompt, answer, embedding, embedding_model AS embeddingModel
    FROM ai_exchanges
    WHERE guild_id = ? AND id IN (${HELPFUL_EXCHANGES})
    ORDER BY id DESC
    LIMIT 300
  `).all(guildId) as Array<{ prompt: string; answer: string; embedding: Buffer | null; embeddingModel: string | null }>;

  // Only close matches become examples (default 2): an off-topic example would push the
  // model towards the wrong answer. Similarity is semantic when embeddings exist,
  // otherwise word overlap.
  return rankBySimilarity(
    query,
    rows.map(row => ({
      item: row,
      text: row.prompt,
      vector: decodeVector(row.embedding),
      model: row.embeddingModel
    })),
    { limit: options.limit ?? 2, minCosine: options.minCosine ?? 0.6, minOverlap: options.minOverlap ?? 0.35 }
  ).map(match => ({ prompt: match.item.prompt, answer: match.item.answer, similarity: match.score }));
}

export function getFeedbackStats(guildId: string, days = 30): { up: number; down: number; helpfulAnswers: number } {
  const totals = statement(`
    SELECT
      COALESCE(SUM(CASE WHEN f.rating > 0 THEN 1 ELSE 0 END), 0) AS up,
      COALESCE(SUM(CASE WHEN f.rating < 0 THEN 1 ELSE 0 END), 0) AS down
    FROM ai_feedback f
    JOIN ai_exchanges e ON e.id = f.exchange_id
    WHERE e.guild_id = ? AND f.created_at >= datetime('now', ?)
  `).get(guildId, `-${days} days`) as { up: number; down: number };
  const helpful = statement(`SELECT COUNT(*) AS count FROM ai_exchanges WHERE guild_id = ? AND id IN (${HELPFUL_EXCHANGES})`)
    .get(guildId) as { count: number };
  return { ...totals, helpfulAnswers: helpful.count };
}

export function deleteUserExchanges(guildId: string, userId: string): number {
  return transaction(() => {
    statement(`
      DELETE FROM ai_feedback
      WHERE exchange_id IN (SELECT id FROM ai_exchanges WHERE guild_id = ? AND user_id = ?)
    `).run(guildId, userId);
    return statement("DELETE FROM ai_exchanges WHERE guild_id = ? AND user_id = ?").run(guildId, userId).changes;
  });
}

/** Unrated answers expire after 30 days; helpful examples are kept for at most 180 days. */
export function purgeExchanges(): number {
  return transaction(() => {
    const removed = statement(`
      DELETE FROM ai_exchanges
      WHERE created_at < datetime('now', '-180 days')
         OR (created_at < datetime('now', '-30 days') AND id NOT IN (${HELPFUL_EXCHANGES}))
    `).run().changes;
    statement("DELETE FROM ai_feedback WHERE exchange_id NOT IN (SELECT id FROM ai_exchanges)").run();
    return removed;
  });
}
