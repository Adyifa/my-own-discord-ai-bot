import { getKnowledgeCounts } from "../rag/knowledge.js";
import { getPersonalMemoryStats } from "../user-memory.js";
import { getFeedbackStats } from "./exchanges.js";
import { getModerationStats, type ModerationStats } from "./moderation-flags.js";

export interface LearningStats {
  knowledge: { documents: number; chunks: number; embeddedChunks: number; corrections: number };
  feedback: { up: number; down: number; satisfaction: number | null; helpfulAnswers: number };
  moderation: ModerationStats;
  personalMemory: { users: number; facts: number };
}

/** Everything the bot has learned on one server, for `/ai learning`. */
export function getLearningStats(guildId: string, embeddingModel?: string, days = 30): LearningStats {
  const feedback = getFeedbackStats(guildId, days);
  const votes = feedback.up + feedback.down;
  return {
    knowledge: getKnowledgeCounts(guildId, embeddingModel),
    feedback: { ...feedback, satisfaction: votes > 0 ? feedback.up / votes : null },
    moderation: getModerationStats(guildId, days),
    personalMemory: getPersonalMemoryStats(guildId)
  };
}
