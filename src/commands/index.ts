import {
  DiscordAPIError,
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type ModalSubmitInteraction
} from "discord.js";
import type { AppContext } from "../context.js";
import { handleLearningInteraction } from "../features/learning-interactions.js";
import { describeError, logger } from "../logger.js";
import { aiCommand } from "./ai.js";
import { moderateCommand } from "./moderate.js";
import { reactionRoleCommand } from "./reaction-role.js";
import { setupCommand } from "./setup.js";
import { UserFacingError, replyEphemeral, type SlashCommand } from "./types.js";

export const commands: readonly SlashCommand[] = [setupCommand, moderateCommand, reactionRoleCommand, aiCommand];

const commandsByName = new Map(commands.map(command => [command.data.name, command]));

/** Routes slash commands, buttons and modals, turning any error into a friendly reply. */
export async function handleInteraction(interaction: Interaction, context: AppContext): Promise<void> {
  if (interaction.isButton() || interaction.isModalSubmit()) {
    await handleComponent(interaction, context);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: "Please use this command inside a server.", flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
    return;
  }

  try {
    await command.execute(interaction, context);
  } catch (error) {
    const content = error instanceof UserFacingError
      ? `❌ ${error.message}`
      : error instanceof DiscordAPIError
        ? `❌ Discord rejected that action: ${error.message}`
        : "❌ Something went wrong while running that command.";
    if (!(error instanceof UserFacingError)) {
      logger.error("command.failed", {
        command: interaction.commandName,
        subcommand: interaction.options.getSubcommand(false),
        guildId: interaction.guildId,
        ...describeError(error)
      });
    }
    await replyEphemeral(interaction, content).catch(() => undefined);
  }
}

async function handleComponent(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  context: AppContext
): Promise<void> {
  try {
    if (interaction.isButton() && interaction.inCachedGuild()) {
      await handleLearningInteraction(interaction, context.ai);
    } else if (interaction.isModalSubmit() && interaction.inCachedGuild()) {
      await handleLearningInteraction(interaction, context.ai);
    }
  } catch (error) {
    logger.error("component.failed", { customId: interaction.customId, guildId: interaction.guildId, ...describeError(error) });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Something went wrong.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
}
