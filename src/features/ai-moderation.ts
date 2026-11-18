import type { Message } from "discord.js";
import { reviewRow } from "../ai/learning/components.js";
import { findModerationExamples, hasModerationExamples, recordFlag } from "../ai/learning/moderation-flags.js";
import { CATEGORY_LABELS, classifyMessage, type ModerationExample, type ModerationVerdict } from "../ai/moderation.js";
import type { AiRuntime } from "../ai/runtime.js";
import { recordUsage } from "../ai/usage.js";
import type { GuildConfig } from "../db/guild-config.js";
import { describeError, logger } from "../logger.js";
import { ConcurrencyLimiter } from "../utils/concurrency.js";
import { truncate } from "../utils/text.js";
import { isNsfwChannel, removeWithNotice } from "./message-actions.js";
import { LogColor, sendLog } from "./server-log.js";

const MIN_CONTENT_LENGTH = 8;
/** At most 2 classifications at once; when 20 are already waiting, new messages are skipped. */
const limiter = new ConcurrencyLimiter(2, 20);

/**
 * Queues an LLM review of a message that passed the rule-based filters.
 * Runs in the background so chat is never slowed down, and fails open:
 * if the model is down or answers garbage, nothing is deleted.
 */
export function scheduleAiModeration(message: Message<true>, config: GuildConfig, runtime: AiRuntime): void {
  if (!config.aiModeration || !runtime.provider) return;

  // Very short or letter-less messages ("ok", "😂", links) are not worth an LLM call.
  const content = message.content.trim();
  if (content.length < MIN_CONTENT_LENGTH || !/\p{L}{2}/u.test(content)) return;

  // Load shedding: when the model cannot keep up, messages are skipped rather than
  // queued without limit (which would delay everything and exhaust memory).
  const accepted = limiter.tryRun(() => reviewMessage(message, content, config, runtime));
  if (!accepted) logger.debug("ai.moderation_skipped_busy", { guildId: message.guildId });
}

/** Similar past moderator decisions for this message (continuous learning from reviews). */
async function learnedExamples(guildId: string, content: string, runtime: AiRuntime): Promise<ModerationExample[]> {
  if (!runtime.settings.learningEnabled || !hasModerationExamples(guildId)) return [];
  return findModerationExamples(guildId, {
    text: content,
    vector: await runtime.embedder?.tryEmbed(content),
    model: runtime.embedder?.id
  }, { minCosine: runtime.settings.ragMinSimilarity + 0.1 });
}

async function reviewMessage(
  message: Message<true>,
  content: string,
  config: GuildConfig,
  runtime: AiRuntime
): Promise<void> {
  const provider = runtime.provider;
  if (!provider) return;

  const started = Date.now();
  let verdict: ModerationVerdict | null;
  let examples: ModerationExample[] = [];
  try {
    // 1. Continuous learning: fetch similar messages that moderators already reviewed.
    examples = await learnedExamples(message.guildId, content, runtime);
    // 2. Classify with structured (JSON-schema) output. NSFW channels get adjusted rules.
    const result = await classifyMessage(provider, content, { nsfwChannel: isNsfwChannel(message.channel), examples });
    verdict = result.verdict;
    recordUsage({
      guildId: message.guildId,
      feature: "moderation",
      provider: result.response.provider,
      model: result.response.model,
      ...result.response.usage,
      latencyMs: Date.now() - started,
      ok: verdict !== null
    });
  } catch (error) {
    recordUsage({
      guildId: message.guildId,
      feature: "moderation",
      provider: provider.id,
      model: provider.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      ok: false
    });
    logger.warn("ai.moderation_failed", { guildId: message.guildId, ...describeError(error) });
    return;
  }

  // 3. Fail open: unreadable output never punishes a member.
  if (!verdict) {
    logger.warn("ai.moderation_unparseable", { guildId: message.guildId });
    return;
  }
  // 4. Act only above the server's confidence threshold (default 80%).
  if (!verdict.flagged || verdict.confidence < config.aiModerationThreshold) return;

  // 5. Default action is "flag for review"; deletion is opt-in. Self-harm is never
  //    auto-deleted: a human should reach out instead.
  const shouldDelete = config.aiModerationAction === "delete" && verdict.category !== "self_harm";
  const deleted = shouldDelete ? await removeWithNotice(message, "Flagged by AI moderation") : false;

  // 6. Store the flag so a moderator's ✅/❌ review can become a learned example.
  const flagId = recordFlag({
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author.id,
    content,
    category: verdict.category,
    confidence: verdict.confidence,
    reason: verdict.reason,
    deleted
  });

  logger.info("ai.moderation_flagged", {
    guildId: message.guildId,
    channelId: message.channelId,
    category: verdict.category,
    confidence: verdict.confidence,
    learnedExamples: examples.length,
    deleted
  });

  await sendLog(message.guild, {
    title: deleted ? "AI moderation · message removed" : "AI moderation · flagged for review",
    color: deleted ? LogColor.danger : LogColor.warning,
    fields: [
      { name: "Author", value: `${message.author} (${message.author.tag})`, inline: true },
      { name: "Channel", value: `${message.channel}`, inline: true },
      { name: "Category", value: CATEGORY_LABELS[verdict.category], inline: true },
      { name: "Confidence", value: `${Math.round(verdict.confidence * 100)}%`, inline: true },
      { name: "Learned from", value: examples.length > 0 ? `${examples.length} past moderator decision(s)` : "No similar decisions yet", inline: true },
      { name: "AI reasoning", value: verdict.reason || "—" },
      { name: "Message", value: truncate(content, 1_000) },
      ...(deleted ? [] : [{ name: "Jump to message", value: message.url }]),
      ...(verdict.category === "self_harm"
        ? [{ name: "Note", value: "Possible self-harm risk: consider reaching out to this member privately." }]
        : [])
    ],
    components: runtime.settings.learningEnabled ? [reviewRow(flagId, deleted)] : []
  });
}
