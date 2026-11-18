import { statement } from "../db/database.js";

export const MAX_CUSTOM_INSTRUCTIONS = 1_000;

export interface AiGuildSettings {
  enabled: boolean;
  /** Channel where the AI answers every message without needing a mention. */
  channelId: string | null;
  /** Whether a mention in any other channel also triggers the AI. */
  mentionEnabled: boolean;
  /** Extra instructions from the server admins (rules, tone, topics). */
  customInstructions: string | null;
}

interface AiConfigRow {
  enabled: number;
  channel_id: string | null;
  mention_enabled: number;
  custom_instructions: string | null;
}

export function getAiGuildSettings(guildId: string): AiGuildSettings {
  const row = statement(
    "SELECT enabled, channel_id, mention_enabled, custom_instructions FROM ai_config WHERE guild_id = ?"
  ).get(guildId) as AiConfigRow | undefined;
  return {
    enabled: row?.enabled === 1,
    channelId: row?.channel_id ?? null,
    mentionEnabled: row ? row.mention_enabled === 1 : true,
    customInstructions: row?.custom_instructions ?? null
  };
}

export function enableAi(guildId: string, channelId: string, mentionEnabled: boolean): void {
  statement(`
    INSERT INTO ai_config (guild_id, enabled, channel_id, mention_enabled)
    VALUES (?, 1, ?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET
      enabled = 1,
      channel_id = excluded.channel_id,
      mention_enabled = excluded.mention_enabled,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, channelId, Number(mentionEnabled));
}

export function disableAi(guildId: string): void {
  statement(`
    INSERT INTO ai_config (guild_id, enabled) VALUES (?, 0)
    ON CONFLICT (guild_id) DO UPDATE SET enabled = 0, updated_at = CURRENT_TIMESTAMP
  `).run(guildId);
}

export function setCustomInstructions(guildId: string, instructions: string | null): void {
  statement(`
    INSERT INTO ai_config (guild_id, custom_instructions) VALUES (?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET
      custom_instructions = excluded.custom_instructions,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, instructions);
}
