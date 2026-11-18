import { statement, transaction } from "../db/database.js";

/** One conversation = one user in one channel of one server. */
export interface ConversationKey {
  guildId: string;
  channelId: string;
  userId: string;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export const MEMORY_LIMITS = {
  /** Most recent messages sent to the model word-for-word. */
  contextMessages: 12,
  contextCharacters: 8_000,
  /** Above this many stored messages, older ones are folded into a rolling summary. */
  compactAbove: 24,
  /** Safety net in case summarisation keeps failing. */
  hardCap: 100,
  retentionDays: 30
} as const;

const CONVERSATION = "guild_id = ? AND channel_id = ? AND user_id = ?";

function keyParams(key: ConversationKey): [string, string, string] {
  return [key.guildId, key.channelId, key.userId];
}

/** Recent history in chronological order, trimmed to a character budget and starting with a user turn. */
export function getRecentMessages(
  key: ConversationKey,
  maxMessages: number = MEMORY_LIMITS.contextMessages,
  maxCharacters: number = MEMORY_LIMITS.contextCharacters
): StoredMessage[] {
  const rows = statement(`
    SELECT id, role, content FROM ai_messages
    WHERE ${CONVERSATION}
    ORDER BY id DESC
    LIMIT ?
  `).all(...keyParams(key), maxMessages) as StoredMessage[];

  const selected: StoredMessage[] = [];
  let used = 0;
  for (const row of rows) {
    if (used + row.content.length > maxCharacters) break;
    selected.push(row);
    used += row.content.length;
  }
  selected.reverse();
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}

export function saveExchange(key: ConversationKey, userContent: string, assistantContent: string): void {
  transaction(() => {
    const insert = statement(
      "INSERT INTO ai_messages (guild_id, channel_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)"
    );
    insert.run(...keyParams(key), "user", userContent);
    insert.run(...keyParams(key), "assistant", assistantContent);
    statement(`
      DELETE FROM ai_messages
      WHERE ${CONVERSATION}
        AND id NOT IN (SELECT id FROM ai_messages WHERE ${CONVERSATION} ORDER BY id DESC LIMIT ?)
    `).run(...keyParams(key), ...keyParams(key), MEMORY_LIMITS.hardCap);
  });
}

export function countMessages(key: ConversationKey): number {
  const row = statement(`SELECT COUNT(*) AS count FROM ai_messages WHERE ${CONVERSATION}`)
    .get(...keyParams(key)) as { count: number };
  return row.count;
}

/** Everything except the newest `keepRecent` messages, oldest first. */
export function getMessagesToCompact(key: ConversationKey, keepRecent: number): StoredMessage[] {
  return statement(`
    SELECT id, role, content FROM ai_messages
    WHERE ${CONVERSATION}
      AND id NOT IN (SELECT id FROM ai_messages WHERE ${CONVERSATION} ORDER BY id DESC LIMIT ?)
    ORDER BY id ASC
  `).all(...keyParams(key), ...keyParams(key), keepRecent) as StoredMessage[];
}

export function getSummary(key: ConversationKey): string | null {
  const row = statement(`SELECT summary FROM ai_conversation_summaries WHERE ${CONVERSATION}`)
    .get(...keyParams(key)) as { summary: string } | undefined;
  return row?.summary ?? null;
}

/** Atomically stores the new summary and deletes the messages it now covers. */
export function replaceWithSummary(key: ConversationKey, summary: string, throughMessageId: number): void {
  transaction(() => {
    statement(`
      INSERT INTO ai_conversation_summaries (guild_id, channel_id, user_id, summary)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (guild_id, channel_id, user_id)
      DO UPDATE SET summary = excluded.summary, updated_at = CURRENT_TIMESTAMP
    `).run(...keyParams(key), summary);
    statement(`DELETE FROM ai_messages WHERE ${CONVERSATION} AND id <= ?`)
      .run(...keyParams(key), throughMessageId);
  });
}

export interface MemoryScope {
  guildId: string;
  channelId?: string;
  userId?: string;
}

/** Deletes stored messages and summaries in the scope. Returns the number of messages removed. */
export function deleteMemory(scope: MemoryScope): number {
  const conditions = ["guild_id = ?"];
  const params = [scope.guildId];
  if (scope.channelId) {
    conditions.push("channel_id = ?");
    params.push(scope.channelId);
  }
  if (scope.userId) {
    conditions.push("user_id = ?");
    params.push(scope.userId);
  }
  const where = conditions.join(" AND ");
  return transaction(() => {
    statement(`DELETE FROM ai_conversation_summaries WHERE ${where}`).run(...params);
    return statement(`DELETE FROM ai_messages WHERE ${where}`).run(...params).changes;
  });
}

/** How much conversation memory exists for one member across all channels of a server. */
export function getUserMemoryOverview(guildId: string, userId: string): { messages: number; summaries: number; channels: number } {
  return statement(`
    SELECT
      (SELECT COUNT(*) FROM ai_messages WHERE guild_id = @guildId AND user_id = @userId) AS messages,
      (SELECT COUNT(*) FROM ai_conversation_summaries WHERE guild_id = @guildId AND user_id = @userId) AS summaries,
      (SELECT COUNT(DISTINCT channel_id) FROM ai_messages WHERE guild_id = @guildId AND user_id = @userId) AS channels
  `).get({ guildId, userId }) as { messages: number; summaries: number; channels: number };
}

export function countGuildMessages(guildId: string): number {
  const row = statement("SELECT COUNT(*) AS count FROM ai_messages WHERE guild_id = ?")
    .get(guildId) as { count: number };
  return row.count;
}

/** Removes memory older than the retention window. Returns the number of messages removed. */
export function purgeExpiredMemory(retentionDays: number = MEMORY_LIMITS.retentionDays): number {
  const cutoff = `-${retentionDays} days`;
  return transaction(() => {
    statement("DELETE FROM ai_conversation_summaries WHERE updated_at < datetime('now', ?)").run(cutoff);
    return statement("DELETE FROM ai_messages WHERE created_at < datetime('now', ?)").run(cutoff).changes;
  });
}
