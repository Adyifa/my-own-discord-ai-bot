import {
  EmbedBuilder,
  time,
  type ActionRowBuilder,
  type ButtonBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type PartialMessage
} from "discord.js";
import { getGuildConfig } from "../db/guild-config.js";
import { describeError, logger } from "../logger.js";
import { truncate } from "../utils/text.js";

export const LogColor = {
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  ai: 0xeb459e
} as const;

export interface LogField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface LogEntry {
  title: string;
  description?: string;
  color?: number;
  fields?: LogField[];
  /** Optional buttons, e.g. moderator review actions. */
  components?: ActionRowBuilder<ButtonBuilder>[];
}

/** Posts an embed to the server's log channel, if one is configured. Never throws. */
export async function sendLog(guild: Guild, entry: LogEntry): Promise<void> {
  const channelId = getGuildConfig(guild.id).logChannelId;
  if (!channelId) return;

  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle(truncate(entry.title, 256))
    .setColor(entry.color ?? LogColor.info)
    .setTimestamp();
  if (entry.description) embed.setDescription(truncate(entry.description, 4_000));
  if (entry.fields?.length) {
    embed.addFields(entry.fields.slice(0, 25).map(field => ({
      name: truncate(field.name, 256),
      value: truncate(field.value || "—", 1_024),
      inline: field.inline ?? false
    })));
  }

  await channel.send({ embeds: [embed], components: entry.components ?? [], allowedMentions: { parse: [] } })
    .catch(error => logger.warn("log.send_failed", { guildId: guild.id, ...describeError(error) }));
}

export async function logMemberLeft(member: GuildMember | PartialGuildMember): Promise<void> {
  await sendLog(member.guild, {
    title: "Member left",
    color: LogColor.danger,
    description: `${member.user} (${member.user.tag})`,
    fields: member.joinedAt ? [{ name: "Joined", value: time(member.joinedAt, "R"), inline: true }] : []
  });
}

export async function logMessageDeleted(message: Message | PartialMessage): Promise<void> {
  if (!message.guild || message.author?.bot) return;
  await sendLog(message.guild, {
    title: "Message deleted",
    color: LogColor.danger,
    fields: [
      { name: "Author", value: message.author ? `${message.author} (${message.author.tag})` : "Unknown", inline: true },
      { name: "Channel", value: `${message.channel}`, inline: true },
      { name: "Content", value: message.content || "*Unavailable (message was not cached)*" }
    ]
  });
}

export async function logMessageEdited(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage
): Promise<void> {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;
  await sendLog(newMessage.guild, {
    title: "Message edited",
    color: LogColor.warning,
    fields: [
      { name: "Author", value: newMessage.author ? `${newMessage.author}` : "Unknown", inline: true },
      { name: "Channel", value: `${newMessage.channel}`, inline: true },
      { name: "Before", value: oldMessage.content || "*Unavailable (message was not cached)*" },
      { name: "After", value: newMessage.content || "*Unavailable*" },
      { name: "Link", value: newMessage.url }
    ]
  });
}
