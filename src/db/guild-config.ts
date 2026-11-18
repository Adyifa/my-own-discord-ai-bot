import { getDatabase, statement } from "./database.js";

export type AiModerationAction = "flag" | "delete";

export interface GuildConfig {
  guildId: string;
  welcomeChannelId: string | null;
  welcomeMessage: string;
  logChannelId: string | null;
  antiLink: boolean;
  antiSpam: boolean;
  capsPercent: number;
  badWords: string;
  aiModeration: boolean;
  aiModerationAction: AiModerationAction;
  aiModerationThreshold: number;
}

export type GuildConfigPatch = Partial<Omit<GuildConfig, "guildId">>;

interface GuildConfigRow {
  guild_id: string;
  welcome_channel_id: string | null;
  welcome_message: string;
  log_channel_id: string | null;
  anti_link: number;
  anti_spam: number;
  caps_percent: number;
  bad_words: string;
  ai_moderation: number;
  ai_moderation_action: string;
  ai_moderation_threshold: number;
}

/** Whitelist of writable fields → SQL columns (column names are never taken from input). */
const COLUMNS = {
  welcomeChannelId: "welcome_channel_id",
  welcomeMessage: "welcome_message",
  logChannelId: "log_channel_id",
  antiLink: "anti_link",
  antiSpam: "anti_spam",
  capsPercent: "caps_percent",
  badWords: "bad_words",
  aiModeration: "ai_moderation",
  aiModerationAction: "ai_moderation_action",
  aiModerationThreshold: "ai_moderation_threshold"
} as const satisfies Record<keyof GuildConfigPatch, string>;

export function getGuildConfig(guildId: string): GuildConfig {
  const select = statement("SELECT * FROM guild_config WHERE guild_id = ?");
  let row = select.get(guildId) as GuildConfigRow | undefined;
  if (!row) {
    statement("INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)").run(guildId);
    row = select.get(guildId) as GuildConfigRow;
  }
  return fromRow(row);
}

export function updateGuildConfig(guildId: string, patch: GuildConfigPatch): GuildConfig {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  getGuildConfig(guildId);
  if (entries.length === 0) return getGuildConfig(guildId);

  const assignments = entries.map(([field]) => {
    const column = (COLUMNS as Record<string, string>)[field];
    if (!column) throw new Error(`Unknown guild config field: ${field}`);
    return `${column} = ?`;
  });
  const values = entries.map(([, value]) => typeof value === "boolean" ? Number(value) : value);
  getDatabase()
    .prepare(`UPDATE guild_config SET ${assignments.join(", ")} WHERE guild_id = ?`)
    .run(...values, guildId);
  return getGuildConfig(guildId);
}

function fromRow(row: GuildConfigRow): GuildConfig {
  return {
    guildId: row.guild_id,
    welcomeChannelId: row.welcome_channel_id,
    welcomeMessage: row.welcome_message,
    logChannelId: row.log_channel_id,
    antiLink: row.anti_link === 1,
    antiSpam: row.anti_spam === 1,
    capsPercent: row.caps_percent,
    badWords: row.bad_words,
    aiModeration: row.ai_moderation === 1,
    aiModerationAction: row.ai_moderation_action === "delete" ? "delete" : "flag",
    aiModerationThreshold: row.ai_moderation_threshold
  };
}
