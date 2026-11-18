import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type GuildTextBasedChannel,
  type MessageMentionOptions,
  type PermissionResolvable,
  type RESTPostAPIChatInputApplicationCommandsJSONBody
} from "discord.js";
import type { AppContext } from "../context.js";

export type GuildCommandInteraction = ChatInputCommandInteraction<"cached">;

export interface SlashCommand {
  data: { readonly name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(interaction: GuildCommandInteraction, context: AppContext): Promise<void>;
}

/** An error whose message is safe and helpful to show to the person who ran the command. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export function requireAdministrator(interaction: GuildCommandInteraction): void {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    throw new UserFacingError("Only server administrators can use this.");
  }
}

export interface SimpleReply {
  content?: string;
  embeds?: EmbedBuilder[];
  allowedMentions?: MessageMentionOptions;
}

/** Ephemeral response that works whether or not the interaction was already acknowledged. */
export async function replyEphemeral(
  interaction: ChatInputCommandInteraction,
  reply: string | SimpleReply
): Promise<void> {
  const options = typeof reply === "string" ? { content: reply } : reply;
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply(options);
  } else if (interaction.replied) {
    await interaction.followUp({ ...options, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ ...options, flags: MessageFlags.Ephemeral });
  }
}

/** The text channel the command was used in (fetched if it is not cached, e.g. some threads). */
export async function commandChannel(interaction: GuildCommandInteraction): Promise<GuildTextBasedChannel> {
  const channel = interaction.channel ??
    await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new UserFacingError("This command only works in text channels.");
  return channel;
}

/** Lists the permissions the bot is missing in a channel (empty when all are present). */
export function missingBotPermissions(
  interaction: GuildCommandInteraction,
  channel: GuildTextBasedChannel,
  required: Record<string, PermissionResolvable>
): string[] {
  const me = interaction.guild.members.me;
  if (!me) return Object.keys(required);
  const permissions = me.permissionsIn(channel);
  return Object.entries(required).filter(([, flag]) => !permissions.has(flag)).map(([name]) => name);
}
