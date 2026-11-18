import { statement, transaction } from "../db/database.js";
import { truncate } from "../utils/text.js";

export const MAX_FACTS_PER_USER = 20;
const MAX_FACT_LENGTH = 200;

export type FactSource = "user" | "auto";

export interface UserFact {
  id: number;
  fact: string;
  source: FactSource;
  createdAt: string;
}

function normalizeFact(fact: string): string {
  return truncate(fact.replace(/\s+/g, " ").trim().replace(/[.!]+$/, ""), MAX_FACT_LENGTH);
}

function factKey(fact: string): string {
  return fact.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Durable facts about one member in one server, oldest first. */
export function getUserFacts(guildId: string, userId: string): UserFact[] {
  return statement(`
    SELECT id, fact, source, created_at AS createdAt
    FROM ai_user_facts WHERE guild_id = ? AND user_id = ?
    ORDER BY id ASC
  `).all(guildId, userId) as UserFact[];
}

/**
 * Stores new facts (duplicates ignored). When over the limit, the oldest
 * automatically learned facts are dropped first; facts the user added
 * themselves are kept as long as possible.
 */
export function addUserFacts(guildId: string, userId: string, facts: readonly string[], source: FactSource): number {
  return transaction(() => {
    let added = 0;
    const insert = statement(`
      INSERT OR IGNORE INTO ai_user_facts (guild_id, user_id, fact, fact_key, source) VALUES (?, ?, ?, ?, ?)
    `);
    for (const raw of facts) {
      const fact = normalizeFact(raw);
      const key = factKey(fact);
      if (!key) continue;
      added += insert.run(guildId, userId, fact, key, source).changes;
    }

    const count = (statement("SELECT COUNT(*) AS count FROM ai_user_facts WHERE guild_id = ? AND user_id = ?")
      .get(guildId, userId) as { count: number }).count;
    const excess = count - MAX_FACTS_PER_USER;
    if (excess > 0) {
      statement(`
        DELETE FROM ai_user_facts WHERE id IN (
          SELECT id FROM ai_user_facts WHERE guild_id = ? AND user_id = ?
          ORDER BY CASE source WHEN 'auto' THEN 0 ELSE 1 END, id ASC
          LIMIT ?
        )
      `).run(guildId, userId, excess);
    }
    return added;
  });
}

export function deleteUserFact(guildId: string, userId: string, factId: number): boolean {
  return statement("DELETE FROM ai_user_facts WHERE guild_id = ? AND user_id = ? AND id = ?")
    .run(guildId, userId, factId).changes > 0;
}

export function deleteUserFacts(guildId: string, userId: string): number {
  return statement("DELETE FROM ai_user_facts WHERE guild_id = ? AND user_id = ?").run(guildId, userId).changes;
}

export function getPersonalMemoryStats(guildId: string): { users: number; facts: number } {
  return statement(`
    SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS facts FROM ai_user_facts WHERE guild_id = ?
  `).get(guildId) as { users: number; facts: number };
}
