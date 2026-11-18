import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { truncate } from "../../utils/text.js";
import type { FeedbackTotals } from "./exchanges.js";

export const CUSTOM_ID_PREFIX = {
  feedback: "ai-fb",
  correction: "ai-fix",
  review: "ai-mod"
} as const;

export const CORRECTION_INPUT_ID = "answer";

export type ReviewAction = "confirm" | "delete" | "dismiss";

export type LearningCustomId =
  | { kind: "feedback"; exchangeId: number; rating: 1 | -1 }
  | { kind: "correction"; exchangeId: number }
  | { kind: "review"; flagId: number; action: ReviewAction };

/** 👍 / 👎 under every AI answer, with live vote counts. */
export function feedbackRow(exchangeId: number, totals: FeedbackTotals = { up: 0, down: 0 }): ActionRowBuilder<ButtonBuilder> {
  const button = (rating: "up" | "down", emoji: string, count: number) => {
    const builder = new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX.feedback}:${exchangeId}:${rating}`)
      .setEmoji(emoji)
      .setStyle(ButtonStyle.Secondary);
    return count > 0 ? builder.setLabel(String(count)) : builder;
  };
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button("up", "👍", totals.up),
    button("down", "👎", totals.down)
  );
}

/** Human-in-the-loop review buttons on AI moderation flags in the log channel. */
export function reviewRow(flagId: number, alreadyDeleted: boolean): ActionRowBuilder<ButtonBuilder> {
  const id = (action: ReviewAction) => `${CUSTOM_ID_PREFIX.review}:${flagId}:${action}`;
  const buttons = [
    new ButtonBuilder().setCustomId(id("confirm")).setLabel("Correct flag").setEmoji("✅").setStyle(ButtonStyle.Success)
  ];
  if (!alreadyDeleted) {
    buttons.push(
      new ButtonBuilder().setCustomId(id("delete")).setLabel("Correct + delete").setEmoji("🗑️").setStyle(ButtonStyle.Danger)
    );
  }
  buttons.push(
    new ButtonBuilder().setCustomId(id("dismiss")).setLabel("False positive").setEmoji("❌").setStyle(ButtonStyle.Secondary)
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** Lets a moderator write the right answer; it is stored in the knowledge base. */
export function correctionModal(exchangeId: number, question: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX.correction}:${exchangeId}`)
    .setTitle("Teach the correct answer")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Correct answer")
        .setDescription(truncate(`Question: ${question.replace(/\s+/g, " ")}`, 100))
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(CORRECTION_INPUT_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(5)
            .setMaxLength(2_000)
            .setRequired(true)
        )
    );
}

export function parseLearningCustomId(customId: string): LearningCustomId | null {
  const [prefix, rawId, extra, ...rest] = customId.split(":");
  const id = Number(rawId);
  if (rest.length > 0 || !Number.isSafeInteger(id) || id <= 0) return null;

  if (prefix === CUSTOM_ID_PREFIX.feedback && (extra === "up" || extra === "down")) {
    return { kind: "feedback", exchangeId: id, rating: extra === "up" ? 1 : -1 };
  }
  if (prefix === CUSTOM_ID_PREFIX.correction && extra === undefined) {
    return { kind: "correction", exchangeId: id };
  }
  if (prefix === CUSTOM_ID_PREFIX.review && (extra === "confirm" || extra === "delete" || extra === "dismiss")) {
    return { kind: "review", flagId: id, action: extra };
  }
  return null;
}
