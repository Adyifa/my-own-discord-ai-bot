import { describeError, logger } from "../logger.js";
import { parseJsonObject } from "../utils/json.js";
import { isRecord, truncate } from "../utils/text.js";
import {
  MEMORY_LIMITS,
  countMessages,
  getMessagesToCompact,
  getSummary,
  replaceWithSummary,
  type ConversationKey,
  type StoredMessage
} from "./memory.js";
import type { ChatMessage, ChatProvider } from "./providers/index.js";
import { recordUsage } from "./usage.js";
import { addUserFacts } from "./user-memory.js";

const MAX_SUMMARY_CHARACTERS = 1_500;
const MAX_NEW_FACTS = 5;
const inFlight = new Set<string>();

export interface MemoryUpdate {
  summary: string;
  facts: string[];
}

export const MEMORY_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    facts: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "facts"],
  additionalProperties: false
};

export function buildCompactionMessages(
  previousSummary: string | null,
  messages: readonly StoredMessage[]
): ChatMessage[] {
  const transcript = messages
    .map(message => `${message.role === "user" ? "User" : "Assistant"}: ${truncate(message.content, 1_000)}`)
    .join("\n");
  return [
    {
      role: "system",
      content: [
        "You maintain the long-term memory of a Discord chat assistant.",
        "1. summary: merge the previous summary and the new messages into one updated summary of at most 120 words. Keep what matters for future chats (topics, open questions, promises made) and drop small talk.",
        "2. facts: up to 5 short, durable facts about the USER (not the assistant), e.g. their name, preferred language, games they play, projects they work on. Use an empty list if there are none.",
        "Never store sensitive data in facts: health, religion, sexuality, politics, passwords, addresses or phone numbers.",
        "Write in the language the conversation mostly uses.",
        "Respond with JSON only: {\"summary\": string, \"facts\": string[]}"
      ].join("\n")
    },
    {
      role: "user",
      content: `Previous summary:\n${previousSummary ?? "(none)"}\n\nNew messages:\n${transcript}`
    }
  ];
}

/** Accepts the JSON format, or plain text from models that ignore the format (treated as the summary). */
export function parseMemoryUpdate(raw: string): MemoryUpdate | null {
  const data = parseJsonObject(raw);
  if (isRecord(data) && typeof data.summary === "string") {
    const facts = Array.isArray(data.facts)
      ? data.facts.filter((fact): fact is string => typeof fact === "string").map(fact => fact.trim()).filter(Boolean)
      : [];
    return { summary: data.summary.trim(), facts: facts.slice(0, MAX_NEW_FACTS) };
  }
  const text = raw.trim();
  if (!text || text.startsWith("{")) return null;
  return { summary: text, facts: [] };
}

/**
 * Rolling-summary memory: once a conversation grows past the context window,
 * older messages are summarised in the background and replaced by the summary,
 * and durable facts about the user are extracted into their personal memory.
 */
export function scheduleMemoryCompaction(
  provider: ChatProvider,
  key: ConversationKey,
  options: { extractFacts: boolean }
): void {
  const id = `${key.guildId}:${key.channelId}:${key.userId}`;
  if (inFlight.has(id) || countMessages(key) <= MEMORY_LIMITS.compactAbove) return;

  inFlight.add(id);
  compactConversation(provider, key, options)
    .catch(error => logger.warn("ai.memory_compaction_failed", { guildId: key.guildId, ...describeError(error) }))
    .finally(() => inFlight.delete(id));
}

/** Summarises everything except the most recent context window into the rolling summary. */
export async function compactConversation(
  provider: ChatProvider,
  key: ConversationKey,
  options: { extractFacts: boolean } = { extractFacts: true }
): Promise<void> {
  // 1. Everything older than the context window (the newest 12 messages stay verbatim).
  const messages = getMessagesToCompact(key, MEMORY_LIMITS.contextMessages);
  if (messages.length === 0) return;

  const started = Date.now();
  const usageBase = { guildId: key.guildId, feature: "memory" as const };
  let update: MemoryUpdate | null;
  try {
    // 2. One LLM call merges the old summary with the old messages ("rolling" summary)
    //    and extracts durable facts about the user, as JSON.
    const response = await provider.chat({
      messages: buildCompactionMessages(getSummary(key), messages),
      responseFormat: { name: "memory_update", schema: MEMORY_UPDATE_SCHEMA },
      maxOutputTokens: 400,
      temperature: 0.2
    });
    recordUsage({
      ...usageBase,
      provider: response.provider,
      model: response.model,
      ...response.usage,
      latencyMs: Date.now() - started,
      ok: true
    });
    update = parseMemoryUpdate(response.content);
  } catch (error) {
    recordUsage({
      ...usageBase,
      provider: provider.id,
      model: provider.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      ok: false
    });
    throw error;
  }

  if (!update?.summary) return;
  // 3. Atomically store the summary and delete exactly the messages it covers. Messages
  //    that arrived during the LLM call have higher IDs and are kept.
  replaceWithSummary(key, truncate(update.summary, MAX_SUMMARY_CHARACTERS), messages[messages.length - 1].id);
  // 4. Facts go to the member's personal memory (cross-channel, visible in /ai memory view).
  const learnedFacts = options.extractFacts && update.facts.length > 0
    ? addUserFacts(key.guildId, key.userId, update.facts, "auto")
    : 0;
  logger.debug("ai.memory_compacted", { guildId: key.guildId, compactedMessages: messages.length, learnedFacts });
}
