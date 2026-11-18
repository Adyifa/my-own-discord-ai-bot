import { statement, transaction } from "../../db/database.js";
import { MODERATION_CATEGORIES, type ModerationCategory, type ModerationExample } from "../moderation.js";
import { rankBySimilarity, type SimilarityQuery } from "../rag/similarity.js";
import { decodeVector } from "../rag/vectors.js";

export type FlagDecision = "confirmed" | "false_positive";

export interface ModerationFlag {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  content: string;
  category: ModerationCategory;
  confidence: number;
  reason: string;
  deleted: boolean;
  decision: FlagDecision | null;
  decidedBy: string | null;
}

export interface ModerationStats {
  flags: number;
  reviewed: number;
  confirmed: number;
  falsePositives: number;
  /** Share of reviewed flags that moderators confirmed (null until something was reviewed). */
  precision: number | null;
  learnedExamples: number;
}

interface FlagRow extends Omit<ModerationFlag, "deleted" | "category" | "decision"> {
  deleted: number;
  category: string;
  decision: string | null;
}

const MAX_EXAMPLES_PER_GUILD = 500;

export function recordFlag(input: Omit<ModerationFlag, "id" | "decision" | "decidedBy">): number {
  const result = statement(`
    INSERT INTO ai_moderation_flags
      (guild_id, channel_id, message_id, author_id, content, category, confidence, reason, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.guildId, input.channelId, input.messageId, input.authorId, input.content,
    input.category, input.confidence, input.reason, Number(input.deleted)
  );
  return Number(result.lastInsertRowid);
}

export function getFlag(flagId: number): ModerationFlag | undefined {
  const row = statement(`
    SELECT id, guild_id AS guildId, channel_id AS channelId, message_id AS messageId, author_id AS authorId,
           content, category, confidence, reason, deleted, decision, decided_by AS decidedBy
    FROM ai_moderation_flags WHERE id = ?
  `).get(flagId) as FlagRow | undefined;
  if (!row) return undefined;
  return {
    ...row,
    deleted: row.deleted === 1,
    category: (MODERATION_CATEGORIES as readonly string[]).includes(row.category) ? row.category as ModerationCategory : "other",
    decision: row.decision === "confirmed" || row.decision === "false_positive" ? row.decision : null
  };
}

/** Records a moderator's verdict. Returns undefined if the flag was already reviewed. */
export function decideFlag(
  flagId: number,
  guildId: string,
  decision: FlagDecision,
  moderatorId: string
): ModerationFlag | undefined {
  // "decision IS NULL" makes the review idempotent: when two moderators click at the same
  // time, only the first decision is stored. The guild check stops a button ID from one
  // server being replayed in another.
  const changed = statement(`
    UPDATE ai_moderation_flags
    SET decision = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
    WHERE id = ? AND guild_id = ? AND decision IS NULL
  `).run(decision, moderatorId, flagId, guildId).changes;
  return changed > 0 ? getFlag(flagId) : undefined;
}

export function hasModerationExamples(guildId: string): boolean {
  return statement("SELECT 1 FROM ai_moderation_flags WHERE guild_id = ? AND decision IS NOT NULL LIMIT 1")
    .get(guildId) !== undefined;
}

/**
 * Past moderator decisions that resemble a new message. They are added to the
 * classifier prompt so it follows this server's norms (in-context learning).
 */
export function findModerationExamples(
  guildId: string,
  query: SimilarityQuery,
  options: { limit?: number; minCosine?: number; minOverlap?: number } = {}
): ModerationExample[] {
  const rows = statement(`
    SELECT content, category, decision, embedding, embedding_model AS embeddingModel
    FROM ai_moderation_flags
    WHERE guild_id = ? AND decision IS NOT NULL
    ORDER BY id DESC
    LIMIT ${MAX_EXAMPLES_PER_GUILD}
  `).all(guildId) as Array<{
    content: string;
    category: string;
    decision: FlagDecision;
    embedding: Buffer | null;
    embeddingModel: string | null;
  }>;

  return rankBySimilarity(
    query,
    rows.map(row => ({ item: row, text: row.content, vector: decodeVector(row.embedding), model: row.embeddingModel })),
    { limit: options.limit ?? 4, minCosine: options.minCosine ?? 0.55, minOverlap: options.minOverlap ?? 0.3 }
  ).map(({ item }) => ({
    text: item.content,
    // The moderator's verdict is the label, not the AI's original guess:
    // a "false positive" review becomes an example of an acceptable message.
    violates: item.decision === "confirmed",
    category: (MODERATION_CATEGORIES as readonly string[]).includes(item.category)
      ? item.category as ModerationCategory
      : "other"
  }));
}

export function getModerationStats(guildId: string, days = 30): ModerationStats {
  const recent = statement(`
    SELECT
      COUNT(*) AS flags,
      COALESCE(SUM(CASE WHEN decision IS NOT NULL THEN 1 ELSE 0 END), 0) AS reviewed,
      COALESCE(SUM(CASE WHEN decision = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed,
      COALESCE(SUM(CASE WHEN decision = 'false_positive' THEN 1 ELSE 0 END), 0) AS falsePositives
    FROM ai_moderation_flags
    WHERE guild_id = ? AND created_at >= datetime('now', ?)
  `).get(guildId, `-${days} days`) as Omit<ModerationStats, "precision" | "learnedExamples">;
  const learned = statement("SELECT COUNT(*) AS count FROM ai_moderation_flags WHERE guild_id = ? AND decision IS NOT NULL")
    .get(guildId) as { count: number };
  return {
    ...recent,
    precision: recent.reviewed > 0 ? recent.confirmed / recent.reviewed : null,
    learnedExamples: learned.count
  };
}

/** Unreviewed flags expire after 30 days; reviewed ones are kept as examples (newest 500 per server). */
export function purgeModerationFlags(): number {
  return transaction(() => {
    const stale = statement(`
      DELETE FROM ai_moderation_flags
      WHERE decision IS NULL AND created_at < datetime('now', '-30 days')
    `).run().changes;
    const overflow = statement(`
      DELETE FROM ai_moderation_flags
      WHERE decision IS NOT NULL AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY guild_id ORDER BY id DESC) AS position
          FROM ai_moderation_flags WHERE decision IS NOT NULL
        ) WHERE position <= ${MAX_EXAMPLES_PER_GUILD}
      )
    `).run().changes;
    return stale + overflow;
  });
}
