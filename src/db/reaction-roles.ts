import { statement } from "./database.js";

export interface ReactionRole {
  guildId: string;
  messageId: string;
  channelId: string;
  /** Custom emoji ID, or the Unicode emoji itself. */
  emoji: string;
  roleId: string;
}

export function upsertReactionRole(binding: ReactionRole): void {
  statement(`
    INSERT INTO reaction_roles (guild_id, message_id, channel_id, emoji, role_id)
    VALUES (@guildId, @messageId, @channelId, @emoji, @roleId)
    ON CONFLICT (guild_id, message_id, emoji)
    DO UPDATE SET role_id = excluded.role_id, channel_id = excluded.channel_id
  `).run(binding);
}

export function removeReactionRole(guildId: string, messageId: string, emoji: string): boolean {
  return statement(
    "DELETE FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?"
  ).run(guildId, messageId, emoji).changes > 0;
}

export function findReactionRole(
  guildId: string,
  messageId: string,
  emoji: string
): ReactionRole | undefined {
  return statement(`
    SELECT guild_id AS guildId, message_id AS messageId, channel_id AS channelId, emoji, role_id AS roleId
    FROM reaction_roles
    WHERE guild_id = ? AND message_id = ? AND emoji = ?
  `).get(guildId, messageId, emoji) as ReactionRole | undefined;
}
