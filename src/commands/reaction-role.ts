import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder
} from "discord.js";
import { removeReactionRole, upsertReactionRole } from "../db/reaction-roles.js";
import { emojiKey } from "../features/reaction-roles.js";
import { UserFacingError, commandChannel, replyEphemeral, type SlashCommand } from "./types.js";

export const reactionRoleCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("reaction-role")
    .setDescription("Manage emoji reaction roles")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(sub => sub
      .setName("add").setDescription("Bind an emoji on a message to a role")
      .addStringOption(option => option.setName("message_id").setDescription("Discord message ID").setRequired(true))
      .addStringOption(option => option.setName("emoji").setDescription("Unicode or custom emoji").setRequired(true))
      .addRoleOption(option => option.setName("role").setDescription("Role to grant").setRequired(true))
      .addChannelOption(option => option
        .setName("channel").setDescription("Channel of the message (defaults to this one)")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(sub => sub
      .setName("remove").setDescription("Remove a reaction-role binding")
      .addStringOption(option => option.setName("message_id").setDescription("Discord message ID").setRequired(true))
      .addStringOption(option => option.setName("emoji").setDescription("Bound emoji").setRequired(true))),

  async execute(interaction) {
    const messageId = interaction.options.getString("message_id", true).trim();
    const emoji = interaction.options.getString("emoji", true).trim();
    if (!/^\d{15,22}$/.test(messageId)) throw new UserFacingError("That does not look like a message ID.");

    if (interaction.options.getSubcommand() === "remove") {
      const removed = removeReactionRole(interaction.guildId, messageId, emojiKey(emoji));
      await replyEphemeral(interaction, removed ? "✅ Reaction role removed." : "No reaction role matched that message and emoji.");
      return;
    }

    const channel = interaction.options.getChannel("channel", false, [ChannelType.GuildText, ChannelType.GuildAnnouncement]) ??
      await commandChannel(interaction);
    const role = interaction.options.getRole("role", true);
    const me = interaction.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
      throw new UserFacingError("Move my role above the role I should assign, and give me Manage Roles.");
    }
    if (role.managed || role.id === interaction.guildId) {
      throw new UserFacingError("That role is managed by Discord or an integration and cannot be assigned.");
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) throw new UserFacingError(`I could not find that message in ${channel}.`);
    await message.react(emoji).catch(() => {
      throw new UserFacingError("I could not react with that emoji. Use a Unicode emoji or one from this server.");
    });

    upsertReactionRole({
      guildId: interaction.guildId,
      messageId,
      channelId: channel.id,
      emoji: emojiKey(emoji),
      roleId: role.id
    });
    await replyEphemeral(interaction, `✅ Reacting with ${emoji} on that message now grants ${role}.`);
  }
};
