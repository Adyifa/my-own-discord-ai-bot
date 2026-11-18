import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Guild,
  type ModalSubmitInteraction
} from "discord.js";
import {
  CORRECTION_INPUT_ID,
  correctionModal,
  feedbackRow,
  parseLearningCustomId,
  type LearningCustomId
} from "../ai/learning/components.js";
import { getExchange, getFeedbackTotals, recordFeedback } from "../ai/learning/exchanges.js";
import { decideFlag, type ModerationFlag } from "../ai/learning/moderation-flags.js";
import { addDocument } from "../ai/rag/knowledge.js";
import type { AiRuntime } from "../ai/runtime.js";
import { describeError, logger } from "../logger.js";
import { truncate } from "../utils/text.js";
import { LogColor } from "./server-log.js";

type LearningInteraction = ButtonInteraction<"cached"> | ModalSubmitInteraction<"cached">;

/**
 * Handles the learning loop's buttons and modals. Returns false when the
 * interaction belongs to something else.
 */
export async function handleLearningInteraction(interaction: LearningInteraction, runtime: AiRuntime): Promise<boolean> {
  const parsed = parseLearningCustomId(interaction.customId);
  if (!parsed) return false;

  if (parsed.kind === "feedback" && interaction.isButton()) await onFeedback(interaction, parsed, runtime);
  else if (parsed.kind === "review" && interaction.isButton()) await onReview(interaction, parsed, runtime);
  else if (parsed.kind === "correction" && interaction.isModalSubmit()) await onCorrection(interaction, parsed, runtime);
  else return false;
  return true;
}

const isModerator = (interaction: LearningInteraction) =>
  interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages);

/** 👍 / 👎 on an answer. A moderator's 👎 opens a form to teach the correct answer. */
async function onFeedback(
  interaction: ButtonInteraction<"cached">,
  parsed: Extract<LearningCustomId, { kind: "feedback" }>,
  runtime: AiRuntime
): Promise<void> {
  const exchange = getExchange(parsed.exchangeId);
  if (!exchange || exchange.guildId !== interaction.guildId) {
    await interaction.reply({ content: "This answer is too old to rate.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Votes are stored with the voter's role: a moderator's 👎 vetoes an answer as an example.
  const moderator = isModerator(interaction);
  const totals = recordFeedback(exchange.id, interaction.user.id, parsed.rating, moderator);
  // A 👍 can turn the answer into a reusable example; the indexer embeds its question
  // in the background so semantic matching finds it for similar questions.
  if (parsed.rating === 1) runtime.indexer?.schedule();
  logger.info("ai.feedback", { guildId: interaction.guildId, exchangeId: exchange.id, rating: parsed.rating, moderator });

  // A moderator's 👎 is the teaching moment: open a form for the correct answer.
  // (A modal must be the first response to the click, so the counts are refreshed separately.)
  if (parsed.rating === -1 && moderator && runtime.settings.learningEnabled) {
    await interaction.showModal(correctionModal(exchange.id, exchange.prompt));
    if (!interaction.message.flags.has(MessageFlags.Ephemeral)) {
      await interaction.message.edit({ components: [feedbackRow(exchange.id, totals)] }).catch(() => undefined);
    }
    return;
  }
  // Everyone else gets instant feedback: the vote counts on the buttons update in place.
  await interaction.update({ components: [feedbackRow(exchange.id, totals)] });
}

/** A moderator's correction becomes a knowledge base entry the bot retrieves next time. */
async function onCorrection(
  interaction: ModalSubmitInteraction<"cached">,
  parsed: Extract<LearningCustomId, { kind: "correction" }>,
  runtime: AiRuntime
): Promise<void> {
  if (!isModerator(interaction)) {
    await interaction.reply({ content: "Only moderators can teach me new answers.", flags: MessageFlags.Ephemeral });
    return;
  }
  const exchange = getExchange(parsed.exchangeId);
  if (!exchange || exchange.guildId !== interaction.guildId) {
    await interaction.reply({ content: "That answer is no longer available.", flags: MessageFlags.Ephemeral });
    return;
  }

  // The correction is stored as a question/answer document in the knowledge base. From now
  // on, retrieval finds it for similar questions and the model cites it like any source.
  // This is how the bot "learns a fact" without retraining the model.
  const correction = interaction.fields.getTextInputValue(CORRECTION_INPUT_ID).trim();
  const question = exchange.prompt.replace(/\s+/g, " ").trim();
  const document = addDocument({
    guildId: interaction.guildId,
    title: truncate(`Correction: ${question}`, 100),
    content: `Question: ${question}\nCorrect answer: ${correction}`,
    source: "correction",
    sourceRef: `exchange:${exchange.id}`,
    createdBy: interaction.user.id
  });
  runtime.indexer?.schedule();
  logger.info("ai.correction_learned", { guildId: interaction.guildId, exchangeId: exchange.id, documentId: document.id });

  await interaction.reply({
    content: `🧠 Learned! Saved as knowledge #${document.id}. I'll use it whenever someone asks something similar.`,
    flags: MessageFlags.Ephemeral
  });
  if (interaction.isFromMessage() && !interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.message.edit({ components: [feedbackRow(exchange.id, getFeedbackTotals(exchange.id))] })
      .catch(() => undefined);
  }
}

/** A moderator confirms or rejects an AI moderation flag; the decision becomes a learned example. */
async function onReview(
  interaction: ButtonInteraction<"cached">,
  parsed: Extract<LearningCustomId, { kind: "review" }>,
  runtime: AiRuntime
): Promise<void> {
  if (!isModerator(interaction)) {
    await interaction.reply({ content: "Only moderators can review AI moderation flags.", flags: MessageFlags.Ephemeral });
    return;
  }

  // The moderator's verdict becomes a labelled example. The next similar message is
  // classified with it in the prompt, so the classifier adapts to this server's norms.
  const decision = parsed.action === "dismiss" ? "false_positive" : "confirmed";
  const flag = decideFlag(parsed.flagId, interaction.guildId, decision, interaction.user.id);
  if (!flag) {
    await interaction.reply({ content: "This flag was already reviewed.", flags: MessageFlags.Ephemeral });
    return;
  }

  let outcome = decision === "confirmed" ? "✅ Confirmed" : "❌ False positive";
  if (parsed.action === "delete") {
    outcome += await deleteFlaggedMessage(interaction.guild, flag) ? " · message deleted" : " · message was already gone";
  }
  runtime.indexer?.schedule();
  logger.info("ai.moderation_reviewed", { guildId: interaction.guildId, flagId: flag.id, decision });

  const original = interaction.message.embeds[0];
  const embed = (original ? EmbedBuilder.from(original) : new EmbedBuilder().setTitle("AI moderation"))
    .setColor(decision === "confirmed" ? LogColor.danger : LogColor.success)
    .addFields({ name: "Moderator review", value: `${outcome} by ${interaction.user} · saved as a learning example` });
  await interaction.update({ embeds: [embed], components: [] });
}

async function deleteFlaggedMessage(guild: Guild, flag: ModerationFlag): Promise<boolean> {
  try {
    const channel = guild.channels.cache.get(flag.channelId) ?? await guild.channels.fetch(flag.channelId);
    if (!channel?.isTextBased()) return false;
    const message = await channel.messages.fetch(flag.messageId);
    await message.delete();
    return true;
  } catch (error) {
    logger.debug("ai.flagged_message_delete_failed", { guildId: guild.id, ...describeError(error) });
    return false;
  }
}
