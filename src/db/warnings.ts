import { statement } from "./database.js";

export interface Warning {
  id: number;
  moderatorId: string;
  reason: string;
  createdAt: string;
}

export function addWarning(
  guildId: string,
  userId: string,
  moderatorId: string,
  reason: string
): number {
  const result = statement(
    "INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES (?, ?, ?, ?)"
  ).run(guildId, userId, moderatorId, reason);
  return Number(result.lastInsertRowid);
}

export function listWarnings(guildId: string, userId: string, limit = 10): Warning[] {
  return statement(`
    SELECT id, moderator_id AS moderatorId, reason, created_at AS createdAt
    FROM warnings
    WHERE guild_id = ? AND user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(guildId, userId, limit) as Warning[];
}

export function countWarnings(guildId: string, userId: string): number {
  const row = statement(
    "SELECT COUNT(*) AS count FROM warnings WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, userId) as { count: number };
  return row.count;
}
