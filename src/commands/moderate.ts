import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  time,
  type GuildMember,
  type User
} from "discord.js";
import { addWarning, countWarnings, listWarnings } from "../db/warnings.js";
import { LogColor, sendLog } from "../features/server-log.js";
import { parseSqliteTimestamp, truncate } from "../utils/text.js";
import {
  UserFacingError,
  commandChannel,
  missingBotPermissions,
  replyEphemeral,
  type GuildCommandInteraction,
  type SlashCommand
} from "./types.js";

const REQUIRED_PERMISSION = {
  timeout: PermissionFlagsBits.ModerateMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
  purge: PermissionFlagsBits.ManageMessages,
  warn: PermissionFlagsBits.ModerateMembers,
  warnings: PermissionFlagsBits.ModerateMembers
} as const;

type ModerationSubcommand = keyof typeof REQUIRED_PERMISSION;

export const moderateCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("moderate")
    .setDescription("Moderation tools")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(sub => sub
      .setName("timeout").setDescription("Temporarily time out a member")
      .addUserOption(option => option.setName("member").setDescription("Member").setRequired(true))
      .addIntegerOption(option => option
        .setName("minutes").setDescription("Duration in minutes (max 28 days)")
        .setMinValue(1).setMaxValue(40_320).setRequired(true))
      .addStringOption(option => option.setName("reason").setDescription("Reason").setMaxLength(500)))
    .addSubcommand(sub => sub
      .setName("kick").setDescription("Kick a member")
      .addUserOption(option => option.setName("member").setDescription("Member").setRequired(true))
      .addStringOption(option => option.setName("reason").setDescription("Reason").setMaxLength(500)))
    .addSubcommand(sub => sub
      .setName("ban").setDescription("Ban a member")
      .addUserOption(option => option.setName("member").setDescription("Member").setRequired(true))
      .addStringOption(option => option.setName("reason").setDescription("Reason").setMaxLength(500)))
    .addSubcommand(sub => sub
      .setName("purge").setDescription("Bulk-delete recent messages (younger than 14 days)")
      .addIntegerOption(option => option
        .setName("amount").setDescription("How many messages (1-100)")
        .setMinValue(1).setMaxValue(100).setRequired(true)))
    .addSubcommand(sub => sub
      .setName("warn").setDescription("Warn a member")
      .addUserOption(option => option.setName("member").setDescription("Member").setRequired(true))
      .addStringOption(option => option.setName("reason").setDescription("Reason").setMaxLength(500).setRequired(true)))
    .addSubcommand(sub => sub
      .setName("warnings").setDescription("Show a member's latest warnings")
      .addUserOption(option => option.setName("member").setDescription("Member").setRequired(true))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand() as ModerationSubcommand;
    if (!interaction.memberPermissions.has(REQUIRED_PERMISSION[subcommand])) {
      throw new UserFacingError(`You do not have permission to use \`${subcommand}\`.`);
    }

    if (subcommand === "purge") return purge(interaction);
    if (subcommand === "warnings") return showWarnings(interaction);

    const user = interaction.options.getUser("member", true);
    const reason = interaction.options.getString("reason") ?? `Action by ${interaction.user.tag}`;
    const target = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (target) assertCanModerate(interaction, target);

    if (subcommand === "warn") return warn(interaction, user, reason);
    if (!target) throw new UserFacingError("That user is not a member of this server.");

    if (subcommand === "timeout") {
      if (!target.moderatable) throw new UserFacingError("I cannot time out that member — check the role hierarchy.");
      const minutes = interaction.options.getInteger("minutes", true);
      await notify(user, `You were timed out in **${interaction.guild.name}** for ${minutes} minute(s). Reason: ${reason}`);
      await target.timeout(minutes * 60_000, reason);
    } else if (subcommand === "kick") {
      if (!target.kickable) throw new UserFacingError("I cannot kick that member — check the role hierarchy.");
      await notify(user, `You were kicked from **${interaction.guild.name}**. Reason: ${reason}`);
      await target.kick(reason);
    } else {
      if (!target.bannable) throw new UserFacingError("I cannot ban that member — check the role hierarchy.");
      await notify(user, `You were banned from **${interaction.guild.name}**. Reason: ${reason}`);
      await target.ban({ reason });
    }

    await sendLog(interaction.guild, {
      title: `Member ${subcommand === "timeout" ? "timed out" : subcommand === "kick" ? "kicked" : "banned"}`,
      color: LogColor.danger,
      fields: [
        { name: "Member", value: `${user} (${user.tag})`, inline: true },
        { name: "Moderator", value: `${interaction.user}`, inline: true },
        { name: "Reason", value: reason }
      ]
    });
    await interaction.reply({ content: `✅ ${subcommand} applied to ${user}.`, allowedMentions: { parse: [] } });
  }
};

function assertCanModerate(interaction: GuildCommandInteraction, target: GuildMember): void {
  if (target.id === interaction.user.id) throw new UserFacingError("You cannot moderate yourself.");
  if (target.id === interaction.client.user.id) throw new UserFacingError("I cannot moderate myself.");
  if (target.id === interaction.guild.ownerId) throw new UserFacingError("The server owner cannot be moderated.");
  const isOwner = interaction.guild.ownerId === interaction.user.id;
  if (!isOwner && target.roles.highest.position >= interaction.member.roles.highest.position) {
    throw new UserFacingError("You cannot moderate a member whose highest role is equal to or above yours.");
  }
}

async function warn(interaction: GuildCommandInteraction, user: User, reason: string): Promise<void> {
  const id = addWarning(interaction.guildId, user.id, interaction.user.id, reason);
  const total = countWarnings(interaction.guildId, user.id);
  await notify(user, `You were warned in **${interaction.guild.name}**: ${reason}`);
  await sendLog(interaction.guild, {
    title: "Member warned",
    color: LogColor.warning,
    fields: [
      { name: "Member", value: `${user} (${user.tag})`, inline: true },
      { name: "Moderator", value: `${interaction.user}`, inline: true },
      { name: "Warning", value: `#${id} (total: ${total})`, inline: true },
      { name: "Reason", value: reason }
    ]
  });
  await interaction.reply({
    content: `⚠️ ${user} has been warned (warning #${id}, ${total} in total).`,
    allowedMentions: { parse: [] }
  });
}

async function showWarnings(interaction: GuildCommandInteraction): Promise<void> {
  const user = interaction.options.getUser("member", true);
  const warnings = listWarnings(interaction.guildId, user.id, 10);
  const total = countWarnings(interaction.guildId, user.id);
  const lines = warnings.map(warning => {
    const date = parseSqliteTimestamp(warning.createdAt);
    return `**#${warning.id}** · ${date ? time(date, "d") : warning.createdAt} · by <@${warning.moderatorId}>\n` +
      `> ${truncate(warning.reason, 200)}`;
  });
  await replyEphemeral(interaction, {
    content: warnings.length > 0
      ? `Warnings for ${user} (showing ${warnings.length} of ${total}):\n${lines.join("\n")}`
      : `${user} has no warnings.`,
    allowedMentions: { parse: [] }
  });
}

async function purge(interaction: GuildCommandInteraction): Promise<void> {
  const channel = await commandChannel(interaction);
  const missing = missingBotPermissions(interaction, channel, {
    "Manage Messages": PermissionFlagsBits.ManageMessages,
    "Read Message History": PermissionFlagsBits.ReadMessageHistory
  });
  if (missing.length > 0) throw new UserFacingError(`I need these permissions here: ${missing.join(", ")}.`);

  const amount = interaction.options.getInteger("amount", true);
  const deleted = await channel.bulkDelete(amount, true);
  await sendLog(interaction.guild, {
    title: "Messages purged",
    color: LogColor.warning,
    fields: [
      { name: "Channel", value: `${channel}`, inline: true },
      { name: "Moderator", value: `${interaction.user}`, inline: true },
      { name: "Deleted", value: `${deleted.size}`, inline: true }
    ]
  });
  await replyEphemeral(interaction, `🧹 Deleted ${deleted.size} message(s). Messages older than 14 days are skipped.`);
}

/** Best-effort DM to the affected user (they may have DMs closed). */
async function notify(user: User, content: string): Promise<void> {
  await user.send(content).catch(() => undefined);
}
