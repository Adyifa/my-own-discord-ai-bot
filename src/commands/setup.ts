import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from "discord.js";
import { getGuildConfig, updateGuildConfig, type AiModerationAction, type GuildConfig } from "../db/guild-config.js";
import { LogColor } from "../features/server-log.js";
import { DEFAULT_WELCOME_MESSAGE } from "../features/welcome.js";
import { truncate } from "../utils/text.js";
import { missingBotPermissions, replyEphemeral, type SlashCommand } from "./types.js";

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;
const CLEAR_WORDS = new Set(["none", "off", "-", "clear"]);

export const setupCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure Carl Lite for this server")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName("welcome")
      .setDescription("Set the welcome channel and message")
      .addChannelOption(option => option
        .setName("channel").setDescription("Where to greet new members")
        .addChannelTypes(...TEXT_CHANNELS).setRequired(true))
      .addStringOption(option => option
        .setName("message").setDescription("Welcome text; use {user} and {server}").setMaxLength(500)))
    .addSubcommand(sub => sub
      .setName("logs")
      .setDescription("Set the moderation log channel")
      .addChannelOption(option => option
        .setName("channel").setDescription("Where moderation events are logged")
        .addChannelTypes(...TEXT_CHANNELS).setRequired(true)))
    .addSubcommand(sub => sub
      .setName("automod")
      .setDescription("Configure rule-based and AI moderation")
      .addBooleanOption(option => option.setName("anti_link").setDescription("Delete links posted by non-moderators"))
      .addBooleanOption(option => option.setName("anti_spam").setDescription("Delete bursts of fast repeated messages"))
      .addIntegerOption(option => option
        .setName("caps_percent").setDescription("Uppercase threshold in percent (0 disables)")
        .setMinValue(0).setMaxValue(100))
      .addStringOption(option => option
        .setName("bad_words").setDescription("Comma-separated blocked words, word* matches endings, \"none\" clears")
        .setMaxLength(1000))
      .addBooleanOption(option => option
        .setName("ai_moderation").setDescription("Let the AI review messages for harassment, hate, scams and more"))
      .addStringOption(option => option
        .setName("ai_action").setDescription("What to do with messages the AI flags")
        .addChoices(
          { name: "Flag in the log channel (recommended)", value: "flag" },
          { name: "Delete and log", value: "delete" }
        ))
      .addNumberOption(option => option
        .setName("ai_threshold").setDescription("Minimum AI confidence before acting, 0.5-1.0 (default 0.8)")
        .setMinValue(0.5).setMaxValue(1)))
    .addSubcommand(sub => sub.setName("status").setDescription("Show the current configuration")),

  async execute(interaction, context) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (subcommand === "status") {
      await interaction.reply({ embeds: [settingsEmbed(getGuildConfig(guildId))], flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === "welcome") {
      const channel = interaction.options.getChannel("channel", true, TEXT_CHANNELS);
      updateGuildConfig(guildId, {
        welcomeChannelId: channel.id,
        welcomeMessage: interaction.options.getString("message") ?? DEFAULT_WELCOME_MESSAGE
      });
      const missing = missingBotPermissions(interaction, channel, {
        "View Channel": PermissionFlagsBits.ViewChannel,
        "Send Messages": PermissionFlagsBits.SendMessages
      });
      await replyEphemeral(interaction, `✅ New members will be welcomed in ${channel}.${missingNote(missing)}`);
      return;
    }

    if (subcommand === "logs") {
      const channel = interaction.options.getChannel("channel", true, TEXT_CHANNELS);
      updateGuildConfig(guildId, { logChannelId: channel.id });
      const missing = missingBotPermissions(interaction, channel, {
        "View Channel": PermissionFlagsBits.ViewChannel,
        "Send Messages": PermissionFlagsBits.SendMessages,
        "Embed Links": PermissionFlagsBits.EmbedLinks
      });
      await replyEphemeral(interaction, `✅ Moderation logs will be posted in ${channel}.${missingNote(missing)}`);
      return;
    }

    // automod
    const badWords = interaction.options.getString("bad_words");
    const config = updateGuildConfig(guildId, {
      antiLink: interaction.options.getBoolean("anti_link") ?? undefined,
      antiSpam: interaction.options.getBoolean("anti_spam") ?? undefined,
      capsPercent: interaction.options.getInteger("caps_percent") ?? undefined,
      badWords: badWords === null ? undefined : normalizeWordList(badWords),
      aiModeration: interaction.options.getBoolean("ai_moderation") ?? undefined,
      aiModerationAction: (interaction.options.getString("ai_action") as AiModerationAction | null) ?? undefined,
      aiModerationThreshold: interaction.options.getNumber("ai_threshold") ?? undefined
    });

    const notes: string[] = [];
    if (config.aiModeration && !context.ai.provider) {
      notes.push("⚠️ AI moderation is on, but no AI model is configured yet (see `/ai status`).");
    }
    if (config.aiModeration && !config.logChannelId) {
      notes.push("ℹ️ Set a log channel with `/setup logs` to see what the AI flags.");
    }
    await interaction.reply({
      content: ["✅ AutoMod settings saved.", ...notes].join("\n"),
      embeds: [settingsEmbed(config)],
      flags: MessageFlags.Ephemeral
    });
  }
};

function normalizeWordList(input: string): string {
  if (CLEAR_WORDS.has(input.trim().toLowerCase())) return "";
  const words = input.split(",").map(word => word.trim()).filter(Boolean);
  return [...new Set(words)].join(",");
}

function missingNote(missing: string[]): string {
  return missing.length > 0 ? `\n⚠️ I am missing these permissions there: ${missing.join(", ")}.` : "";
}

function settingsEmbed(config: GuildConfig): EmbedBuilder {
  const words = config.badWords ? config.badWords.split(",") : [];
  const onOff = (value: boolean) => value ? "On" : "Off";
  return new EmbedBuilder()
    .setTitle("Carl Lite settings")
    .setColor(LogColor.info)
    .addFields(
      { name: "Welcome", value: config.welcomeChannelId ? `<#${config.welcomeChannelId}>` : "Off", inline: true },
      { name: "Logs", value: config.logChannelId ? `<#${config.logChannelId}>` : "Off", inline: true },
      { name: "Anti-link", value: onOff(config.antiLink), inline: true },
      { name: "Anti-spam", value: onOff(config.antiSpam), inline: true },
      { name: "Caps threshold", value: config.capsPercent > 0 ? `${config.capsPercent}%` : "Off", inline: true },
      {
        name: `Blocked words (${words.length})`,
        value: words.length > 0 ? `||${truncate(words.join(", "), 1_000)}||` : "None",
        inline: true
      },
      {
        name: "AI moderation",
        value: config.aiModeration
          ? `On · ${config.aiModerationAction === "delete" ? "delete + log" : "flag for review"} at ≥ ${Math.round(config.aiModerationThreshold * 100)}% confidence`
          : "Off"
      }
    );
}
