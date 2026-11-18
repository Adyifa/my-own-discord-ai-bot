import {
  PermissionFlagsBits,
  type ActionRowBuilder,
  type ButtonBuilder,
  type Message
} from "discord.js";
import { describeError, logger } from "../logger.js";
import { Cooldowns } from "../utils/cooldown.js";
import { allowedMentionsFor, splitDiscordMessage, withSubtext } from "../utils/discord-message.js";
import { formatCount } from "../utils/text.js";
import { generateChatReply, rememberChatTurn, replyFootnote, toUserRef, type ChatTurnInput, type ChatTurnResult } from "./chat.js";
import { toAiError, userFacingAiMessage } from "./errors.js";
import { getAiGuildSettings } from "./guild-settings.js";
import { downloadImages, selectImageAttachments } from "./images.js";
import { feedbackRow } from "./learning/components.js";
import { attachExchangeMessage, deleteExchange, recordExchange } from "./learning/exchanges.js";
import type { AiRuntime } from "./runtime.js";

export const MAX_PROMPT_CHARACTERS = 2_000;
const CHAT_COOLDOWN_MS = 8_000;

const cooldowns = new Cooldowns(CHAT_COOLDOWN_MS);
const inFlight = new Set<string>();
const missingChannelWarnings = new Set<string>();

export type ChatSlot = { ok: true; release: () => void } | { ok: false; message: string };
type Components = ActionRowBuilder<ButtonBuilder>[];

/** One AI request per user at a time, plus a short cooldown. Shared by mentions and `/ai ask`. */
export function acquireChatSlot(guildId: string, userId: string): ChatSlot {
  const key = `${guildId}:${userId}`;
  if (inFlight.has(key)) return { ok: false, message: "I'm still working on your previous request — one moment!" };
  const waitMs = cooldowns.acquire(key);
  if (waitMs > 0) {
    return { ok: false, message: `Please wait ${Math.ceil(waitMs / 1_000)}s before sending another AI request.` };
  }
  inFlight.add(key);
  return { ok: true, release: () => void inFlight.delete(key) };
}

/**
 * Logs the answer so members can rate it (👍/👎). Returns the exchange ID used
 * by the feedback buttons, or undefined when learning is switched off.
 */
export function startExchange(runtime: AiRuntime, input: ChatTurnInput, reply: ChatTurnResult): number | undefined {
  if (!runtime.settings.learningEnabled) return undefined;
  try {
    return recordExchange({
      guildId: input.guild.id,
      channelId: input.channel.id,
      userId: input.author.id,
      prompt: input.prompt,
      answer: reply.text,
      provider: reply.provider,
      model: reply.model
    });
  } catch (error) {
    logger.warn("ai.exchange_record_failed", { guildId: input.guild.id, ...describeError(error) });
    return undefined;
  }
}

/** Links the delivered Discord message to its exchange, or drops the exchange if delivery failed. */
export function finishExchange(exchangeId: number | undefined, deliveredMessageId: string | undefined): void {
  if (exchangeId === undefined) return;
  try {
    if (deliveredMessageId) attachExchangeMessage(exchangeId, deliveredMessageId);
    else deleteExchange(exchangeId);
  } catch (error) {
    logger.warn("ai.exchange_update_failed", describeError(error));
  }
}

/** Answers messages in the AI channel, and mentions of the bot elsewhere (if enabled). */
export async function handleAiMessage(message: Message, runtime: AiRuntime): Promise<void> {
  if (!message.inGuild() || message.author.bot || message.system) return;
  const botUser = message.client.user;

  // Gate 1: AI chat is enabled per server, and the bot only answers in its AI channel
  // or when it is mentioned elsewhere (if the admin allowed mentions).
  const settings = getAiGuildSettings(message.guildId);
  if (!settings.enabled) return;
  const mentioned = message.mentions.users.has(botUser.id);
  const inAiChannel = settings.channelId === message.channelId;
  if (!inAiChannel && !(mentioned && settings.mentionEnabled)) return;
  warnIfAiChannelMissing(message, settings.channelId);

  // Gate 2: the prompt is the message without the bot mention; images count as input too.
  const prompt = message.content.replace(new RegExp(`<@!?${botUser.id}>`, "g"), "").trim();
  const imageAttachments = runtime.settings.visionEnabled
    ? selectImageAttachments(message.attachments.values())
    : [];
  if (!prompt && imageAttachments.length === 0) {
    if (mentioned) await safeReply(message, "Hi! Ask me something after the mention, or chat with me in the AI channel.");
    return;
  }
  if (Array.from(prompt).length > MAX_PROMPT_CHARACTERS) {
    await safeReply(message, `That message is too long — please keep it under ${formatCount(MAX_PROMPT_CHARACTERS)} characters.`);
    return;
  }

  const isAdministrator = message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  if (!runtime.provider) {
    await safeReply(message, isAdministrator
      ? `AI chat is enabled, but no model is configured: ${runtime.problems[0] ?? "set AI_PROVIDER in .env"}`
      : "The AI service is unavailable right now.");
    return;
  }

  // Gate 3: one request per member at a time plus a cooldown, so nobody can flood the
  // (possibly local, slow) model.
  const slot = acquireChatSlot(message.guildId, message.author.id);
  if (!slot.ok) {
    await safeReply(message, slot.message);
    return;
  }

  const stopTyping = startTyping(message);
  try {
    const input: ChatTurnInput = {
      guild: message.guild,
      channel: message.channel,
      author: message.author,
      member: message.member,
      prompt,
      images: imageAttachments.length > 0 ? await downloadImages(imageAttachments) : [],
      triggerMessageId: message.id,
      mentionedUsers: [...message.mentions.users.values()]
        .filter(user => user.id !== botUser.id)
        .map(user => toUserRef(user, message.mentions.members?.get(user.id)))
    };

    // The whole AI pipeline (retrieval, prompt, agent, citations) lives in chat.ts.
    const reply = await generateChatReply(runtime, input);
    // Log the exchange first: its ID goes into the 👍/👎 button IDs on the reply.
    const exchangeId = startExchange(runtime, input, reply);
    const delivered = await sendChunks(
      message,
      withSubtext(reply.text, replyFootnote(reply)),
      reply.allowedMentionIds,
      exchangeId === undefined ? [] : [feedbackRow(exchangeId)]
    );
    // If Discord rejected the reply, the exchange is dropped so nobody can rate a ghost answer.
    finishExchange(exchangeId, delivered?.id);
    if (!delivered) return;

    // Memory is saved only after delivery, so the bot never "remembers" an answer nobody saw.
    try {
      rememberChatTurn(runtime, input, reply.text);
    } catch (error) {
      logger.error("ai.memory_save_failed", { guildId: message.guildId, ...describeError(error) });
    }
  } catch (error) {
    const aiError = toAiError(error);
    logger.error("ai.chat_failed", {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      code: aiError.code,
      ...describeError(error)
    });
    await safeReply(message, `${userFacingAiMessage(aiError)}${isAdministrator ? ` (\`${aiError.code}\`)` : ""}`);
  } finally {
    stopTyping();
    slot.release();
  }
}

function startTyping(message: Message<true>): () => void {
  void message.channel.sendTyping().catch(() => undefined);
  const timer = setInterval(() => void message.channel.sendTyping().catch(() => undefined), 8_000);
  return () => clearInterval(timer);
}

/** Sends a long answer in chunks; buttons go on the last chunk. Returns the last message sent. */
async function sendChunks(
  message: Message<true>,
  content: string,
  allowedUserIds: readonly string[],
  components: Components
): Promise<Message | null> {
  const chunks = splitDiscordMessage(content);
  if (chunks.length === 0) return null;

  let last = await safeReply(message, chunks[0], allowedUserIds, chunks.length === 1 ? components : []);
  if (!last) return null;

  for (const [index, chunk] of chunks.slice(1).entries()) {
    try {
      last = await message.channel.send({
        content: chunk,
        allowedMentions: allowedMentionsFor(chunk, allowedUserIds),
        components: index === chunks.length - 2 ? components : []
      });
    } catch (error) {
      logger.warn("ai.discord_send_failed", { guildId: message.guildId, ...describeError(error) });
      return null;
    }
  }
  return last;
}

/** Replies to the message, falling back to a plain channel message if the original was deleted. */
async function safeReply(
  message: Message<true>,
  content: string,
  allowedUserIds: readonly string[] = [],
  components: Components = []
): Promise<Message | null> {
  const options = { content, allowedMentions: allowedMentionsFor(content, allowedUserIds), components };
  try {
    return await message.reply(options);
  } catch {
    try {
      return await message.channel.send(options);
    } catch (error) {
      logger.warn("ai.discord_send_failed", { guildId: message.guildId, ...describeError(error) });
      return null;
    }
  }
}

function warnIfAiChannelMissing(message: Message<true>, channelId: string | null): void {
  if (!channelId || message.guild.channels.cache.has(channelId) || missingChannelWarnings.has(message.guildId)) return;
  missingChannelWarnings.add(message.guildId);
  logger.warn("ai.configured_channel_missing", { guildId: message.guildId, channelId });
}
