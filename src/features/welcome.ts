import { time, type GuildMember } from "discord.js";
import { getGuildConfig } from "../db/guild-config.js";
import { describeError, logger } from "../logger.js";
import { LogColor, sendLog } from "./server-log.js";

export const DEFAULT_WELCOME_MESSAGE = "Welcome {user} to **{server}**!";

export function renderWelcomeMessage(template: string, values: { user: string; server: string }): string {
  return template.replaceAll("{user}", values.user).replaceAll("{server}", values.server);
}

export async function welcomeMember(member: GuildMember): Promise<void> {
  const config = getGuildConfig(member.guild.id);

  if (config.welcomeChannelId) {
    const channel = member.guild.channels.cache.get(config.welcomeChannelId) ??
      await member.guild.channels.fetch(config.welcomeChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const content = renderWelcomeMessage(config.welcomeMessage, { user: `${member}`, server: member.guild.name });
      await channel.send({ content, allowedMentions: { users: [member.id] } })
        .catch(error => logger.warn("welcome.send_failed", { guildId: member.guild.id, ...describeError(error) }));
    }
  }

  await sendLog(member.guild, {
    title: "Member joined",
    color: LogColor.success,
    description: `${member.user} (${member.user.tag})`,
    fields: [{ name: "Account created", value: time(member.user.createdAt, "R"), inline: true }]
  });
}
